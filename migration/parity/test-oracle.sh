#!/usr/bin/env bash
# test-oracle.sh — phase 17 done-gate 的另一半：在 oracle 侧复跑它自己的测试套件。
#
# 为什么需要它：kit Step 6 的 done-gate 是**双计数**——referee（parity judge）全绿只证明
# 两侧行为一致，不证明 oracle 本身是绿的。若 oracle 有自身失败的用例，那些用例对应的
# TS 侧失败就该归类为 `inherited` 而非 `regression`。没有这个基线，分类无从谈起。
#
# cargo 在本仓被 .claude/settings.json deny；oracle 是**仓外** checkout，
# 与 build-oracle.sh 同一口径（CLAUDE.md：oracle 操作一律走 migration/parity/*.sh 封装）。
set -uo pipefail
cd "$(dirname "$0")/../.."
set -a; source migration/sources.env; set +a
ORACLE=$(eval echo "$ORACLE_PIE_DIR")
[ -d "$ORACLE" ] || { echo "oracle dir missing: $ORACLE"; exit 1; }

# 与 build-oracle.sh 相同的漂移守卫：pin 不可漂移，否则复跑出的计数没有意义。
head=$(cd "$ORACLE" && git rev-parse HEAD)
[ "$head" = "$ORACLE_PIE_SHA" ] || { echo "oracle SHA drift: $head != $ORACLE_PIE_SHA"; exit 1; }

OUT="${1:-$(pwd)/migration/parity/out/oracle-cargo-test.log}"
mkdir -p "$(dirname "$OUT")"

echo "oracle: $ORACLE @ $head"
echo "running: cargo test --workspace  (输出 → $OUT)"
( cd "$ORACLE" && cargo test --workspace ) > "$OUT" 2>&1
rc=$?

echo "cargo test exit=$rc"
# cargo 为每个 test binary 单独打一行 `test result: ...`，逐行汇总。
awk '/^test result:/ {
  for (i = 1; i <= NF; i++) {
    if ($i == "passed;")  p  += $(i-1);
    if ($i == "failed;")  f  += $(i-1);
    if ($i == "ignored;") ig += $(i-1);
  }
  n++
}
END { printf "test binaries=%d  passed=%d  failed=%d  ignored=%d\n", n, p, f, ig }' "$OUT"

exit "$rc"
