#!/usr/bin/env bash
# Read-only report of who can reach this deployment: account-level groups, the
# App ACL, endpoint, warehouse, Genie spaces, the MLflow experiment and the
# endpoint's request log. See bundle/security_posture.py for each rule.
#
#   TARGET=<target> PROFILE=<profile> bundle/security-posture.sh
#
# Exit 0 when everything passes, 1 on a finding, 2 when a check could not run.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

load_access_groups
CONFIG="$(mktemp "${TMPDIR:-/tmp}/pia-posture.XXXXXX")"
on_exit "rm -f '$CONFIG'"

# One assignment each: a failed read inside an env-prefix list would not stop
# the script, and an empty value would read as "nothing configured".
APP="$(bundle_var app_name)"
ENDPOINT="$(bundle_var serving_endpoint_name)"
WAREHOUSE="$(bundle_var warehouse_id)"
EXPERIMENT="$(bundle_var_or_empty experiment_path)"
DATA_SPACE="$(bundle_var_or_empty genie_data_space_id)"
DICTIONARY_SPACE="$(bundle_var_or_empty genie_dictionary_space_id)"
MANAGER="$(bundle_var_or_empty app_manager_group)"
SUPER="$(bundle_var_or_empty app_super_admin_group)"
export APP ENDPOINT WAREHOUSE EXPERIMENT MANAGER SUPER
export SPACES="$DATA_SPACE,$DICTIONARY_SPACE"
python3 - ${ACCESS_GROUPS[@]+"${ACCESS_GROUPS[@]}"} > "$CONFIG" <<'PY'
import json, os, sys

split = lambda name: [v for v in os.environ[name].split(",") if v]
print(json.dumps({
    "app": os.environ["APP"],
    "endpoint": os.environ["ENDPOINT"],
    "warehouse_id": os.environ["WAREHOUSE"],
    "experiment_path": os.environ["EXPERIMENT"],
    "genie_spaces": split("SPACES"),
    "groups": sys.argv[1:],
    "manager_group": os.environ["MANAGER"],
    "super_admin_group": os.environ["SUPER"],
}))
PY

step "Access posture for $TARGET"
python3 "$(dirname "${BASH_SOURCE[0]}")/security_posture.py" --config "$CONFIG" --profile "$PROFILE"
