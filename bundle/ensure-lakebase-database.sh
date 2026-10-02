#!/usr/bin/env bash
# Idempotently create one target's AppKit-isolated Lakebase database.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[ $# -eq 0 ] || die "ensure-lakebase-database.sh takes no arguments"
require_cmd databricks
require_target
resolve_profile
seed_bundle_cache

DATABASE_RESOURCE="$(bundle_var postgres_database_name)"
DATABASE_LOOKUP=""
if DATABASE_LOOKUP="$(databricks postgres get-database "$DATABASE_RESOURCE" \
    --profile "$PROFILE" -o json 2>&1)"; then
  note "Lakebase database exists: $DATABASE_RESOURCE"
  exit 0
fi
if [[ "$DATABASE_LOOKUP" != *"does not exist"* \
   && "$DATABASE_LOOKUP" != *"RESOURCE_DOES_NOT_EXIST"* \
   && "$DATABASE_LOOKUP" != *"not found"* ]]; then
  printf '%s\n' "$DATABASE_LOOKUP" >&2
  die "Lakebase database lookup failed; refusing to treat an authentication or network error as absence."
fi

DATABASE_ID="$(bundle_var lakebase_database_id)"
POSTGRES_DATABASE="$(bundle_var lakebase_postgres_database)"
OWNER_ROLE="$(bundle_var lakebase_database_owner_role)"
BRANCH_RESOURCE="$(bundle_var postgres_branch_name)"
databricks postgres get-role "$OWNER_ROLE" --profile "$PROFILE" -o json >/dev/null \
  || die "Lakebase database owner role '$OWNER_ROLE' does not exist or is not readable."
DATABASE_JSON="$(python3 - "$POSTGRES_DATABASE" "$OWNER_ROLE" <<'PY'
import json,sys
print(json.dumps({"spec":{"postgres_database":sys.argv[1],"role":sys.argv[2]}}))
PY
)"

step "Creating isolated Lakebase database $DATABASE_ID"
databricks postgres create-database "$BRANCH_RESOURCE" \
  --database-id "$DATABASE_ID" --json "$DATABASE_JSON" --profile "$PROFILE"
