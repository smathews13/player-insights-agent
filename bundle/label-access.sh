#!/usr/bin/env bash
# Grant, and prove, one data group per label in Unity Catalog.
#
#   LABEL_ACCESS_CONFIG=<file> TARGET=<target> [PROFILE=<profile>] bash bundle/label-access.sh [--apply|--verify|--export]
#
# With no flag it prints the plan: the grants it would add, the row-filter SQL
# for each cross-label master table, and the access matrix. Nothing is changed.
# --export prints the current owners and grants for review with data governance.
#
# --apply adds the grants (add-only; no existing privilege is revoked), creates
# each master table's row-filter function, attaches it, then runs --verify.
#
# --verify reads EFFECTIVE privileges, so a grant inherited from a catalog or
# another group counts. It fails when:
#   * a label group lacks USE CATALOG, USE SCHEMA or SELECT on its own schemas
#     or the shared schemas;
#   * a label group can read another label's schema;
#   * a master table readable by label groups has no row filter, or one only
#     central should read is readable by a label group;
#   * a label's schemas are outside the target's agent read scope
#     (var.data_catalogs), which is how a label silently drops out of answers;
#   * an identity in no_data_principals (the app's and the agent's own) can read
#     label data, which PIA only ever reads as the signed-in person;
#   * a person rather than a group owns a label catalog or schema, or, with
#     require_workspace_binding, a label catalog is open to every workspace.
#
# The work is done by the Genie Code skill's module, through the Databricks CLI
# here, so the shell and Genie Code apply and check exactly the same plan.
#
# The config is customer data and is not committed. See
# label-access.example.json for its shape. `group_check` defaults to
# is_account_group_member, which is right for groups synced from Entra ID.
# Unity Catalog cannot grant to workspace-local groups, so a test without
# account groups names service principals and uses current_user.
source "$(dirname "$0")/_lib.sh"

MODE=plan
case "${1:-}" in
  "") ;;
  --apply) MODE=apply ;;
  --verify) MODE=verify ;;
  --export) MODE=export ;;
  *) die "Unknown option '${1}'. Use --apply, --verify, --export, or nothing for the plan." ;;
esac

require_cmd databricks
require_cmd python3
[[ -n "${LABEL_ACCESS_CONFIG:-}" ]] || die "LABEL_ACCESS_CONFIG is not set. Copy bundle/label-access.example.json, fill it in, and point at it."
[[ -f "$LABEL_ACCESS_CONFIG" ]] || die "No label access config at $LABEL_ACCESS_CONFIG."
resolve_profile
load_bundle_json
SCOPE_JSON="$(bundle_var_json data_catalogs)"
WAREHOUSE_ID="${WAREHOUSE_ID:-$(bundle_var_or_empty warehouse_id)}"
LABEL_ACCESS_PY="$(cd "$(dirname "$0")/.." && pwd)/genie/skills/label-access/scripts/label_access.py"

args=(--config "$LABEL_ACCESS_CONFIG" --scope-json "${SCOPE_JSON:-[]}" --profile "$PROFILE")
case "$MODE" in
  plan) ;;
  apply)
    [[ -n "$WAREHOUSE_ID" ]] || die "No warehouse to run the row-filter SQL on. Set WAREHOUSE_ID."
    args+=(--apply --warehouse-id "$WAREHOUSE_ID") ;;
  *) args+=("--$MODE") ;;
esac
python3 "$LABEL_ACCESS_PY" "${args[@]}" || die "Label access $MODE did not pass; see above."
