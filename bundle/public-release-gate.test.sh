#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-public-gate.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/expected.json" <<'JSON'
{"resources":{"apps":{"player_insights_app":{"name":"pia-dev","user_api_scopes":["sql"],"resources":[{"name":"warehouse","sql_warehouse":{"id":"wh","permission":"CAN_USE"}}]}}}}
JSON
cat >"$WORK/live.json" <<'JSON'
{"name":"pia-dev","user_api_scopes":["sql"],"resources":[{"name":"warehouse","sql_warehouse":{"id":"wh","permission":"CAN_USE","state":"READY"}}]}
JSON
python3 "$HERE/public-release-gate.py" --expected "$WORK/expected.json" --live "$WORK/live.json" \
  | grep -q "match"

python3 - "$WORK/live.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["resources"]=[]; json.dump(d,open(p,"w"))
PY
set +e
OUTPUT="$(python3 "$HERE/public-release-gate.py" --expected "$WORK/expected.json" --live "$WORK/live.json" 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 1 && "$OUTPUT" == *"not attached"* ]]
grep -q "Public release gate" "$HERE/release-gate.sh"
printf 'PASS  public release gate checks live scopes and bindings.\n'
