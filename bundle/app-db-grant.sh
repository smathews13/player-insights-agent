#!/usr/bin/env bash
# Apply the Postgres grants an attached Databricks App needs, using only the
# resolved bundle target and the live app/Lakebase resource outputs.
#
# This is called by app-release.sh immediately before every app code deploy. It
# is also the manual escape hatch after a Lakebase detach/reattach when a full
# app release is not otherwise needed:
#
#   TARGET=<target> PROFILE=<profile> bundle/app-db-grant.sh
#
# The profile identity must hold DATABRICKS_SUPERUSER on the attached branch.
# Nothing here has a target-specific default: app, branch, database, host, app
# role, and operator role are all read from the resolved target or control plane.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd node
require_target
resolve_profile

APP_NAME="$(bundle_var app_name)"
APP_SCHEMA="$(bundle_var lakebase_app_schema)"
APP_DIR="$BUNDLE_ROOT/player-insights-agent"

step "Resolving Lakebase grant inputs for $APP_NAME"

APP_JSON="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json)" \
  || die "Could not read app '$APP_NAME' with profile '$PROFILE'.
The app must already exist: run databricks bundle deploy -t $TARGET first."

IFS=$'\t' read -r APP_PG_ROLE POSTGRES_BRANCH POSTGRES_DATABASE_RESOURCE < <(
  printf '%s' "$APP_JSON" | python3 -c '
import json,sys
app=json.load(sys.stdin)
role=app.get("service_principal_client_id") or ""
postgres=next((r.get("postgres") for r in app.get("resources",[]) if r.get("postgres")), {})
branch=postgres.get("branch") or ""
database=postgres.get("database") or ""
print("\t".join((role,branch,database)))
'
)
[[ -n "$APP_PG_ROLE" && -n "$POSTGRES_BRANCH" && -n "$POSTGRES_DATABASE_RESOURCE" ]] \
  || die "App '$APP_NAME' does not expose a service principal and attached Postgres branch/database.
Run databricks bundle deploy -t $TARGET and confirm the app's 'postgres' resource
is attached before releasing its code."

BRANCH_JSON="$(databricks postgres get-branch "$POSTGRES_BRANCH" \
  --profile "$PROFILE" -o json)" \
  || die "Could not read the direct branch connection for '$POSTGRES_BRANCH' with profile '$PROFILE'."
DATABASES_JSON="$(databricks postgres list-databases "$POSTGRES_BRANCH" \
  --profile "$PROFILE" -o json)" \
  || die "Could not list databases for '$POSTGRES_BRANCH' with profile '$PROFILE'."
PGUSER="$(databricks current-user me --profile "$PROFILE" -o json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("userName") or "")')" \
  || die "Could not resolve the Postgres login from profile '$PROFILE'."

PGHOST="$(printf '%s' "$BRANCH_JSON" | python3 -c '
import json,sys
branch=json.load(sys.stdin)
print(((branch.get("status") or {}).get("hosts") or {}).get("host") or "")
')"

DATABASE_ID="${POSTGRES_DATABASE_RESOURCE##*/}"
PGDATABASE="$(printf '%s' "$DATABASES_JSON" | python3 -c '
import json,sys
database_id=sys.argv[1]
body=json.load(sys.stdin)
rows=body if isinstance(body,list) else body.get("databases",[])
row=next((r for r in rows
          if r.get("database_id")==database_id or str(r.get("name") or "").split("/")[-1]==database_id), {})
print((row.get("status") or {}).get("postgres_database") or "")
' "$DATABASE_ID")"

[[ -n "$PGHOST" && -n "$PGDATABASE" && -n "$PGUSER" ]] \
  || die "Could not derive PGHOST, PGDATABASE, and PGUSER from the attached Lakebase
resource and profile '$PROFILE'. PGHOST is read only from 'postgres get-branch':
the pooled AppKit hostname is not accepted because it rejects the operator OAuth
login. Confirm the branch exposes status.hosts.host, the database '$DATABASE_ID'
exists, and the profile maps to a Lakebase role."

note "profile       $PROFILE"
note "branch        $POSTGRES_BRANCH"
note "database      $PGDATABASE"
note "connect as    $PGUSER"
note "grant to      $APP_PG_ROLE"
note "app schema    $APP_SCHEMA"

step "Applying app and AppKit Postgres remediation"
if ! (
  cd "$APP_DIR"
  DATABRICKS_CONFIG_PROFILE="$PROFILE" \
    PGHOST="$PGHOST" \
    PGDATABASE="$PGDATABASE" \
    PGUSER="$PGUSER" \
    APP_PG_ROLE="$APP_PG_ROLE" \
    PLAYER_INSIGHTS_APP_SCHEMA="$APP_SCHEMA" \
    node scripts/grant-app-db-access.mjs
); then
  die "Postgres grant remediation failed, so the app release is stopped before
the code deploy. Profile '$PROFILE' must reach '$PGHOST' and its identity must
hold DATABRICKS_SUPERUSER on '$POSTGRES_BRANCH'. Fix that access and re-run:
  TARGET=$TARGET PROFILE=\"$PROFILE\" bundle/app-release.sh --apply"
fi
