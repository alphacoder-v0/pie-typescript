#!/usr/bin/env bash
# run-smoke.sh — phase 16 (the kit's Step 5: cheap end-to-end proof before expensive full reconciliation)
#
# How this divides with parity:
#   parity/run-parity.sh does the **byte-for-byte behavioral diff**, which is expensive and strict.
#   This script asks **whether it runs at all**: start up, take a turn, write to disk, exit cleanly,
#   and leave no process behind.
#   Parity does not check that last one at all: a leaked child process or a hung TUI happens just as
#   readily with diff=0.
#
# Every item runs side by side with upstream. The output is migration/smoke/report.md.
set -uo pipefail   # -e is deliberately absent: one failing item has to be recorded and the run continue
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
source migration/parity/lib/common.sh
# common.sh carries its own `set -euo pipefail`, and sourcing it brings -e in, overriding the line above.
# This script deliberately does not want -e: a failing item has to be recorded and the run has to
# finish, or the report would hold only its first few lines and read as "it ran and mostly tested
# nothing". It is turned off again after the source.
set +e

OUT="$REPO_ROOT/migration/smoke/out"
REPORT="$REPO_ROOT/migration/smoke/report.md"
rm -rf "$OUT"; mkdir -p "$OUT"
: > "$REPORT"

pass=0; fail=0
CURRENT="init"; SIDE="-"
note() { printf '%s\n' "$*" >> "$REPORT"; }
ok()   { pass=$((pass+1)); echo "  PASS  $*"; note "| $CURRENT | $SIDE | PASS | $* |"; }
bad()  { fail=$((fail+1)); echo "  FAIL  $*"; note "| $CURRENT | $SIDE | **FAIL** | $* |"; }

# Count the child processes one side left behind, identified by its binary path.
leaked() { pgrep -f -- "$1" 2>/dev/null | wc -l; }

note "# Phase 16 smoke report"
note ""
note "Produced by \`migration/smoke/run-smoke.sh\`. Every item runs side by side with upstream."
note ""
note "How this divides with parity: parity does the byte-for-byte behavioral diff, while this report asks"
note "**whether it runs at all** — start up, take a turn, write to disk, exit cleanly, and **leave no process behind**. Parity does not check that last one at all."
note ""
note "| # | side | result | note |"
note "|---|---|---|---|"

for SIDE in oracle ts; do
  BIN="$(side_bin "$SIDE")"
  echo "=== side: $SIDE ($BIN) ==="
  if [ "$SIDE" = "ts" ] && ! ts_ready; then
    CURRENT="(all)"; bad "the TypeScript side is not ready: $TS_BIN does not exist or is not executable"
    continue
  fi
  if [ "$SIDE" = "oracle" ] && [ ! -x "$BIN" ]; then
    CURRENT="(all)"; bad "the upstream binary does not exist: $BIN (run migration/parity/build-oracle.sh first)"
    continue
  fi

  # ── 1) --help exits 0, and the catalog counts ─────────────────────────────
  CURRENT="1 --help"
  H=$(mkhome)
  env -i HOME="$H" PATH=/usr/bin:/bin:/usr/local/bin TERM=xterm-256color LANG=C.UTF-8 \
    "$BIN" --help > "$OUT/$SIDE-help.txt" 2>&1
  hc=$?
  if [ "$hc" -eq 0 ]; then ok "exit 0"; else bad "exit $hc"; fi
  cat_line=$(grep -oE 'providers \([0-9]+\), models \([0-9]+\)' "$OUT/$SIDE-help.txt" 2>/dev/null | head -1)
  if [ -n "$cat_line" ]; then ok "the catalog count line is present: $cat_line"; else bad "the catalog count line is missing"; fi
  cleanup_home "$H"

  # ── 2) the TUI starts and exits cleanly in an empty environment, leaving nothing behind ──
  CURRENT="2 the TUI in an empty environment"
  before=$(leaked "$BIN")
  H=$(mkhome)
  ( printf 'hello\n'; sleep 2 ) | timeout 20 env -i HOME="$H" \
      PATH=/usr/bin:/bin:/usr/local/bin TERM=xterm-256color LANG=C.UTF-8 \
      "$BIN" --tui > "$OUT/$SIDE-tui.out" 2>&1
  tc=$?
  # 124 means timeout ended it, which is reasonable for a TUI waiting on input; any other non-zero is
  # an abnormal exit
  if [ "$tc" -eq 0 ] || [ "$tc" -eq 124 ]; then ok "exit code $tc (0 or 124 are both acceptable)"; else bad "abnormal exit code $tc"; fi
  sleep 1
  after=$(leaked "$BIN")
  if [ "$after" -le "$before" ]; then ok "no process left behind ($before before, $after after)"; else bad "processes left behind: $before before, $after after"; fi
  cleanup_home "$H"

  # ── 3) one turn against the SSE fixture: prompt, then a session on disk ───
  CURRENT="3 one turn against the fixture"
  H=$(mkhome); export PARITY_HOME_A="$H"
  PF="$H/port"
  FIXTURE_MODE=usage FIXTURE_PORT_FILE="$PF" FIXTURE_LOG="$OUT/$SIDE-req.ndjson" \
    node "$REPO_ROOT/migration/parity/lib/sse-fixture-server.mjs" > "$OUT/$SIDE-fixture.log" 2>&1 &
  FSRV=$!
  for _ in $(seq 50); do [ -s "$PF" ] && break; sleep 0.1; done
  PORT=$(cat "$PF" 2>/dev/null || true)
  if [ -z "$PORT" ]; then
    bad "the fixture server did not start"
  else
    ( printf 'say hi\n'; sleep 4 ) | timeout 30 env -i HOME="$H" \
        PATH=/usr/bin:/bin:/usr/local/bin TERM=xterm-256color LANG=C.UTF-8 \
        OPENAI_API_KEY=dummy-fixture-key \
        "$BIN" --tui --provider openai --model gpt-5.2 \
        --base-url "http://127.0.0.1:$PORT/v1" > "$OUT/$SIDE-turn.out" 2>&1
    reqs=$(wc -l < "$OUT/$SIDE-req.ndjson" 2>/dev/null || echo 0)
    if [ "$reqs" -ge 1 ]; then ok "the fixture received $reqs request(s), so the model really was called"; else bad "the fixture received no request, so no real call happened"; fi
    sfile=$(find "$H/.pie/sessions" -name '*.jsonl' 2>/dev/null | head -1)
    if [ -n "$sfile" ]; then
      lines=$(wc -l < "$sfile" 2>/dev/null || echo 0)
      ok "the session reached disk ($lines lines)"
    else
      bad "no session file reached disk"
    fi
  fi
  kill "$FSRV" 2>/dev/null
  cleanup_home "$H"

  # ── 4) --tui forces the terminal and does not open the web UI ─────────────
  CURRENT="4 --tui forces the terminal"
  if grep -qiE 'listening on http|web ui|webui' "$OUT/$SIDE-tui.out" 2>/dev/null; then
    bad "signs of the web UI starting are still present under --tui"
  else
    ok "--tui did not start the web UI"
  fi
done

note ""
note "**Total: PASS $pass / FAIL $fail**"
note ""
note "## Notes"
note ""
note "- The exit code 124 in item 2 is \`timeout\` ending it, which is the normal result for a TUI waiting on input;"
note "  what is actually asserted is **whether it left a child process behind once it was ended**."
note "- Item 3 uses \`migration/parity/lib/sse-fixture-server.mjs\`, which reaches no real network and uses no real credential"
note "  (\`OPENAI_API_KEY=dummy-fixture-key\` is a literal)."
note "- The session is written into the temporary HOME \`mkhome\` creates (prefixed \`parityhome.*\`, removed by \`cleanup_home\` after a strict check),"
note "  and **the real \`~/.pie\` is never touched**."
note "- This report does no byte-for-byte comparison; that is \`migration/parity/run-parity.sh\`'s job."

echo
echo "SMOKE: PASS=$pass FAIL=$fail"
echo "report: $REPORT"
[ "$fail" -eq 0 ]
