#!/usr/bin/env bash
# End-to-end identity test for a deployed target.
#
#   TARGET=<target> [PROFILE=<profile>] bash bundle/identity-e2e.sh setup|run|teardown
#
# setup is idempotent and safe to repeat; run it once per workspace, and again
# after a release if a bundle deploy reset the endpoint ACL. run exits non-zero
# on any failed check and leaves no App group grant behind, so a following
# bundle deploy is not blocked. teardown removes every pia-e2e object.
# See identity-e2e.py for what each check proves.
source "$(dirname "$0")/_lib.sh"

COMMAND="${1:-}"
case "$COMMAND" in
  setup | run | teardown) ;;
  *) die "usage: TARGET=<target> bash bundle/identity-e2e.sh setup|run|teardown" ;;
esac

require_cmd databricks
require_cmd python3
resolve_profile
load_bundle_json

E2E_HOST="$(bundle_json | python3 -c 'import json,sys;print(json.load(sys.stdin)["workspace"]["host"])')"
E2E_APP_NAME="$(bundle_var app_name)"
E2E_ENDPOINT="$(bundle_var serving_endpoint_name)"
E2E_WAREHOUSE_ID="$(bundle_var warehouse_id)"
E2E_DATA_SCHEMA="$(bundle_var_json data_catalogs | python3 -c '
import json, sys
scopes = [s for s in json.load(sys.stdin) if str(s).count(".") == 1]
if not scopes:
    raise SystemExit("data_catalogs names no catalog.schema to grant the test readers")
print(scopes[0])')"
E2E_GENIE_SPACES="$(
  printf '%s,%s' "$(bundle_var_or_empty genie_data_space_id)" "$(bundle_var_or_empty genie_dictionary_space_id)"
)"

E2E_TARGET="$TARGET" E2E_PROFILE="$PROFILE" E2E_HOST="$E2E_HOST" E2E_APP_NAME="$E2E_APP_NAME" \
  E2E_ENDPOINT="$E2E_ENDPOINT" E2E_WAREHOUSE_ID="$E2E_WAREHOUSE_ID" E2E_DATA_SCHEMA="$E2E_DATA_SCHEMA" \
  E2E_GENIE_SPACES="$E2E_GENIE_SPACES" E2E_LABEL_ACCESS="$BUNDLE_ROOT/bundle/label-access.sh" \
  TARGET="$TARGET" PROFILE="$PROFILE" \
  python3 "$BUNDLE_ROOT/bundle/identity-e2e.py" "$COMMAND"
