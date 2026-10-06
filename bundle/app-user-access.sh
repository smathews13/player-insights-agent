#!/usr/bin/env bash
# Grant the app's configured customer access groups CAN_USE on the Databricks App.
#
# A PATCH rather than a `permissions:` block on the bundle resource, on purpose:
# a bundle-declared ACL is authoritative, so every `bundle deploy` would replace
# the whole App ACL and strip the app service principal's CAN_MANAGE
# self-grant (bundle/app-acl-self-grant.sh) plus every member added through
# Identity or the workspace UI. This adds the groups and touches nothing else.
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
