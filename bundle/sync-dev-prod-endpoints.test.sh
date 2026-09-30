#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-endpoint-sync.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/databricks" <<'SH'
#!/usr/bin/env bash
if [[ "$1 $2" == "bundle validate" ]]; then
  target=""
  while [[ $# -gt 0 ]]; do
    [[ "$1" == "-t" ]] && target="$2" && shift
    shift
  done
  model="catalog.schema.player_insights_agent"
  [[ "${MISMATCH:-}" == 1 && "$target" == prod ]] && model="catalog.schema.other"
  printf '{"variables":{"model_name":{"value":"%s"}}}\n' "$model"
elif [[ "$1 $2" == "model-versions list" ]]; then
  if [[ -n "${VERSIONS_JSON:-}" ]]; then
    printf '%s\n' "$VERSIONS_JSON"
  else
    printf '%s\n' '{"model_versions":[{"version":"6","status":"READY"},{"version":"5","status":"READY"},{"version":"4","status":"FAILED_REGISTRATION"}]}'
  fi
else
  printf 'unexpected databricks call: %s\n' "$*" >&2
  exit 2
fi
SH
chmod +x "$WORK/databricks"

cat >"$WORK/agent-release.sh" <<'SH'
#!/usr/bin/env bash
printf '%s|%s|%s\n' "$TARGET" "$PROFILE" "$*" >>"$CALLS"
SH
chmod +x "$WORK/agent-release.sh"

run_sync() {
  PATH="$WORK:$PATH" PROFILE=test-profile CALLS="$WORK/calls" \
    PIA_AGENT_RELEASE_SCRIPT="$WORK/agent-release.sh" \
    bash "$HERE/sync-dev-prod-endpoints.sh" "$@"
}

OUTPUT="$(run_sync --latest-version 6)"
[[ "$OUTPUT" == *"Dev  endpoint -> version 6"* ]]
[[ "$OUTPUT" == *"Prod endpoint -> version 5"* ]]
[[ ! -e "$WORK/calls" ]]

: >"$WORK/calls"
run_sync --apply --latest-version 6 >/dev/null
[[ "$(awk 'NR == 1 { print }' "$WORK/calls")" == "prod|test-profile|--apply --skip-log --model-version 5" ]]
[[ "$(awk 'NR == 2 { print }' "$WORK/calls")" == "dev|test-profile|--apply --skip-log --model-version 6" ]]

: >"$WORK/calls"
run_sync --apply --skip-dev --latest-version 6 >/dev/null
[[ "$(cat "$WORK/calls")" == "prod|test-profile|--apply --skip-log --model-version 5" ]]

set +e
OUTPUT="$(
  VERSIONS_JSON='{"model_versions":[{"version":"6","status":"READY"},{"version":"4","status":"READY"}]}' \
    run_sync --latest-version 6 2>&1
)"
STATUS=$?
set -e
[[ "$STATUS" -eq 2 ]]
[[ "$OUTPUT" == *"version 5 is not READY"* ]]

set +e
OUTPUT="$(MISMATCH=1 run_sync --latest-version 6 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -eq 2 ]]
[[ "$OUTPUT" == *"one-model promotion is impossible"* ]]

python3 - "$HERE/agent-release.sh" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text()
hook = text.index('sync-dev-prod-endpoints.sh')
deploy = text.index('SERVED_COUNT="$(served_entity_count)"')
assert hook < deploy
assert '"$SKIP_LOG" != true && "$TARGET" == "dev"' in text
assert '--skip-dev --latest-version "$MODEL_VERSION"' in text
PY

printf 'PASS  model re-log automatically reconciles Prod=N-1 before Dev=N.\n'
