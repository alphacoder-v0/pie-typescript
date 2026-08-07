#!/usr/bin/env bash
# run-parity.sh — parity judge 入口
# 用法:
#   run-parity.sh --oracle-only [--scenarios S1,S3]   仅跑 oracle 侧（产出 out/oracle/）
#   run-parity.sh --self-check                        judge 自验证（oracle 自差分=0 + 3 处行为突变检出）
#   run-parity.sh --ts [--scenarios ...]              仅跑 TS 侧；TS 未就绪则 "TS side not ready" exit 2
#   run-parity.sh [--scenarios ...]                   双侧跑 + 差分（默认全场景）
set -euo pipefail
cd "$(dirname "$0")"
source lib/common.sh

# 互斥锁（phase 19 新增）。每个场景开头都做 `find "$out" -mindepth 1 -delete`，所以两个并发的
# parity 运行会互相删掉对方正在写的产物，差分阶段随即报出**假的** "MISSING on B side"。
# 这在本轮真实发生过：多个 agent 同时跑 parity，一个 agent 因此报了并不存在的回归。
# 静默污染判定结果，比拒绝运行糟得多——所以这里选择响亮地拒绝。
# `mkdir` 在 POSIX 上是原子的，故用它而非 `[ -e ]` 判断。
LOCK_DIR="out/.lock"
if ! mkdir -p out 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="(unknown)"; [ -f "$LOCK_DIR/pid" ] && holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "(unknown)")
  echo "REFUSING: another parity run holds $LOCK_DIR (pid $holder)." >&2
  echo "  并发运行会互删 out/ 下的产物并制造假的 MISSING/DIFF。等它结束，或若确认是残留锁则删除该目录。" >&2
  exit 3
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

ALL="S1 S2 S3 S4 S5 S6 S7 S8 S9 S10 S11 S12"
MODE="both"; SCN="$ALL"
while [ $# -gt 0 ]; do
  case "$1" in
    --oracle-only) MODE=oracle ;;
    --ts) MODE=ts ;;
    --self-check) MODE=selfcheck ;;
    --scenarios) shift; SCN=$(echo "$1" | tr ',' ' ') ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac; shift
done

scenario_script() {
  case "$1" in
    S1) echo scenarios/s1-help.sh ;;
    S2) echo scenarios/s2-empty-env-tui.sh ;;
    S3) echo scenarios/s3-usage-fixture.sh ;;
    S4) echo scenarios/s4-409-retry.sh ;;
    S5) echo scenarios/s5-reasoning-replay.sh ;;
    S6) echo scenarios/s6-session-jsonl.sh ;;
    S7) echo scenarios/s7-cron-surface.sh ;;
    S8) echo scenarios/s8-bad-tail.sh ;;
    # phase 19 — 工具执行链路。S1–S8 里 fixture 从不发 function_call，于是
    # "模型请求工具 -> agent 执行 -> 结果回喂 -> 继续"这条产品主循环从未跑过真二进制。
    S9) echo scenarios/s9-tool-read.sh ;;
    S10) echo scenarios/s10-tool-write-disk.sh ;;
    S11) echo scenarios/s11-tool-multiturn.sh ;;
    S12) echo scenarios/s12-tool-failure-recovery.sh ;;
    *) echo ""; return 1 ;;
  esac
}

run_side() { # $1=side $2=outdir-root
  local side="$1" root="$2" fail=0
  for s in $SCN; do
    local sc; sc=$(scenario_script "$s")
    echo "== $s ($side) =="
    if ! bash "$sc" "$side" "$root/$s"; then echo "SCENARIO $s FAILED ($side)"; fail=1; fi
  done
  return $fail
}

diff_sides() { # $1=rootA $2=rootB $3=label -> 打印 per-scenario diff 计数; 返回非0若有差异
  local A="$1" B="$2" label="$3" bad=0
  for s in $SCN; do
    for f in "$A/$s"/*.norm; do
      [ -e "$f" ] || continue
      local base rel; base=$(basename "$f"); rel="$s/$base"
      if [ ! -e "$B/$rel" ]; then echo "[$label] $rel: MISSING on B side"; bad=1; continue; fi
      if ! node lib/diff.mjs "$f" "$B/$rel" > "$B/$rel.diff" 2>&1; then
        echo "[$label] $rel: $(head -1 "$B/$rel.diff")"; bad=1
      fi
    done
  done
  [ $bad -eq 0 ] && echo "[$label] ALL SCENARIOS: DIFF 0"
  return $bad
}

case "$MODE" in
  oracle)
    run_side oracle out/oracle
    echo "ORACLE-ONLY RUN COMPLETE"
    ;;
  ts)
    if ! ts_ready; then echo "TS side not ready (no executable at $TS_BIN)"; exit 2; fi
    run_side ts out/ts
    echo "TS-ONLY RUN COMPLETE"
    ;;
  both)
    run_side oracle out/oracle
    if ! ts_ready; then echo "TS side not ready (no executable at $TS_BIN)"; exit 2; fi
    run_side ts out/ts
    if diff_sides out/oracle out/ts BOTH; then echo "PARITY: GREEN"; else echo "PARITY: DIVERGENCES FOUND"; exit 1; fi
    ;;
  selfcheck)
    echo "=== self-check 1/2: oracle vs oracle 自差分（判定确定性与归一化充分性）==="
    run_side oracle out/self-a
    run_side oracle out/self-b
    if ! diff_sides out/self-a out/self-b SELF; then
      echo "SELF-CHECK FAILED: oracle 自差分非 0（归一化不充分或行为非确定）"; exit 1
    fi
    echo "=== self-check 2/2: 3 处行为突变必须检出 ==="
    det=0
    # M1: S3 fixture usage 突变（cached 80 -> 0）
    SCN="S3"; S3_MODE=usage-mutated run_side oracle out/mut-m1 || true
    if ! diff_sides out/self-a out/mut-m1 M1 > out/m1.log 2>&1; then echo "M1 (usage mutation): DETECTED"; det=$((det+1)); else echo "M1: NOT DETECTED"; cat out/m1.log; fi
    # M2: S1 目录行过滤（删除 openrouter）
    SCN="S1"; S1_FILTER="grep -v openrouter" run_side oracle out/mut-m2 || true
    if ! diff_sides out/self-a out/mut-m2 M2 > out/m2.log 2>&1; then echo "M2 (catalog mutation): DETECTED"; det=$((det+1)); else echo "M2: NOT DETECTED"; cat out/m2.log; fi
    # M3: S8 跳过截断（session 保持健康 -> resume 行为翻转）
    SCN="S8"; S8_SKIP_CORRUPT=1 run_side oracle out/mut-m3 || true
    if ! diff_sides out/self-a out/mut-m3 M3 > out/m3.log 2>&1; then echo "M3 (corruption toggle): DETECTED"; det=$((det+1)); else echo "M3: NOT DETECTED"; cat out/m3.log; fi
    echo "MUTATIONS DETECTED: $det/3"
    [ "$det" -eq 3 ] && echo "SELF-CHECK PASSED" || { echo "SELF-CHECK FAILED"; exit 1; }
    ;;
esac
