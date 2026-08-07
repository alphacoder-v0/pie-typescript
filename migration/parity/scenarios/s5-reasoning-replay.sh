#!/usr/bin/env bash
# S5 — DS4 reasoning replay: the fixture emits a reasoning item, and the second request has to replay
# it according to compat
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
PF="$H/port"; LOGF="$out/requests.ndjson"
FIXTURE_MODE=reasoning FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$LOGF" \
  node "$PARITY_ROOT/lib/sse-fixture-server.mjs" > "$out/server.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
PORT=$(cat "$PF"); export PARITY_PORT="$PORT"
PARITY_EXTRA_ENV="DS4_API_KEY=dummy-fixture-key DS4_BASE_URL=http://127.0.0.1:$PORT/v1" PARITY_TIMEOUT=40 \
  run_pie "$side" "$H" "$out/run" "printf 'first turn\n'; sleep 4; printf 'second turn\n'; sleep 4" \
  --tui --provider ds4 --model deepseek-v4-flash --thinking low
# Judging surface: the role and type shape of the second request's input sequence, where the replayed
# reasoning item should appear, plus the second request body in full
jq -c 'select(.n==2) | {n, seq: [.body.input[]? | {role: (.role // null), type: (.type // null)}]}' "$LOGF" > "$out/replay.txt" 2>/dev/null || : > "$out/replay.txt"
jq -c 'select(.n==2) | .body' "$LOGF" > "$out/req2body.json" 2>/dev/null || : > "$out/req2body.json"
normalize_into "$out/replay.txt" "$out/replay.norm"
normalize_into "$out/req2body.json" "$out/req2body.norm"
cleanup_home "$H"
echo "S5 done ($side)"
