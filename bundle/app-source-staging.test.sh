#!/usr/bin/env bash
# Regression tests for destructive Workspace staging cleanup. No live CLI calls.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP_RELEASE="$HERE/app-release.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-app-staging.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# shellcheck source=app-source-staging.sh
source "$HERE/app-source-staging.sh"

PASS=0
FAIL=0
pass() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() {
  local label="$1"; shift
  if "$@"; then pass "$label"; else fail "$label"; fi
}
reject_path() {
  local label="$1" path="$2"
  if validate_app_staging_path "$path" player-insights-agent sam@example.com >/dev/null 2>&1; then
    fail "$label"
  else
    pass "$label"
  fi
}

printf '\n==> staging path safety boundary\n'
check "exact app staging path is accepted" validate_app_staging_path \
  "/Workspace/Users/sam@example.com/player-insights-agent-src" \
  "player-insights-agent" "sam@example.com"
reject_path "empty path is refused" ""
reject_path "filesystem root is refused" "/"
reject_path "Workspace root is refused" "/Workspace"
reject_path "actor home is refused" "/Workspace/Users/sam@example.com"
reject_path "wrong actor is refused" "/Workspace/Users/other@example.com/player-insights-agent-src"
reject_path "wrong app is refused" "/Workspace/Users/sam@example.com/other-app-src"
reject_path "nested path is refused" "/Workspace/Users/sam@example.com/releases/player-insights-agent-src"
reject_path "relative traversal is refused" "/Workspace/Users/sam@example.com/../player-insights-agent-src"
reject_path "retired real-src variant is refused" \
  "/Workspace/Users/sam@example.com/player-insights-agent-real-src"
reject_path "retired app-source variant is refused" \
  "/Workspace/Users/sam@example.com/player-insights-agent-app-source"

MOCK_BIN="$WORK/bin"
MOCK_REMOTE="$WORK/remote"
MOCK_LOG="$WORK/databricks.log"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/databricks" <<'SH'
#!/usr/bin/env bash
set -u
group="$1"
printf '%s' "$group" >> "$MOCK_LOG"
shift
for arg in "$@"; do printf '|%s' "$arg" >> "$MOCK_LOG"; done
printf '\n' >> "$MOCK_LOG"

case "$group ${1:-}" in
  "current-user me")
    printf '{"user_name":"sam@example.com"}\n'
    ;;
  "apps get")
    mode="${MOCK_DEPLOYMENT_MODE:-SNAPSHOT}"
    printf '{"active_deployment":{"mode":"%s","source_code_path":"%s","deployment_artifacts":{"source_code_path":"/Workspace/Users/app-id/src/deployment-id"}}}\n' \
      "$mode" "$MOCK_SOURCE_PATH"
    ;;
  "workspace get-status")
    if [[ -d "$MOCK_REMOTE" ]]; then
      printf '{"object_type":"%s"}\n' "${MOCK_OBJECT_TYPE:-DIRECTORY}"
    else
      printf 'RESOURCE_DOES_NOT_EXIST\n' >&2
      exit 1
    fi
    ;;
  "workspace delete")
    if [[ "${MOCK_DELETE_FAIL:-false}" == "true" ]]; then
      printf 'mock delete failure\n' >&2
      exit 24
    fi
    rm -rf "$MOCK_REMOTE"
    ;;
  "workspace import-dir")
    if [[ "${MOCK_IMPORT_FAIL:-false}" == "true" ]]; then
      printf 'mock import failure\n' >&2
      exit 23
    fi
    mkdir -p "$MOCK_REMOTE"
    cp -R "$2"/. "$MOCK_REMOTE"/
    ;;
  "apps deploy")
    printf 'deployed\n' > "$MOCK_DEPLOY_MARKER"
    ;;
  *)
    printf 'unexpected mock command: %s %s\n' "${1:-}" "${2:-}" >&2
    exit 99
    ;;
esac
SH
chmod +x "$MOCK_BIN/databricks"

export PATH="$MOCK_BIN:$PATH"
export MOCK_REMOTE MOCK_LOG
export MOCK_SOURCE_PATH="/Workspace/Users/sam@example.com/player-insights-agent-src"
export MOCK_DEPLOY_MARKER="$WORK/deployed"
SOURCE="$WORK/source"
mkdir -p "$SOURCE/client/dist/assets" "$MOCK_REMOTE/client/dist/assets"
printf 'current\n' > "$SOURCE/server.mjs"
printf 'current asset\n' > "$SOURCE/client/dist/assets/index-CURRENT.js"
printf 'old server chunk\n' > "$MOCK_REMOTE/chunk-OLDHASH.mjs"
printf 'old client chunk\n' > "$MOCK_REMOTE/client/dist/assets/index-OLDHASH.js"
printf 'active snapshot\n' > "$WORK/active-snapshot"

printf '\n==> clean import and deployment ordering\n'
: > "$MOCK_LOG"
if clean_and_import_app_source "$SOURCE" "$MOCK_SOURCE_PATH" player-insights-agent "<your profile>" \
  >/dev/null 2>&1; then
  databricks apps deploy player-insights-agent --source-code-path "$MOCK_SOURCE_PATH" \
    --mode SNAPSHOT --profile "<your profile>" >/dev/null
else
  fail "clean import succeeds"
fi
check "stale server hash is removed" test ! -e "$MOCK_REMOTE/chunk-OLDHASH.mjs"
check "stale client hash is removed" test ! -e "$MOCK_REMOTE/client/dist/assets/index-OLDHASH.js"
check "staging tree exactly matches the artifact" \
  diff -qr "$SOURCE" "$MOCK_REMOTE"
check "active snapshot is untouched" test -f "$WORK/active-snapshot"

DELETE_LINE="$(grep -n '^workspace|delete|' "$MOCK_LOG" | cut -d: -f1)"
IMPORT_LINE="$(grep -n '^workspace|import-dir|' "$MOCK_LOG" | cut -d: -f1)"
DEPLOY_LINE="$(grep -n '^apps|deploy|' "$MOCK_LOG" | cut -d: -f1)"
if [[ -n "$DELETE_LINE" && -n "$IMPORT_LINE" && -n "$DEPLOY_LINE" \
   && "$DELETE_LINE" -lt "$IMPORT_LINE" && "$IMPORT_LINE" -lt "$DEPLOY_LINE" ]]; then
  pass "successful command order is clean then import then deploy"
else
  fail "successful command order is clean then import then deploy"
fi
check "profile containing a space stays one argument" \
  grep -q -- '|--profile|<your profile>$' "$MOCK_LOG"

printf '\n==> failure safety and snapshot requirement\n'
rm -f "$MOCK_DEPLOY_MARKER"
mkdir -p "$MOCK_REMOTE"
printf 'stale\n' > "$MOCK_REMOTE/stale.js"
: > "$MOCK_LOG"
export MOCK_IMPORT_FAIL=true
if clean_and_import_app_source "$SOURCE" "$MOCK_SOURCE_PATH" player-insights-agent "<your profile>" \
  >/dev/null 2>&1; then
  databricks apps deploy player-insights-agent --profile "<your profile>" >/dev/null
fi
unset MOCK_IMPORT_FAIL
check "failed import never reaches apps deploy" test ! -e "$MOCK_DEPLOY_MARKER"
check "failed import leaves active snapshot untouched" test -f "$WORK/active-snapshot"
check "failed import log contains no app deploy" sh -c "! grep -q '^apps|deploy|' '$MOCK_LOG'"

rm -f "$MOCK_DEPLOY_MARKER"
mkdir -p "$MOCK_REMOTE"
: > "$MOCK_LOG"
export MOCK_DELETE_FAIL=true
if clean_and_import_app_source "$SOURCE" "$MOCK_SOURCE_PATH" player-insights-agent "<your profile>" \
  >/dev/null 2>&1; then
  databricks apps deploy player-insights-agent --profile "<your profile>" >/dev/null
fi
unset MOCK_DELETE_FAIL
check "failed delete never reaches import or deploy" \
  sh -c "! grep -Eq '^(workspace\\|import-dir|apps\\|deploy)\\|' '$MOCK_LOG'"
check "failed delete leaves active snapshot untouched" test -f "$WORK/active-snapshot"

mkdir -p "$MOCK_REMOTE"
: > "$MOCK_LOG"
export MOCK_DEPLOYMENT_MODE=AUTO_SYNC
if clean_and_import_app_source "$SOURCE" "$MOCK_SOURCE_PATH" player-insights-agent "<your profile>" \
  >/dev/null 2>&1; then
  fail "AUTO_SYNC active deployment is refused"
else
  pass "AUTO_SYNC active deployment is refused"
fi
unset MOCK_DEPLOYMENT_MODE
check "snapshot refusal happens before recursive delete" sh -c "! grep -q '^workspace|delete|' '$MOCK_LOG'"

printf '\n==> deterministic source manifest and script structure\n'
FIRST_MANIFEST="$(app_source_manifest_summary "$SOURCE")"
SECOND_MANIFEST="$(app_source_manifest_summary "$SOURCE")"
check "source manifest is deterministic" test "$FIRST_MANIFEST" = "$SECOND_MANIFEST"
check "release explicitly requests SNAPSHOT mode" \
  grep -q 'apps deploy "\$APP_NAME".*--mode SNAPSHOT' "$APP_RELEASE"
check "release cannot stop or delete the active app" \
  sh -c "! grep -Eq 'databricks apps (stop|delete)' '$APP_RELEASE' '$HERE/app-source-staging.sh'"
check "only Workspace staging receives recursive delete" \
  grep -q 'workspace delete "\$source_path" --recursive --profile "\$profile"' "$HERE/app-source-staging.sh"

printf '\n'
if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
