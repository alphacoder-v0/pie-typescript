#!/usr/bin/env bash
# S7 — the cron and trigger command surface: create a rule, then the list output and the structure of
# what lands on disk
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
side="$1"; out="$2"
mkdir -p "$out"; find "$out" -mindepth 1 -delete 2>/dev/null || true
H=$(mkhome); export PARITY_HOME_A="$H"
FEED="printf '/cron add --stateful \"0 9 * * *\" check the repo and report\n'; sleep 2; printf '/cron\n'; sleep 2; printf '/inbox\n'; sleep 2"
PARITY_TIMEOUT=30 run_pie "$side" "$H" "$out/run" "$FEED" --tui
strip_ansi < "$out/run.stdout" | grep -a . > "$out/run.txt"
normalize_into "$out/run.txt" "$out/run.norm"
# On disk: the relative paths and JSON structure of the cron, trigger and inbox files
( cd "$H/.pie" 2>/dev/null && find . -type f | sort ) > "$out/files.txt" || : > "$out/files.txt"
normalize_into "$out/files.txt" "$out/files.norm"
CRON=$(find "$H/.pie" -name "*.cron.toml" 2>/dev/null | head -1)
if [ -n "$CRON" ]; then cp "$CRON" "$out/cron.toml"; normalize_into "$out/cron.toml" "$out/cron.norm"; else : > "$out/cron.norm"; fi
cleanup_home "$H"
echo "S7 done ($side)"
