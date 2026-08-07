#!/usr/bin/env bash
# 构建 oracle（Rust pie）release 二进制；只读上游源码，产物留在其 target/
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source migration/sources.env; set +a
ORACLE=$(eval echo "$ORACLE_PIE_DIR")
[ -d "$ORACLE" ] || { echo "oracle dir missing: $ORACLE"; exit 1; }
head=$(cd "$ORACLE" && git rev-parse HEAD)
[ "$head" = "$ORACLE_PIE_SHA" ] || { echo "oracle SHA drift: $head != $ORACLE_PIE_SHA"; exit 1; }
if [ -x "$ORACLE/target/release/pie" ] && [ "${FORCE_REBUILD:-0}" != "1" ]; then
  echo "oracle binary present: $ORACLE/target/release/pie (skip build; FORCE_REBUILD=1 to rebuild)"
else
  (cd "$ORACLE" && cargo build --release --workspace)
fi
"$ORACLE/target/release/pie" --version
