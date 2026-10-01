#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-pinned-config.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/expected.json" <<'JSON'
{"catalog":"c","schema":"s","warehouse_id":"w","data_genie_space_id":"d","dictionary_genie_space_id":"x","llm_endpoint":"llm","llm_gateway_endpoint":"","llm_gateway":"","catalog_allowlist":["c.data"],"catalog_denylist":[],"max_output_tokens":4000,"manifest_source":"schema"}
JSON
cp "$WORK/expected.json" "$WORK/matching.json"
python3 - "$WORK/expected.json" "$WORK/wrong.json" <<'PY'
import json, sys
d=json.load(open(sys.argv[1]))
d["warehouse_id"]="other"
json.dump(d,open(sys.argv[2],"w"))
PY

python3 "$HERE/pinned-model-config-check.py" \
  --model-config-json "$WORK/matching.json" --expected-json "$WORK/expected.json" \
  | grep -q "matches the target"

set +e
OUTPUT="$(python3 "$HERE/pinned-model-config-check.py" \
  --model-config-json "$WORK/wrong.json" --expected-json "$WORK/expected.json" 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 1 ]]
[[ "$OUTPUT" == *"warehouse_id"* ]]

grep -q "Pinned model configuration vs target" "$HERE/agent-release.sh"
printf 'PASS  pinned versions cannot cross target configuration boundaries.\n'
