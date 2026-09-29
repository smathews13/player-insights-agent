#!/usr/bin/env bash
# Proof canary-traffic.py peels a minority share off the live version.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-canary.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
python3 - "$WORK" <<'PY'
import json, sys
work = sys.argv[1]
json.dump({
  "served_entities": [
    {"name": "agent_50", "entity_version": "50"},
    {"name": "agent_51", "entity_version": "51"},
  ],
  "traffic_config": {"routes": [{"served_model_name": "agent_50", "traffic_percentage": 100}]},
}, open(f"{work}/config.json", "w"))
PY
out="$(python3 "$HERE/canary-traffic.py" --endpoint x --profile p --candidate 51 --percent 10 --config-json "$WORK/config.json")"
printf '%s\n' "$out" | grep -q '"traffic_percentage": 90' || { echo "$out"; exit 1; }
printf '%s\n' "$out" | grep -q '"traffic_percentage": 10' || { echo "$out"; exit 1; }
if python3 "$HERE/canary-traffic.py" --endpoint x --profile p --candidate 50 --percent 10 --config-json "$WORK/config.json" >/dev/null; then
  echo "live-as-candidate should refuse"; exit 1
fi
if python3 "$HERE/canary-traffic.py" --endpoint x --profile p --candidate 51 --percent 80 --config-json "$WORK/config.json" >/dev/null; then
  echo "majority peel should refuse"; exit 1
fi
printf 'ok - canary traffic split refuses majority peel and live-as-candidate\n'
