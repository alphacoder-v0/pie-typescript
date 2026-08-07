#!/usr/bin/env bash
# S6 — the session JSONL structure of a scripted session: fixture-driven, two turns, and no bash tool
# authorisation refusal path involved, so text-only turns
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
PF="$H/port"; LOGF="$out/requests.ndjson"
FIXTURE_MODE=usage FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$LOGF" \
  node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$out/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
PORT=$(cat "$PF"); export PARITY_PORT="$PORT"
PARITY_EXTRA_ENV="OPENAI_API_KEY=dummy-fixture-key" PARITY_TIMEOUT=45 \
  run_pie "$side" "$H" "$out/run" "printf 'turn one\n'; sleep 3; printf 'turn two\n'; sleep 3" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"
SES=$(find "$H/.pie/sessions" -name "*.jsonl" 2>/dev/null | head -1)
if [ -n "$SES" ]; then cp "$SES" "$out/session.jsonl"; else : > "$out/session.jsonl"; fi
normalize_into "$out/session.jsonl" "$out/session.norm"
# The directory structure, in relative shape
( cd "$H/.pie" 2>/dev/null && find . -type d | sort ) > "$out/dirs.txt" || : > "$out/dirs.txt"
normalize_into "$out/dirs.txt" "$out/dirs.norm"
cleanup_home "$H"
echo "S6 done ($side)"
