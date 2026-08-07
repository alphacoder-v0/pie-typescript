#!/usr/bin/env bash
# check-manifest-coverage.sh — every .rs file under oracle crates/ appears exactly once in manifest.tsv
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source migration/sources.env; set +a
ORACLE=$(eval echo "$ORACLE_PIE_DIR")

# The upstream checkout is optional. A clean clone has no copy of it, and the
# file-level comparison this gate performs is meaningless without one, so report
# SKIP and let the rest of the checks run. The other coverage gates behave the
# same way, which keeps `npm run check` green on a machine that has never
# fetched the upstream sources.
if [ -z "$ORACLE" ] || [ ! -d "$ORACLE/crates" ]; then
    echo "check:manifest: SKIP — upstream checkout not found (set UPSTREAM_ORACLE_DIR to enable)"
    exit 0
fi

want=$(mktemp); got=$(mktemp)
find "$ORACLE/crates" -name '*.rs' -not -path '*/target/*' | sed "s#^$ORACLE/##" | sort > "$want"
tail -n +2 migration/manifest.tsv | cut -f2 | grep '^crates/' | sort > "$got"
dups=$(sort "$got" | uniq -d | wc -l)
missing=$(comm -23 "$want" "$got" | tee /dev/stderr | wc -l)
extra=$(comm -13 "$want" "$got" | tee /dev/stderr | wc -l)
echo "rs-files=$(wc -l < "$want") manifest-crate-rows=$(wc -l < "$got") missing=$missing extra=$extra dups=$dups"
rm -f "$want" "$got"

# out_path uniqueness (added 2026-08-05). Only the second column used to be checked, so two units
# could share one out_path — and since completion means "the out_path file exists and status=done",
# the existence of a single file would satisfy both units' claims at once. That is the false-green
# mechanism this migration has hit five times, and the old check could not see it: it did only
# `cut -f2` and `uniq -d`.
#
# Consolidating is legitimate in itself — two upstream units really can land in one TypeScript file —
# so the rule is not "no duplicates" but "a duplicate has to be declared": every row sharing an
# out_path writes consolidated: in its rationale.
outdup=0
while read -r path; do
  [ -z "$path" ] && continue
  rows=$(awk -F'\t' -v p="$path" 'NR>1 && $4==p {print $0}' migration/manifest.tsv)
  undeclared=$(printf '%s\n' "$rows" | grep -cv 'consolidated:' || true)
  if [ "$undeclared" -gt 0 ]; then
    echo "OUT_PATH duplicated without a declaration: $path"
    printf '%s\n' "$rows" | awk -F'\t' '{print "    " $1}'
    outdup=$((outdup+1))
  fi
done < <(awk -F'\t' 'NR>1 && $4!="-" && $4!="" && $4 !~ /^dissolved:/ {print $4}' migration/manifest.tsv | sort | uniq -d)
echo "out_path-undeclared-dups=$outdup"

[ "$missing" -eq 0 ] && [ "$extra" -eq 0 ] && [ "$dups" -eq 0 ] && [ "$outdup" -eq 0 ] \
  && echo "COVERAGE OK" || { echo "COVERAGE FAIL"; exit 1; }
