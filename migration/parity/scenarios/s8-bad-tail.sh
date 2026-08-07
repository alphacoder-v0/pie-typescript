#!/usr/bin/env bash
# S8 — a session with a bad tail line: a healthy prefix plus a cut-short last line, where resume and
# continue fail while list still works (B8, reproduced bug for bug)
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
# 1) build a healthy session
PARITY_EXTRA_ENV="OPENAI_API_KEY=dummy-fixture-key" \
  run_pie "$side" "$H" "$out/seed" "printf 'seed session\n'; sleep 3" \
  --tui --provider openai --model gpt-5.2 --base-url "http://127.0.0.1:$PORT/v1"
SES=$(find "$H/.pie/sessions" -name "*.jsonl" 2>/dev/null | head -1)
[ -n "$SES" ] || { echo "no session produced"; exit 1; }
SID=$(basename "$SES" .jsonl)
# 2) cut the tail short: drop the second half of the last line to make it invalid JSON
if [ "${S8_SKIP_CORRUPT:-0}" != "1" ]; then
  total=$(wc -c < "$SES"); keep=$((total - 20))
  head -c "$keep" "$SES" > "$SES.tmp" && mv "$SES.tmp" "$SES"
fi
# 3) resume that id
# Capturing the exit code (fixed in phase 18): this used to be `... || true` followed by
# `echo "resume_exit=$?"`, where $? read the exit code of `true` — **always 0**. That assertion never
# had the ability to fail, and resume.exitcode was not a .norm file, so it took no part in the diff.
# Both are fixed: the code is really captured, and it is included in the comparison. After the B8 fix
# the two sides diverge here **deliberately** — upstream non-zero, TypeScript 0 after salvage — which
# is precisely what should be compared explicitly rather than swallowed by a variable stuck at 0.
bin=$(side_bin "$side")
set +e
timeout 15 env -i HOME="$H" PATH=/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 \
  "$bin" --tui --resume-id "$SID" < /dev/null > "$out/resume.stdout" 2> "$out/resume.stderr"
resume_rc=$?
set -e
echo "resume_exit=$resume_rc" > "$out/resume.exitcode"
# 4) --list-sessions: expected to work
set +e
timeout 15 env -i HOME="$H" PATH=/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 \
  "$bin" --list-sessions < /dev/null > "$out/list.stdout" 2> "$out/list.stderr"
list_rc=$?
set -e
echo "list_exit=$list_rc" > "$out/list.exitcode"
strip_ansi < "$out/resume.stderr" | grep -a . > "$out/resume.errtxt" || true
strip_ansi < "$out/list.stdout" | grep -a . > "$out/list.txt" || true
normalize_into "$out/resume.errtxt" "$out/resumeerr.norm"
normalize_into "$out/list.txt" "$out/list.norm"
normalize_into "$out/resume.exitcode" "$out/resumeexit.norm"
normalize_into "$out/list.exitcode" "$out/listexit.norm"
cleanup_home "$H"
echo "S8 done ($side)"
