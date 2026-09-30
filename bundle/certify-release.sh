#!/usr/bin/env bash
# Certify a deployed release, or record a statement about one.
#
# Everything environment-specific is read OUT of the bundle here and handed to
# the runner as arguments, for the reason bundle/_lib.sh states at the top:
# databricks.yml is the one place a value is written down, and a value that
# lives only in somebody's shell drops silently out of the next run.
#
# SHADOW BY DEFAULT, AND SHADOW EXITS 0 WHATEVER IT FINDS. A gate that stops a
# demo because a warehouse was cold is worse than no gate, because the first
# thing anyone does with it is learn the flag that skips it. Run it in shadow
# over several releases, read what it says, remove whatever turns out to be
# flaky, and only then start passing --blocking.
#
# THIS READS. It makes no change to the workspace, so it is safe to run against
# a live deployment at any time, including one somebody is demonstrating.
#
# Usage:
#   TARGET=<your-target> bundle/certify-release.sh
#   TARGET=<your-target> bundle/certify-release.sh --blocking
#   TARGET=prod PROFILE=<prod-profile> bundle/certify-release.sh
#
#   TARGET=<your-target> bundle/certify-release.sh \
#     --attest OAUTH_SCOPE_CONSENT_PROVEN --by you@example.com \
#     --note "signed in at 14:05 after the restart and reached the app"
#
# TARGET has no default. PROFILE is optional for a target that names its profile
# in databricks.yml; every other target must state one.
#
# The certificate is written under .certificates/ at the repository root, which
# is not committed: it names the workspace, the app, the endpoint, the Lakebase
# branch and every table in the manifest. --store <dir> puts it somewhere a team
# can share.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd node

require_target
resolve_profile

APP_DIR="$BUNDLE_ROOT/player-insights-agent"

# The scopes the BUNDLE authors, read out of it rather than listed again. This
# is the same list app-spec.sh sends with replace semantics, so it is the
# contract; a copy here would be a third place the fact is written and the
# second free to drift. An earlier advisory check kept its own copy and passed
# an app that was missing two of them.
AUTHORED_SCOPES="$(bundle_json | python3 -c '
import json, sys
app = json.load(sys.stdin).get("resources", {}).get("apps", {}).get("player_insights_app", {})
print(",".join(app.get("user_api_scopes") or []))
')"

exec node "$APP_DIR/scripts/certify-release.mts" \
  --target "$TARGET" \
  --profile "$PROFILE" \
  --app "$(bundle_var app_name)" \
  --endpoint "$(bundle_var serving_endpoint_name)" \
  --model "$(bundle_var model_name)" \
  --catalog "$(bundle_var app_catalog)" \
  --schema "$(bundle_var app_schema)" \
  --scopes "$AUTHORED_SCOPES" \
  --declared-identity "$(bundle_var execution_identity)" \
  "$@"
