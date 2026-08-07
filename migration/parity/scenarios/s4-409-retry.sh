#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
PF="$H/port"; LOGF="$out/requests.ndjson"
FIXTURE_MODE=http409-once FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$LOGF" \
  node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$out/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
PORT=$(cat "$PF"); export PARITY_PORT="$PORT"
PARITY_EXTRA_ENV="OPENAI_API_KEY=dummy-fixture-key" PARITY_TIMEOUT=40 \
  run_pie "$side" "$H" "$out/run" "printf 'hello retry\n'; sleep 8" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"
jq -c '{n, path, auth}' "$LOGF" > "$out/reqseq.txt" 2>/dev/null || cp "$LOGF" "$out/reqseq.txt"
strip_ansi < "$out/run.stdout" | grep -a "fixture says hi" > "$out/final.txt" || : > "$out/final.txt"
normalize_into "$out/reqseq.txt" "$out/reqseq.norm"; normalize_into "$out/final.txt" "$out/final.norm"
cleanup_home "$H"
echo "S4 done ($side)"
