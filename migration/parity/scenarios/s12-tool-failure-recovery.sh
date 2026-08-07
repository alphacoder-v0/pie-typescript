#!/usr/bin/env bash
# S12 — recovering after a tool fails: the first read hits a path that does not exist, so the tool
# raises. The error has to be **fed back to the model**, the loop must neither crash nor spin, and the
# second read finds a real file so the turn ends normally.
#
# S4 judges a transport failure over HTTP, where the provider answers 409; this judges a **tool
# execution failure** — an entirely different error channel. An agent that swallows tool errors is
# green across S1 through S8.
#
# Judging surface, as in S9, plus:
#   iserror.norm  the isError flag on the session's toolResult, which **has to be true**. Looking at
#                 the output text alone is not enough: either side could put the error text into
#                 output and forget the flag, which is the half of the failure the model can see and
#                 the product logic — retry, billing, rendering — cannot.
#   reqcount=3    fewer means it did not continue after the failure, having swallowed it or crashed;
#                 more means it is spinning.
#   exit.norm     the turn has to exit normally rather than be killed by the timeout.
#
# Negative controls (S12_BREAK, off by default):
#   notool    — no tool step: reqcount 1, empty toolwire, empty iserror; has to go red.
#   nofailure — the first call is changed to read a file that **does** exist, so nothing fails:
#               iserror.norm flips and it has to go red. This one exists to prove that feeding the
#               failure back carries discriminating power of its own.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
WS="$H/ws"; mkdir -p "$WS"
printf 'recovered content line\n' > "$WS/present.txt"
FIRST="$WS/definitely-absent.txt"
[ "${S12_BREAK:-}" = "nofailure" ] && FIRST="$WS/present.txt"

if [ "${S12_BREAK:-}" = "notool" ]; then
  printf '[ { "text": "recovered after the missing file" } ]\n' > "$H/script.json"
else
  cat > "$H/script.json" <<JSON
[ { "tools": [ { "name": "read", "arguments": { "path": "$FIRST" } } ] },
  { "tools": [ { "name": "read", "arguments": { "path": "$WS/present.txt" } } ] },
  { "text": "recovered after the missing file" } ]
JSON
fi

PF="$H/port"; LOGF="$out/requests.ndjson"
FIXTURE_MODE=tools FIXTURE_SCRIPT_FILE="$H/script.json" FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$LOGF" \
  node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$out/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
PORT=$(cat "$PF"); export PARITY_PORT="$PORT"

PARITY_RC_FILE="$out/run.exitcode" PARITY_TIMEOUT=45 \
  PARITY_EXTRA_ENV="OPENAI_API_KEY=dummy-fixture-key" \
  run_pie "$side" "$H" "$out/run" "printf 'read the missing file then recover\n'; sleep 10" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"

SES=$(find "$H/.pie/sessions" -name "*.jsonl" 2>/dev/null | head -1)
if [ -n "$SES" ]; then cp "$SES" "$out/session.jsonl"; else : > "$out/session.jsonl"; fi
bash "$PARITY_ROOT/lib/toolwire.sh" "$LOGF" > "$out/toolwire.txt"
echo "requests=$(wc -l < "$LOGF" | tr -d ' ')" > "$out/reqcount.txt"
# The sequence of error flags on the toolResults. With no toolResult, leave an explicit marker rather
# than an empty file: an empty file cannot be told apart from "the session holds no tool result at
# all" in a diff.
jq -c 'select(.message.role=="toolResult") | {toolName: .message.toolName, isError: .message.isError}' \
  "$out/session.jsonl" > "$out/iserror.txt" 2>/dev/null || : > "$out/iserror.txt"
[ -s "$out/iserror.txt" ] || echo "<NO-TOOL-RESULT-IN-SESSION>" > "$out/iserror.txt"

strip_ansi < "$out/run.stdout" | grep -a . > "$out/run.txt" || true
strip_ansi < "$out/run.stderr" | grep -a . > "$out/err.txt" || true
normalize_into "$out/run.txt" "$out/run.norm"
normalize_into "$out/err.txt" "$out/err.norm"
normalize_into "$out/run.exitcode" "$out/exit.norm"
normalize_into "$out/session.jsonl" "$out/session.norm"
normalize_into "$out/toolwire.txt" "$out/toolwire.norm"
normalize_into "$out/reqcount.txt" "$out/reqcount.norm"
normalize_into "$out/iserror.txt" "$out/iserror.norm"
cleanup_home "$H"
echo "S12 done ($side)"
