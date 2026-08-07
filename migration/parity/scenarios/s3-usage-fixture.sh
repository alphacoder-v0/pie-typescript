#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
PF="$H/port"; LOGF="$out/requests.ndjson"
FIXTURE_MODE="${S3_MODE:-usage}" FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$LOGF" \
  node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$out/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
PORT=$(cat "$PF"); export PARITY_PORT="$PORT"
PARITY_EXTRA_ENV="OPENAI_API_KEY=dummy-fixture-key" \
  run_pie "$side" "$H" "$out/run" "printf 'hello fixture\n'; sleep 3; printf '/cost\n'; sleep 2" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"
SES=$(find "$H/.pie/sessions" -name "*.jsonl" 2>/dev/null | head -1)
if [ -n "$SES" ]; then cp "$SES" "$out/session.jsonl"; else : > "$out/session.jsonl"; fi
normalize_into "$out/session.jsonl" "$out/session.norm"
strip_ansi < "$out/run.stdout" | grep -a . > "$out/run.txt"; normalize_into "$out/run.txt" "$out/run.norm"
normalize_into "$LOGF" "$out/requests.norm" 2>/dev/null || : > "$out/requests.norm"
cleanup_home "$H"
echo "S3 done ($side)"
