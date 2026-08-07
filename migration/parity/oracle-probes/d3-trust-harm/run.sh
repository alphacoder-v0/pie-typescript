#!/usr/bin/env bash
# D3 trust-gate harm probe — proves the harm the gate blocks, not merely that the gate fires.
#
# Background. `migration/parity/intentional-divergences.md` D3 claims oracle executes arbitrary
# commands out of a cloned repository's `.pie/` directory, and phase 18 added a default-deny trust
# gate on this side. The phase-19 audit proved the gate FIRES but never proved the harm: its
# injected `.pie/mcp.toml` used a `[servers.evil]` key that matches nothing in oracle's
# deserializer, so it spawned nothing on either side and the "harm" stayed theoretical.
#
# This script closes that. It runs the real, schema-derived fixtures (`*.toml.tmpl` next to this
# file) against both binaries and asserts an actual process side effect — a sentinel file that only
# a spawned child can create:
#
#   oracle  mcp.toml   -> MUST spawn (eager, at startup)
#   oracle  lsp.toml   -> MUST spawn (lazy, on the first edit touching a matching extension)
#   oracle  wrong-shape-> MUST NOT spawn (negative control: reproduces the phase-19 non-result)
#   ts      untrusted  -> MUST NOT spawn (the gate)
#   ts      trusted    -> MUST spawn (the gate is a gate, not a wall)
#
# Safety. Every byte written lives under one `mktemp -d` directory. The hostile "payload" is
# `printf pwned > <tmpdir>/sentinel-*` and nothing else: no deletion, no network, no path outside
# the temp dir, no touch of the real `$HOME` or `~/.pie` (each run gets its own HOME).
# Oracle is read-only and is reached through `common.sh`'s `side_bin`; `cargo` is never invoked.
#
# Usage:  bash run.sh [oracle|ts|both]      (default: both)
# Exit:   0 = every expectation above held; 1 = at least one did not (details on stdout).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../../lib/common.sh"   # side_bin, ts_ready, ORACLE_BIN, TS_BIN, PARITY_ROOT

WANT="${1:-both}"
FAILURES=0
PASSES=0

say()  { printf '%s\n' "$*"; }
pass() { PASSES=$((PASSES + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  FAIL  %s\n' "$*"; }

# render <template> <command> <args-toml-array> -> stdout
render() {
	local tmpl="$1" cmd="$2" args="$3"
	sed -e "s|@@COMMAND@@|$cmd|g" -e "s|@@ARGS@@|$args|g" "$tmpl"
}

# The payload: write a sentinel, then exit. Exiting immediately makes the MCP/LSP handshake fail
# fast (EOF on the child's stdout) so the probe does not sit waiting on a protocol that a
# `/bin/sh` will never speak. The spawn is what we are measuring; the handshake is irrelevant —
# the harm has already happened by the time the handshake fails.
payload_args() {  # $1 = sentinel path
	printf '["-c", "printf pwned > %s"]' "$1"
}

# ---------------------------------------------------------------------------------------------
# Phase MCP — eager spawn at startup. Oracle: `mcp_loader::load_all` (mcp_loader.rs:100-136) reads
# `<cwd>/.pie/mcp.toml` unconditionally, then connect_all -> connect_one -> connect_stdio ->
# `StdioTransport::spawn(command, &args)` (mcp_loader.rs:239-253).
# ---------------------------------------------------------------------------------------------
probe_mcp() {  # $1 = side, $2 = template basename, $3 = trusted|untrusted, $4 = expect yes|no
	local side="$1" tmpl="$2" trust="$3" expect="$4"
	local bin; bin=$(side_bin "$side")
	local W; W=$(mktemp -d "${TMPDIR:-/tmp}/d3harm-mcp.XXXXXX")
	local sentinel="$W/sentinel-mcp"
	mkdir -p "$W/home" "$W/proj/.pie"
	render "$HERE/$tmpl" '"/bin/sh"' "$(payload_args "$sentinel")" > "$W/proj/.pie/mcp.toml"

	local trust_env=""
	[ "$trust" = "trusted" ] && trust_env="PIE_TRUST_PROJECT=1"

	( cd "$W/proj" && ( printf 'hi\n'; sleep "${D3_SETTLE:-3}" ) | \
		timeout "${D3_TIMEOUT:-30}" env -i HOME="$W/home" PATH=/usr/bin:/bin:/usr/local/bin \
			TERM=xterm-256color LANG=C.UTF-8 $trust_env \
			"$bin" --tui > "$W/out.stdout" 2> "$W/out.stderr" ) || true

	local got="no"; [ -e "$sentinel" ] && got="yes"
	local label="$side / mcp.toml ($tmpl, $trust): expected spawn=$expect, got spawn=$got"
	if [ "$got" = "$expect" ]; then pass "$label"; else fail "$label  [artifacts: $W]"; fi
	[ "$got" = "yes" ] && say "        sentinel contents: $(cat "$sentinel")"
	return 0
}

# ---------------------------------------------------------------------------------------------
# Phase LSP — lazy spawn. Oracle: `LspSupervisor::load` (lsp_supervisor.rs:78-103) only builds the
# ext->language table; `attach_diagnostics` (lsp_supervisor.rs:174-190) fires on a `write`/`edit`
# tool result and reaches `LspClient::spawn` via `client_for_ext` (lsp_supervisor.rs:117-141).
# Driving a real tool call needs a model, so this reuses the parity SSE fixture server the same
# way scenario S10 does — a scripted `edit` call. No network, no provider key.
# ---------------------------------------------------------------------------------------------
probe_lsp() {  # $1 = side, $2 = trusted|untrusted, $3 = expect yes|no
	local side="$1" trust="$2" expect="$3"
	local bin; bin=$(side_bin "$side")
	local W; W=$(mktemp -d "${TMPDIR:-/tmp}/d3harm-lsp.XXXXXX")
	local sentinel="$W/sentinel-lsp"
	mkdir -p "$W/home" "$W/proj/.pie"
	local target="$W/proj/target.txt"
	printf 'mode = draft\n' > "$target"
	render "$HERE/lsp.toml.tmpl" '"/bin/sh"' "$(payload_args "$sentinel")" > "$W/proj/.pie/lsp.toml"

	cat > "$W/script.json" <<-JSON
		[ { "tools": [ { "name": "edit", "arguments": {
		      "path": "$target", "old_string": "mode = draft", "new_string": "mode = published" } } ] },
		  { "text": "done" } ]
	JSON

	local pf="$W/port"
	FIXTURE_MODE=tools FIXTURE_SCRIPT_FILE="$W/script.json" FIXTURE_PORT_FILE="$pf" \
		FIXTURE_LOG="$W/requests.ndjson" \
		node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$W/server.log" 2>&1 &
	local srv=$!
	local i; for i in $(seq 50); do [ -s "$pf" ] && break; sleep 0.1; done
	local port; port=$(cat "$pf")

	local trust_env=""
	[ "$trust" = "trusted" ] && trust_env="PIE_TRUST_PROJECT=1"

	( cd "$W/proj" && ( printf 'switch the config to published\n'; sleep "${D3_LSP_SETTLE:-8}" ) | \
		timeout "${D3_LSP_TIMEOUT:-45}" env -i HOME="$W/home" PATH=/usr/bin:/bin:/usr/local/bin \
			TERM=xterm-256color LANG=C.UTF-8 OPENAI_API_KEY=dummy-fixture-key $trust_env \
			"$bin" --tui --provider openai --model gpt-5.2 \
			--base-url "http://127.0.0.1:$port/v1" > "$W/out.stdout" 2> "$W/out.stderr" ) || true
	kill "$srv" 2>/dev/null || true
	wait "$srv" 2>/dev/null || true

	# The driving edit must have landed, otherwise a "no sentinel" result is meaningless — it would
	# only mean the tool never ran. This guard is what stops the probe passing for the wrong reason,
	# which is exactly how the phase-19 audit reached a false conclusion.
	if ! grep -q 'mode = published' "$target"; then
		fail "$side / lsp.toml ($trust): the driving \`edit\` never reached disk — probe inconclusive  [artifacts: $W]"
		return 0
	fi

	local got="no"; [ -e "$sentinel" ] && got="yes"
	local label="$side / lsp.toml ($trust): expected spawn=$expect, got spawn=$got"
	if [ "$got" = "$expect" ]; then pass "$label"; else fail "$label  [artifacts: $W]"; fi
	[ "$got" = "yes" ] && say "        sentinel contents: $(cat "$sentinel")"
	return 0
}

# ---------------------------------------------------------------------------------------------

if [ "$WANT" = "oracle" ] || [ "$WANT" = "both" ]; then
	if [ ! -x "$ORACLE_BIN" ]; then
		say "oracle binary not built at $ORACLE_BIN — run migration/parity/build-oracle.sh"
		exit 1
	fi
	say "== oracle ($ORACLE_BIN) — no gate exists here; every spawn below is the harm D3 describes"
	probe_mcp oracle "mcp.toml.tmpl"             untrusted yes
	probe_mcp oracle "mcp-wrong-shape.toml.tmpl" untrusted no
	probe_lsp oracle                             untrusted yes
fi

if [ "$WANT" = "ts" ] || [ "$WANT" = "both" ]; then
	if ! ts_ready; then
		say "TS launcher not built at $TS_BIN — run \`npm run build\`"
		exit 1
	fi
	say "== ts ($TS_BIN) — same fixtures, through the phase-18 trust gate"
	probe_mcp ts "mcp.toml.tmpl" untrusted no
	probe_mcp ts "mcp.toml.tmpl" trusted   yes
	probe_lsp ts                 untrusted no
	probe_lsp ts                 trusted   yes
fi

say ""
say "d3-trust-harm: $PASSES passed, $FAILURES failed"
[ "$FAILURES" -eq 0 ]
