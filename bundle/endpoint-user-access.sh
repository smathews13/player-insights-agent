#!/usr/bin/env bash
# Grant the app's configured customer access groups permission to invoke the
# model endpoint.
#
# The app forwards each signed-in user's token to Model Serving. The app resource
# binding grants only the app service principal, so the human's group must also
# hold CAN_QUERY or every correctly forwarded Ask is refused with HTTP 403.
#
# The groups are var.app_engineer_group, var.app_exec_group and
# var.app_admin_group. A target that sets all three empty (the <your profile>
# workspace, which has none of them) is a no-op. The grant is a PATCH: it adds
# the groups and leaves every existing endpoint permission untouched.
#
#   TARGET=<target> PROFILE=<profile> bundle/endpoint-user-access.sh --apply

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[[ "${1:-}" == "--apply" ]] || die "This command changes endpoint permissions. Re-run with --apply."

require_cmd databricks
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

ENDPOINT="$(bundle_var serving_endpoint_name)"
load_access_groups

if [[ ${#ACCESS_GROUPS[@]} -eq 0 ]]; then
  note "no customer access groups configured for target $TARGET; endpoint ACL unchanged"
  exit 0
fi

ENDPOINT_JSON="$(databricks serving-endpoints get "$ENDPOINT" --profile "$PROFILE" -o json)" \
  || die "Could not read serving endpoint '$ENDPOINT'."
ENDPOINT_ID="$(printf '%s' "$ENDPOINT_JSON" | python3 -c '
import json, sys
value = str(json.load(sys.stdin).get("id") or "").strip()
if not value:
    raise SystemExit("the endpoint response carried no id")
print(value)
')"

step "Granting the customer access groups CAN_QUERY on $ENDPOINT"
grant_group_acl serving-endpoints "$ENDPOINT_ID" CAN_QUERY "${ACCESS_GROUPS[@]}"
note "verified CAN_QUERY for ${ACCESS_GROUPS[*]}"
