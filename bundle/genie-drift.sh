#!/usr/bin/env bash
# Compare committed Genie reference content with the existing live spaces.
# This command is read-only and does not create or update a Genie space.
#
# Usage:
#   TARGET=<your-target> bundle/genie-drift.sh
#
# TARGET has no default. PROFILE is optional for a target that names its profile
# in databricks.yml; every other target must state one.
#
# Exit status:
#   0  in sync: a deploy would change nothing
#   1  drifted: what is committed is not what is running
#   2  at least one space could not be read, so nothing was established

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd python3

require_target
resolve_profile

# Use the same existing-space inputs as agent-release.sh. Environment values may
# override the required bundle variables for a one-off check.
if [[ -n "${PLAYER_INSIGHTS_DATA_GENIE_ID:-}" ]]; then
  DATA_ID="$PLAYER_INSIGHTS_DATA_GENIE_ID"
else
  DATA_ID="$(bundle_var genie_data_space_id)"
fi
if [[ -n "${PLAYER_INSIGHTS_DICTIONARY_GENIE_ID:-}" ]]; then
  DICT_ID="$PLAYER_INSIGHTS_DICTIONARY_GENIE_ID"
else
  DICT_ID="$(bundle_var genie_dictionary_space_id)"
fi

step "Genie content: this repository vs. the live workspace (target: $TARGET)"

bundle_json | python3 "$BUNDLE_ROOT/bundle/genie-drift-check.py" \
  --profile "$PROFILE" \
  --space "data genie space      " data_genie_space       "$DATA_ID" \
  --space "dictionary genie space" dictionary_genie_space "$DICT_ID"
