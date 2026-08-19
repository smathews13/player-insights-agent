#!/usr/bin/env bash
# Offline proof that the release hook derives every grant input from the bundle
# and live resources, uses the direct branch host, and propagates grant failure.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-app-db-grant-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0

ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

mkdir -p "$WORK/bin" "$WORK/repo/bundle" "$WORK/repo/player-insights-agent/scripts"
cp "$HERE/_lib.sh" "$HERE/app-db-grant.sh" "$WORK/repo/bundle/"
cp "$REPO/databricks.yml" "$WORK/repo/databricks.yml"
touch "$WORK/repo/player-insights-agent/scripts/grant-app-db-access.mjs"

cat > "$WORK/bin/databricks" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  "bundle validate -t test -o json --profile test-profile")
    printf '%s\n' '{"variables":{"app_name":{"value":"test-app"},"lakebase_app_schema":{"value":"state_schema"}}}'
    ;;
  "apps get test-app --profile test-profile -o json")
    printf '%s\n' '{"service_principal_client_id":"app-role-123","resources":[{"postgres":{"branch":"projects/p/branches/production","database":"projects/p/branches/production/databases/db-resource"}}]}'
    ;;
  "postgres get-branch projects/p/branches/production --profile test-profile -o json")
    printf '%s\n' '{"status":{"hosts":{"host":"direct.branch.database.cloud.databricks.com"}}}'
    ;;
  "postgres list-databases projects/p/branches/production --profile test-profile -o json")
    printf '%s\n' '[{"database_id":"db-resource","status":{"postgres_database":"app_database"}}]'
    ;;
  "current-user me --profile test-profile -o json")
    printf '%s\n' '{"userName":"operator@example.com"}'
    ;;
  *)
    printf 'unexpected databricks call: %s\n' "$*" >&2
    exit 90
    ;;
esac
SH
chmod +x "$WORK/bin/databricks"

cat > "$WORK/bin/node" <<'SH'
#!/usr/bin/env bash
printf '%s\n' \
  "profile=$DATABRICKS_CONFIG_PROFILE" \
  "host=$PGHOST" \
  "database=$PGDATABASE" \
  "user=$PGUSER" \
  "role=$APP_PG_ROLE" \
  "schema=$PLAYER_INSIGHTS_APP_SCHEMA" \
  "script=$*" > "$NODE_ENV_OUT"
exit "${FAKE_NODE_STATUS:-0}"
SH
chmod +x "$WORK/bin/node"

export CALLS="$WORK/calls"
export NODE_ENV_OUT="$WORK/node-env"
export PATH="$WORK/bin:$PATH"

run_hook() {
  (
    cd "$WORK/repo"
    TARGET=test PROFILE=test-profile bash bundle/app-db-grant.sh
  )
}

printf '\n==> successful grant input resolution\n'
if run_hook >"$WORK/out" 2>&1; then
  ok "the grant hook succeeds when the mocked grant succeeds"
else
  bad "the grant hook unexpectedly failed"
  sed 's/^/        /' "$WORK/out"
fi

for expected in \
  "profile=test-profile" \
  "host=direct.branch.database.cloud.databricks.com" \
  "database=app_database" \
  "user=operator@example.com" \
  "role=app-role-123" \
  "schema=state_schema" \
  "script=scripts/grant-app-db-access.mjs"; do
  if grep -qF "$expected" "$NODE_ENV_OUT"; then
    ok "injects $expected"
  else
    bad "did not inject $expected"
  fi
done

if grep -qF "postgres get-branch projects/p/branches/production" "$CALLS" \
   && ! grep -qF "list-endpoints" "$CALLS"; then
  ok "uses the direct branch host and never an endpoint/pooled fallback"
else
  bad "did not exclusively resolve PGHOST from postgres get-branch"
fi

printf '\n==> failed grants stop the hook\n'
export FAKE_NODE_STATUS=42
if run_hook >"$WORK/fail-out" 2>&1; then
  bad "a failed grant was swallowed"
elif grep -qF "Postgres grant remediation failed" "$WORK/fail-out"; then
  ok "a failed grant returns non-zero with an actionable error"
else
  bad "a failed grant returned non-zero without the actionable error"
fi
unset FAKE_NODE_STATUS

printf '\n==> canonical release invokes the hook as a gate\n'
if grep -qF 'run_app_db_grant' "$HERE/app-release.sh" \
   && grep -qF 'TARGET="$TARGET" PROFILE="$PROFILE" bash "$APP_DB_GRANT"' "$HERE/app-release.sh" \
   && ! grep -Eq 'run_app_db_grant[[:space:]]*(\|\||&&|if)' "$HERE/app-release.sh"; then
  ok "app-release invokes the grant hook without swallowing failure"
else
  bad "app-release does not visibly gate deploy on the grant hook"
fi

printf '\n'
if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
if (( PASS < 11 )); then
  printf 'FAIL  only %d assertions ran; this suite has 11.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
