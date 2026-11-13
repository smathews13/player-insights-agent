#!/usr/bin/env bash
# Grant the app's customer access groups what a question needs beyond Unity
# Catalog: CAN_USE on the SQL warehouse and CAN_RUN on each Genie space.
#
# Questions run with the signed-in user's token, so a user whose group lacks
# either grant is refused even when their table grants are right. Same groups
# as bundle/app-user-access.sh and bundle/endpoint-user-access.sh (which grants
# the endpoint's CAN_QUERY). PATCH only: other grants are left as they are, so
# a workspace-wide grant on a shared warehouse or space is reported by
# bundle/security-posture.sh rather than removed here. A target with no groups
# (example) is a no-op.
#
#   TARGET=<target> PROFILE=<profile> bundle/gate3-access.sh --apply

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[[ "${1:-}" == "--apply" ]] || die "This command changes warehouse and Genie permissions. Re-run with --apply."

require_cmd databricks
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

load_access_groups
if [[ ${#ACCESS_GROUPS[@]} -eq 0 ]]; then
  note "no customer access groups configured for target $TARGET; warehouse and Genie ACLs unchanged"
  exit 0
fi

WAREHOUSE="$(bundle_var warehouse_id)"
DATA_SPACE="$(bundle_var_or_empty genie_data_space_id)"
DICTIONARY_SPACE="$(bundle_var_or_empty genie_dictionary_space_id)"

step "Granting the customer access groups CAN_USE on warehouse $WAREHOUSE"
grant_group_acl warehouses "$WAREHOUSE" CAN_USE "${ACCESS_GROUPS[@]}"
note "verified CAN_USE for ${ACCESS_GROUPS[*]}"

for SPACE in "$DATA_SPACE" "$DICTIONARY_SPACE"; do
  [[ -n "$SPACE" ]] || continue
  step "Granting the customer access groups CAN_RUN on Genie space $SPACE"
  grant_group_acl genie "$SPACE" CAN_RUN "${ACCESS_GROUPS[@]}"
  note "verified CAN_RUN for ${ACCESS_GROUPS[*]}"
done
