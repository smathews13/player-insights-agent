#!/usr/bin/env bash
# The reviewed release manifest against Unity Catalog grants and the Genie
# spaces, in both directions. See bundle/manifest_drift.py for each rule.
#
#   RELEASE_MANIFEST=<file> TARGET=<target> PROFILE=<profile> bash bundle/manifest-drift.sh
#
# The manifest file is {"tables": ["catalog.schema.table", ...]} and may add
# "groups" to check instead of the target's access groups (label data groups,
# for example). It is deployment data: keep it in the private config repository
# with data governance as a required reviewer, not in this repository.
#
# Exit 0 on no drift, 1 on drift, 2 when a check could not run.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd python3
require_target
resolve_profile
[[ -n "${RELEASE_MANIFEST:-}" ]] || die "RELEASE_MANIFEST is not set. Point it at the reviewed manifest file."
[[ -f "$RELEASE_MANIFEST" ]] || die "No release manifest at $RELEASE_MANIFEST."
seed_bundle_cache

load_access_groups
CONFIG="$(mktemp "${TMPDIR:-/tmp}/pia-manifest.XXXXXX")"
on_exit "rm -f '$CONFIG'"

DATA_SPACE="$(bundle_var_or_empty genie_data_space_id)"
DICTIONARY_SPACE="$(bundle_var_or_empty genie_dictionary_space_id)"
SCHEMAS="$(bundle_data_schema_scopes)"
export SPACES="$DATA_SPACE,$DICTIONARY_SPACE" SCHEMAS="${SCHEMAS//$'\n'/,}" RELEASE_MANIFEST
python3 - ${ACCESS_GROUPS[@]+"${ACCESS_GROUPS[@]}"} > "$CONFIG" <<'PY'
import json, os, sys

split = lambda name: [v for v in os.environ[name].split(",") if v]
manifest = json.load(open(os.environ["RELEASE_MANIFEST"]))
print(json.dumps({
    "manifest": manifest.get("tables") or [],
    "groups": manifest.get("groups") or sys.argv[1:],
    "data_schemas": split("SCHEMAS"),
    "genie_spaces": split("SPACES"),
}))
PY

step "Release manifest drift for $TARGET"
python3 "$(dirname "${BASH_SOURCE[0]}")/manifest_drift.py" --config "$CONFIG" --profile "$PROFILE"
