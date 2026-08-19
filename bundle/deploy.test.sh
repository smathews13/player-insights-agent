#!/usr/bin/env bash
# Prove the greenfield wrapper keeps one ordered App deployment path.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pia-deploy-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/databricks" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2" == "bundle validate" ]]; then
  cat <<'JSON'
{
  "variables": {
    "app_name": {"default": "test-app"},
    "app_description": {"default": "Test App"}
  },
  "resources": {
    "apps": {"player_insights_app": {"name": "test-app"}},
    "schemas": {"player_insights_schema": {"name": "test-schema"}},
    "jobs": {"player_insights_setup": {"name": "test-job"}}
  }
}
JSON
  exit 0
fi
printf 'unexpected databricks call: %s\n' "$*" >&2
exit 1
EOF
chmod +x "$TMP/databricks"

OUTPUT="$(
  PATH="$TMP:$PATH" TARGET=test PROFILE=test-profile "$HERE/deploy.sh"
)"

for NEEDLE in \
  "create the no-compute App shell" \
  "bind that shell to resources.apps.player_insights_app" \
  "deploy every non-App bundle resource" \
  "run bundle/agent-release.sh --apply" \
  "deploy the complete bundle" \
  "run bundle/app-release.sh --apply"
do
  [[ "$OUTPUT" == *"$NEEDLE"* ]] || {
    printf 'FAIL  dry run omitted: %s\n%s\n' "$NEEDLE" "$OUTPUT"
    exit 1
  }
done

python3 - "$HERE/deploy.sh" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
steps = [
    'step "Creating no-compute App shell"',
    'step "Binding App shell to bundle state"',
    'step "Deploying bundle prerequisites"',
    'step "Releasing agent model and endpoint"',
    'step "Reconciling complete bundle"',
    'step "Applying grants and releasing app source"',
]
positions = [text.index(step) for step in steps]
assert positions == sorted(positions), "greenfield deployment order changed"
PY

printf 'PASS  greenfield wrapper keeps one ordered deployment path.\n'
