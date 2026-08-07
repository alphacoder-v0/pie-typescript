#!/usr/bin/env bash
# S10 — a tool really changed the bytes on disk.
#
# S9 only proves the tool ran; this scenario proves **the binary can do work**: the model sends one
# edit, the agent runs it, and the file on disk really changes. file.norm normalises the edited file
# itself into the diff — looking at the bytes rather than at the word "written" on screen. This is
# the minimum evidence that it can do anything at all.
#
# Judging surface: run, err, exit, session, toolwire and reqcount as in S9, plus file.norm — **the
# contents of the file on disk**.
#
# Negative controls (S10_BREAK, off by default):
#   notool  — the script carries no tool step: the file keeps its seeded content and file.norm has to
#             go red.
#   badtool — the tool name is not registered: edit never runs, the file keeps its seeded content,
#             and file.norm has to go red.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
WS="$H/ws"; mkdir -p "$WS"
TARGET="$WS/config.txt"
printf 'mode = draft\nowner = nobody\nretries = 1\n' > "$TARGET"

TOOL_NAME=edit
case "${S10_BREAK:-}" in
  badtool) TOOL_NAME=edit_not_a_registered_tool ;;
esac
if [ "${S10_BREAK:-}" = "notool" ]; then
  printf '[ { "text": "config updated to published" } ]\n' > "$H/script.json"
else
  cat > "$H/script.json" <<JSON
[ { "tools": [ { "name": "$TOOL_NAME", "arguments": {
      "path": "$TARGET", "old_string": "mode = draft", "new_string": "mode = published" } } ] },
  { "text": "config updated to published" } ]
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
  run_pie "$side" "$H" "$out/run" "printf 'switch the config to published\n'; sleep 8" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"

# The bytes on disk, which have to be read before cleanup_home. When the file does not exist, leave
# an explicit marker rather than an empty file: an empty file and "nothing was written" look the same
# in a diff, which would be one more assertion that cannot fail.
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
echo "S10 done ($side)"
