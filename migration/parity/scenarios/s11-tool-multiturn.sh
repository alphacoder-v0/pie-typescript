#!/usr/bin/env bash
# S11 — **several sequential tool calls** within one user turn: write, then read, then the final reply.
#
# The two calls really depend on each other: the second read reads exactly the file the first write
# just put on disk. So this scenario judges three things at once:
#   (a) loop iteration — after the first tool result is fed back, the model can issue another call
#   (b) context accumulation — the third request body has to carry both function_call and
#       function_call_output pairs, in the right order and correctly paired, which toolwire.norm
#       compares field by field
#   (c) the on-disk side effect, through file.norm
# reqcount.norm is 3: fewer means the second call never happened, more means the loop is spinning.
#
# Negative controls (S11_BREAK, off by default):
#   notool  — the script carries no tool step: reqcount 1, no file, empty toolwire; has to go red.
#   onecall — only the first write is kept and the second step replies directly: reqcount 2, one pair
#             missing from toolwire; has to go red. This one exists to prove the second call carries
#             discriminating power of its own rather than being masked by the first.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
WS="$H/ws"; mkdir -p "$WS"
TARGET="$WS/report.txt"

case "${S11_BREAK:-}" in
  notool)
    printf '[ { "text": "report written and verified" } ]\n' > "$H/script.json" ;;
  onecall)
    cat > "$H/script.json" <<JSON
[ { "tools": [ { "name": "write", "arguments": {
      "path": "$TARGET", "content": "status: ok\ncount: 42\n" } } ] },
  { "text": "report written and verified" } ]
JSON
    ;;
  *)
    cat > "$H/script.json" <<JSON
[ { "tools": [ { "name": "write", "arguments": {
      "path": "$TARGET", "content": "status: ok\ncount: 42\n" } } ] },
  { "tools": [ { "name": "read", "arguments": { "path": "$TARGET" } } ] },
  { "text": "report written and verified" } ]
JSON
    ;;
esac

PF="$H/port"; LOGF="$out/requests.ndjson"
FIXTURE_MODE=tools FIXTURE_SCRIPT_FILE="$H/script.json" FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$LOGF" \
  node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$out/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
PORT=$(cat "$PF"); export PARITY_PORT="$PORT"

PARITY_RC_FILE="$out/run.exitcode" PARITY_TIMEOUT=45 \
  PARITY_EXTRA_ENV="OPENAI_API_KEY=dummy-fixture-key" \
  run_pie "$side" "$H" "$out/run" "printf 'write the report then read it back\n'; sleep 10" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"

if [ -f "$TARGET" ]; then cp "$TARGET" "$out/file.after"; else echo "<TARGET-MISSING>" > "$out/file.after"; fi

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
normalize_into "$out/file.after" "$out/file.norm"
cleanup_home "$H"
echo "S11 done ($side)"
