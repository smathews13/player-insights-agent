#!/usr/bin/env bash
# Grant the app's configured customer access groups CAN_USE on the Databricks App.
#
# The App resource in the bundle declares these groups, so a bundle deploy sets
# them. This script is the add-only repair for an App that was created before
# that, or whose ACL was edited by hand: a PATCH, so it adds the groups and
# touches nothing else (the app service principal's CAN_MANAGE self-grant and any
# member added through Identity stay).
#
# The groups are var.app_engineer_group, var.app_exec_group and
# var.app_admin_group; empty ones are skipped, and a target with none (example) is a
# no-op. app-release.sh runs this on every apply. Manual escape hatch:
#
#   TARGET=<target> PROFILE=<profile> bundle/app-user-access.sh --apply

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[[ "${1:-}" == "--apply" ]] || die "This command changes App permissions. Re-run with --apply."

require_cmd databricks
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

APP_NAME="$(bundle_var app_name)"
load_access_groups

if [[ ${#ACCESS_GROUPS[@]} -eq 0 ]]; then
  note "no customer access groups configured for target $TARGET; App ACL unchanged"
  exit 0
fi

step "Granting the customer access groups CAN_USE on $APP_NAME"
grant_group_acl apps "$APP_NAME" CAN_USE "${ACCESS_GROUPS[@]}"
note "verified CAN_USE for ${ACCESS_GROUPS[*]}"
