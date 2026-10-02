#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-database-api.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/databricks" <<'SH'
#!/usr/bin/env bash
if [[ "$1 $2" == "bundle validate" ]]; then
  cat <<'JSON'
{"variables":{
  "lakebase_database_id":{"value":"pia-dev"},
  "lakebase_postgres_database":{"value":"pia_dev"},
  "lakebase_database_owner_role":{"value":"projects/p/branches/production/roles/owner"},
  "postgres_branch_name":{"value":"projects/p/branches/production"},
  "postgres_database_name":{"value":"projects/p/branches/production/databases/pia-dev"}
}}
JSON
elif [[ "$1 $2" == "postgres get-database" ]]; then
  if [[ "${LOOKUP_REFUSED:-}" == 1 ]]; then
    echo "PERMISSION_DENIED" >&2
    exit 1
  fi
  if [[ "${DATABASE_EXISTS:-}" != 1 ]]; then
    echo "RESOURCE_DOES_NOT_EXIST" >&2
    exit 1
  fi
  printf '{"name":"%s"}\n' "$3"
elif [[ "$1 $2" == "postgres create-database" ]]; then
  printf '%s\0' "$@" >"$CALL"
elif [[ "$1 $2" == "postgres get-role" ]]; then
  printf '%s\n' '{"name":"projects/p/branches/production/roles/owner"}'
else
  printf 'unexpected command: %s\n' "$*" >&2
  exit 2
fi
SH
chmod +x "$WORK/databricks"

run_ensure() {
  PATH="$WORK:$PATH" TARGET=dev PROFILE=test CALL="$WORK/call" \
    bash "$HERE/ensure-lakebase-database.sh"
}

run_ensure >/dev/null
python3 - "$WORK/call" <<'PY'
import json, sys
args=[part.decode() for part in open(sys.argv[1],"rb").read().split(b"\0") if part]
assert args[:3] == ["postgres","create-database","projects/p/branches/production"], args
assert args[args.index("--database-id")+1] == "pia-dev"
body=json.loads(args[args.index("--json")+1])
assert body == {"spec":{"postgres_database":"pia_dev","role":"projects/p/branches/production/roles/owner"}}
assert args[args.index("--profile")+1] == "test"
PY

rm -f "$WORK/call"
DATABASE_EXISTS=1 run_ensure >/dev/null
[[ ! -e "$WORK/call" ]]

set +e
OUTPUT="$(LOOKUP_REFUSED=1 run_ensure 2>&1)"
STATUS=$?
set -e
[[ "$STATUS" -ne 0 ]]
[[ "$OUTPUT" == *"PERMISSION_DENIED"* ]]
[[ "$OUTPUT" == *"refusing to treat"* ]]
[[ ! -e "$WORK/call" ]]

printf 'PASS  Lakebase database create request matches the CLI API contract and is idempotent.\n'
