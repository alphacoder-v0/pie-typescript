#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
bin=$(side_bin "$side")
# stdout and stderr are **captured separately** (fixed in phase 19).
# Both commands used to be `> raw 2>&1`, merging the two streams into one file — which made a whole
# class of defect, "diagnostics on the wrong stream", **structurally invisible** to the judge. That
# is exactly how measuring the state surface in phase 19 caught F1: outside a TTY, `pie --version`
# wrote the version to stderr rather than stdout, so `$(pie --version)` came back empty, while S1
# reported DIFF 0 throughout.
# What the judge cannot see, the judge is not judging. The merged raw file is kept for humans to read.
"$bin" --help > "$out/help.outtxt" 2> "$out/help.errtxt" || true
"$bin" --version > "$out/version.outtxt" 2> "$out/version.errtxt" || true
cat "$out/help.outtxt" "$out/help.errtxt" > "$out/help.raw"
cat "$out/version.outtxt" "$out/version.errtxt" > "$out/version.raw"
${S1_FILTER:-cat} < "$out/help.raw" > "$out/help.filtered"
${S1_FILTER:-cat} < "$out/help.outtxt" > "$out/help.outfiltered"
export PARITY_HOME_A=""
node "$PARITY_ROOT/lib/normalize.mjs" < "$out/help.filtered" > "$out/help.norm"
node "$PARITY_ROOT/lib/normalize.mjs" < "$out/version.raw" > "$out/version.norm"
node "$PARITY_ROOT/lib/normalize.mjs" < "$out/help.outfiltered" > "$out/helpout.norm"
node "$PARITY_ROOT/lib/normalize.mjs" < "$out/help.errtxt" > "$out/helperr.norm"
node "$PARITY_ROOT/lib/normalize.mjs" < "$out/version.outtxt" > "$out/versionout.norm"
node "$PARITY_ROOT/lib/normalize.mjs" < "$out/version.errtxt" > "$out/versionerr.norm"
echo "S1 done ($side)"
