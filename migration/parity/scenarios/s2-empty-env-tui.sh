#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
run_pie "$side" "$H" "$out/tui" "printf 'hello\n'; sleep 1" --tui
strip_ansi < "$out/tui.stdout" | grep -a . | ${S2_FILTER:-cat} > "$out/tui.txt"
strip_ansi < "$out/tui.stderr" | grep -a . > "$out/tui.errtxt" || true
normalize_into "$out/tui.txt" "$out/tui.norm"
normalize_into "$out/tui.errtxt" "$out/tuierr.norm"
cleanup_home "$H"
echo "S2 done ($side)"
