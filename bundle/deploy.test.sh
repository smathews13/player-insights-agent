#!/usr/bin/env bash
# Prove the bundle wrapper keeps destructive shortcuts out of the happy path.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pia-bundle-deploy-test.XXXXXX")"
STATE="$ROOT/.databricks/bundle/wrapper-test/resources.json"
trap 'rm -rf "$TMP" "$ROOT/.databricks/bundle/wrapper-test"' EXIT

cat >"$TMP/databricks" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2" == "bundle validate" ]]; then
  cat <<'JSON'
{"workspace":{"profile":"test-profile"},"variables":{
  "app_name":{"default":"player-insights-agent"},
  "bundle_root_path":{"default":"/Workspace/Users/test@example.com/.bundle/player-insights-agent-dab/wrapper-test"},
  "genie_mcp_signing_key_version":{"default":"v1"},
  "genie_mcp_signing_scope":{"default":"player-insights-agent-signing"},
  "genie_mcp_signing_public_path":{"default":"/Workspace/Users/test@example.com/.bundle/player-insights-agent-dab/shared/security/genie-mcp-ed25519-public-v1.pem"},
  "lakebase_project_id":{"value":"project-one"},
  "warehouse_id":{"value":"warehouse-one"},
  "semantic_index_endpoint":{"default":""}
}}
JSON
  exit 0
fi
if [[ "$1 $2" == "secrets list-scopes" ]]; then
  echo '{"scopes":[{"name":"player-insights-agent-signing"}]}'
  exit 0
fi
if [[ "$1 $2" == "secrets list-secrets" ]]; then
  echo '{"secrets":[{"key":"genie-mcp-ed25519-private-pem-v1"}]}'
  exit 0
fi
if [[ "$1 $2" == "workspace get-status" ]]; then
  echo '{"object_type":"FILE"}'
  exit 0
fi
if [[ "$1 $2" == "workspace export" ]]; then
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--file" ]]; then
      printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'test' '-----END PUBLIC KEY-----' >"$2"
      break
    fi
    shift
  done
  exit 0
fi
printf '%s\n' "$*" >>"$CALLS"
EOF
chmod +x "$TMP/databricks"

cat >"$TMP/uv" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TAG_CALLS"
EOF
chmod +x "$TMP/uv"

run_wrapper() {
  PATH="$TMP:$PATH" CALLS="$TMP/calls" TAG_CALLS="$TMP/tag-calls" \
    TARGET=wrapper-test PROFILE=test-profile bash "$HERE/deploy.sh" "$@"
}

OUTPUT="$(run_wrapper 2>&1)"
[[ "$OUTPUT" == *"never passes --auto-approve"* ]]
[[ "$OUTPUT" == *"Ensuring the app-to-model signing key exists"* ]]
[[ "$(cat "$TMP/calls")" == "bundle deploy -t wrapper-test --profile test-profile" ]]
[[ ! -e "$TMP/tag-calls" || "$(cat "$TMP/tag-calls")" == *"--lakebase-project project-one --warehouse-id warehouse-one"* ]]
[[ "$OUTPUT" != *"fingerprint"* ]]

python3 - "$HERE/deploy.sh" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
for forbidden in ("agent-release.sh", "log_model.py", "genie-fingerprint-check.py"):
    assert forbidden not in text, (
        f"bundle/deploy.sh must not invoke {forbidden}; fingerprints belong to "
        "the later model release, not fresh infrastructure reconciliation"
    )
sync = text.index("sync-dev-prod-endpoints.sh")
database = text.index("ensure-lakebase-database.sh")
signing_key = text.index("genie-mcp-signing-key.sh")
bundle_deploy = text.index('ARGS=(bundle deploy')
assert database < sync < signing_key < bundle_deploy
assert '"$TARGET" == "dev" || "$TARGET" == "prod"' in text
experiment_bind = text.index("bundle deployment bind player_insights_experiment")
schema_bind = text.index("bundle deployment bind player_insights_schema")
assert schema_bind < experiment_bind < sync
assert "--auto-approve" not in text[experiment_bind:sync]
assert 'if [[ -z "$BOUND_SCHEMA" ]]' in text
assert 'elif [[ "$BOUND_SCHEMA" != "$SCHEMA_FULL_NAME" ]]' in text
assert 'Refusing to rebind customer-owned' in text
assert 'if [[ -z "$BOUND_EXPERIMENT" ]]' in text
assert 'elif [[ "$BOUND_EXPERIMENT" != "$EXPERIMENT_ID" ]]' in text
assert "shared MLflow state automatically" in text
PY

set +e
OUTPUT="$(run_wrapper --auto-approve 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -ne 0 && "$OUTPUT" == *"--auto-approve is forbidden"* ]]

set +e
OUTPUT="$(run_wrapper --force-lock 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -ne 0 && "$OUTPUT" == *"confirming no deploy is live"* ]]

: >"$TMP/calls"
: >"$TMP/tag-calls"
PLAYER_INSIGHTS_AGENT_CONFIRMED_NO_LIVE_DEPLOY=true run_wrapper --force-lock >/dev/null
[[ "$(cat "$TMP/calls")" == "bundle deploy -t wrapper-test --profile test-profile --force-lock" ]]

mkdir -p "$(dirname "$STATE")"
printf '{"resources":{"postgres_projects":{"old_project":{"id":"projects/old"}}}}\n' >"$STATE"
set +e
OUTPUT="$(run_wrapper 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -ne 0 ]]
[[ "$OUTPUT" == *"still tracks Lakebase resource types"* ]]
[[ ! -s "$TMP/calls" ]]
[[ ! -s "$TMP/tag-calls" ]]

python3 - "$HERE/app-release.sh" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
assert 'if [[ ! -d "$APP_DIR/node_modules" ]]' in text
assert '(cd "$APP_DIR" && npm ci)' in text
assert text.index('(cd "$APP_DIR" && npm ci)') < text.rindex('npm run build:deploy)')
deploy = text.rindex('databricks apps deploy "$APP_NAME"')
health = text.index('APP_HEALTH_DEADLINE=')
effective = text.index('verify_effective_scopes "$APP_JSON"')
assert effective < deploy
assert deploy < health
assert 'STARTING/UPDATING' in text
assert '"$APP_STATE" == "RUNNING"' in text
assert '"$COMPUTE_STATE" == "ACTIVE"' in text
assert '"$DEPLOYMENT_STATE" == "SUCCEEDED"' in text
assert 'did not become RUNNING/ACTIVE/SUCCEEDED' in text
terminal = text[text.index('[[ "$APP_STATE" == "CRASHED"'):text.index('if (( $(date +%s) >= APP_HEALTH_DEADLINE ))')]
assert "UNAVAILABLE" not in terminal
PY

printf 'PASS  bundle deploy wrapper blocks unsafe state and flags.\n'
