#!/usr/bin/env bash
# toolwire.sh <requests.ndjson> — projects the fixture request log onto a "tool wire format" judging
# surface, one line per request.
#
# It keeps only the function_call and function_call_output input items, but **keeps all their fields**
# (id, call_id, name, arguments, output). The reasons:
#   - the tool result rendered on screen is not the output string the model actually received, and
#     the judgment has to land on the latter.
#   - the whole request body — the system prompt plus 25 tool schemas, about 22 KB — is S3's
#     responsibility through requests.norm; copying it again here would only redden an
#     already-declared divergence a second time and leave the reader with noise.
#   - no collapsing to a count with `| length` or similar: a surface that reports only a number
#     cannot see wrong arguments, a missing line of output, or a mispaired call_id.
# Each line looks like {"n":2,"tool_items":[{...},{...}]}. Without jq it **exits with an error**
# rather than silently producing an empty file: a judging surface that disappears, and therefore
# always reports DIFF 0, is more dangerous than one that is wrong. This repository has already
# produced three referees that could not fail.
set -euo pipefail
LOGF="$1"
if ! command -v jq > /dev/null 2>&1; then
  echo "toolwire.sh: jq not found — tool wire assertion surface unavailable" >&2
  exit 1
fi
jq -c '{ n: .n, tool_items: [ .body.input[]? | select(.type == "function_call" or .type == "function_call_output") ] }' \
  "$LOGF"
