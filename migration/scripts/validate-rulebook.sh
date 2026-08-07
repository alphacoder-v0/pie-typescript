#!/usr/bin/env bash
# validate-rulebook.sh — a self-check on the format and acceptance of RULEBOOK.md and inventory.tsv
# (phase 3)
set -euo pipefail
cd "$(dirname "$0")/../.."
RB=migration/RULEBOOK.md
err=0
say(){ echo "$@"; }
fail(){ echo "FAIL: $*"; err=1; }

# 1. required sections
for sec in "## 0. Scope and posture" "## 1. Ecosystem adoption" "## 2. Constructs with no equivalent" "## 3. The sanctioned escape hatch" "## 4. Where pie's additions land" "## 5. The BUG(port) ledger" "## 6. Deviation log"; do
  grep -qF "$sec" "$RB" || fail "missing section: $sec"
done
# 2. unambiguous wording
n=$(grep -c "either/or\|as appropriate\|whichever suits\|depending on the case" "$RB" || true)
[ "$n" -eq 0 ] || fail "ambiguous wording hits: $n"
# 3. every tokio construct has a mapping row
for c in "tokio::spawn" "spawn_blocking" "mpsc" "oneshot" "select!" "Mutex" "RwLock" "watch" "broadcast" "Notify"; do
  grep -q -- "$c" "$RB" || fail "no mapping row mentioning: $c"
done
# 4. the BUG ledger has at least 9 entries, each with an upstream pointer (crates/...:line or a range)
nbug=$(grep -cE '^\| B[0-9]+[a-z]? \|' "$RB" || true)
[ "$nbug" -ge 9 ] || fail "BUG ledger entries: $nbug < 9"
nptr=$(grep -E '^\| B[0-9]+[a-z]? \|' "$RB" | grep -cE 'crates/[a-z-]+/src/[^|]+:[0-9]' || true)
[ "$nptr" -eq "$nbug" ] || fail "BUG entries with oracle line pointer: $nptr / $nbug"
# 5. the inventory is non-empty and its guard values are valid
tail -n +3 migration/inventory.tsv | awk -F'\t' '$4!="allocation-guard" && $4!="precondition-guard" && $4!="n/a" {print "bad guard: "$0; ex=1} END{exit ex}' || fail "invalid guard values"
nrows=$(tail -n +3 migration/inventory.tsv | wc -l)
[ "$nrows" -gt 100 ] || fail "inventory too thin: $nrows"
# 6. the dependency allowlist is present
grep -q "NONE without a rule" "$RB" || fail "dependency whitelist default missing"
[ $err -eq 0 ] && echo "RULEBOOK VALIDATION OK (bug-entries=$nbug inventory-rows=$nrows)" || exit 1
