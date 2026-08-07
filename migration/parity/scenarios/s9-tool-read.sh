#!/usr/bin/env bash
# S9 — one tool call (read) end to end: the model asks for read, the agent runs it, the result is fed
# back, and the model replies.
#
# Why this scenario is needed: before phase 18 the fixture never emitted a function_call (grepping
# for tool_call found nothing), so the **product's main loop** — model asks for a tool, agent runs it,
# result is fed back, loop continues — had never once run against the real binary across 8 scenarios
# and 14 smoke items. Every real defect known in this repository has been in the **wiring** (pie
# additions with no importer, DS4 unregistered, the system prompt and 25 tool schemas still the
# skeleton's, --version on the wrong stream) — all of them the kind an in-process faux provider
# cannot catch.
#
# The judging surface, all of it entering .norm and taking part in the diff:
#   run.norm       TUI stdout: how the tool call and its result are rendered
#   err.norm       stderr, **captured separately**. A merged stream once hid a diagnostic that went
#                  to the wrong stream.
#   exit.norm      the exit code, really captured through PARITY_RC_FILE rather than the constant 0
#                  left behind by `|| true`.
#   session.norm   the session JSONL, where the toolResult record has to be visible.
#   toolwire.norm  every function_call and function_call_output wire item across both requests,
#                  with complete arguments and output — the tool result the model **actually
#                  received**, not merely how it looked on screen.
#   reqcount.norm  the number of requests: 1 means the tool never ran, 2 is normal, more than 2 means
#                  the loop is spinning. This catches "does not crash but does nothing".
#
# Negative controls (S9_BREAK, off by default):
#   notool  — the script carries no tool step, which is how the fixture behaved before phase 18. This
#             scenario has to go red when the tool does not run.
#   badtool — the tool name is replaced with an unregistered one. This scenario has to go red when
#             tool execution fails.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
WS="$H/ws"; mkdir -p "$WS"
printf 'alpha line\nbeta line\ngamma line\n' > "$WS/notes.txt"

# Tool arguments always use absolute paths, pointing into ws/ under the temporary HOME, and never
# depend on the process cwd — the cwd is this repository and must never be written to.
# normalize.mjs masks $PARITY_HOME_A as <HOME>, so the paths are stable in .norm.
TOOL_NAME=read
case "${S9_BREAK:-}" in
  badtool) TOOL_NAME=read_not_a_registered_tool ;;
esac
if [ "${S9_BREAK:-}" = "notool" ]; then
  printf '[ { "text": "the file mentions alpha, beta and gamma" } ]\n' > "$H/script.json"
else
  cat > "$H/script.json" <<JSON
[ { "tools": [ { "name": "$TOOL_NAME", "arguments": { "path": "$WS/notes.txt" } } ] },
  { "text": "the file mentions alpha, beta and gamma" } ]
JSON
fi

PF="$H/port"; LOGF="$out/requests.ndjson"
FIXTURE_MODE=tools FIXTURE_SCRIPT_FILE="$H/script.json" FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$LOGF" \
  node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$out/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
PORT=$(cat "$PF"); export PARITY_PORT="$PORT"

PARITY_RC_FILE="$out/run.exitcode" PARITY_TIMEOUT=40 \
  PARITY_EXTRA_ENV="OPENAI_API_KEY=dummy-fixture-key" \
  run_pie "$side" "$H" "$out/run" "printf 'read the notes file\n'; sleep 8" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"

SES=$(find "$H/.pie/sessions" -name "*.jsonl" 2>/dev/null | head -1)
if [ -n "$SES" ]; then cp "$SES" "$out/session.jsonl"; else : > "$out/session.jsonl"; fi
bash "$PARITY_ROOT/lib/toolwire.sh" "$LOGF" > "$out/toolwire.txt"
echo "requests=$(wc -l < "$LOGF" | tr -d ' ')" > "$out/reqcount.txt"

strip_ansi < "$out/run.stdout" | grep -a . > "$out/run.txt" || true
strip_ansi < "$out/run.stderr" | grep -a . > "$out/err.txt" || true
normalize_into "$out/run.txt" "$out/run.norm"
normalize_into "$out/err.txt" "$out/err.norm"
normalize_into "$out/run.exitcode" "$out/exit.norm"
normalize_into "$out/session.jsonl" "$out/session.norm"
normalize_into "$out/toolwire.txt" "$out/toolwire.norm"
normalize_into "$out/reqcount.txt" "$out/reqcount.norm"
cleanup_home "$H"
echo "S9 done ($side)"
