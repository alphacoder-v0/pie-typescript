#!/usr/bin/env bash
# common.sh — the shared library for parity scenarios, sourced by each of them.
set -euo pipefail
PARITY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PARITY_ROOT/../.." && pwd)"
set -a; source "$REPO_ROOT/migration/sources.env"; set +a
ORACLE_DIR=$(eval echo "$ORACLE_PIE_DIR")
ORACLE_BIN="$ORACLE_DIR/target/release/pie"
TS_BIN="$REPO_ROOT/pie"   # the TypeScript launcher, produced in phase 13

side_bin() {  # $1 = oracle|ts
  case "$1" in
    oracle) echo "$ORACLE_BIN" ;;
    ts) echo "$TS_BIN" ;;
    *) echo "unknown side: $1" >&2; return 1 ;;
  esac
}
ts_ready() { [ -x "$TS_BIN" ]; }

mkhome() { mktemp -d "${TMPDIR:-/tmp}/parityhome.XXXXXX"; }

# run_pie <side> <home> <outprefix> <stdin-script, passed as one printf-format argument> — anything
# further is passed through to pie
#
# Exit codes (phase 19; additive, existing behavior unchanged): the function still swallows the
# child's status and returns 0, which S1 through S8 rely on because they call it bare under `set -e`.
# But if the caller exports PARITY_RC_FILE, the real exit code is written there as `exit=<int>` —
# the same shape as s8's existing `resume_exit=` and `list_exit=`, so it can be normalised straight
# into .norm and take part in the diff. It cannot be read with $? or PIPESTATUS outside the function:
# the trailing `|| true` resets both.
run_pie() {
  local side="$1" home="$2" out="$3" feed="$4"; shift 4
  local bin; bin=$(side_bin "$side")
  local rc=0
  ( bash -c "$feed" ; sleep "${PARITY_SETTLE:-4}" ) | \
    timeout "${PARITY_TIMEOUT:-25}" env -i HOME="$home" PATH=/usr/bin:/bin:/usr/local/bin \
      TERM=xterm-256color LANG=C.UTF-8 ${PARITY_EXTRA_ENV:-} \
      "$bin" "$@" > "$out.stdout" 2> "$out.stderr" || rc=$?
  if [ -n "${PARITY_RC_FILE:-}" ]; then echo "exit=$rc" > "$PARITY_RC_FILE"; fi
  return 0
}

strip_ansi() { sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g'; }

normalize_into() { # $1=srcfile $2=dstfile; PARITY_HOME_A is exported by the caller
  node "$PARITY_ROOT/lib/normalize.mjs" < "$1" > "$2"
}

cleanup_home() {  # removes only a temporary HOME this harness created, checked by the parityhome.* prefix
  case "$1" in
    */parityhome.*)
      find "$1" -mindepth 1 -delete 2>/dev/null || true
      rmdir "$1" 2>/dev/null || true
      ;;
    *) echo "refuse to remove non-parity home: $1" >&2; return 1 ;;
  esac
}
