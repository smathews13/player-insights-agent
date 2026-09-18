#!/usr/bin/env bash
# Grant the app's own service principal CAN_MANAGE on the app, using only the
# resolved bundle target and the live app resource.
#
# WHY THIS EXISTS. The Identity settings members list is drawn from the
# Databricks App ACL, not from the stored PIA roster. The server reads that ACL
# two ways and needs one to succeed: as the signed-in user's forwarded token, or
# as the app's own service principal. The forwarded token is downscoped to the
# app's declared user API scopes (Genie, SQL, model serving, Vector Search) --
# none of which can call the workspace permissions API -- so the ONLY reliable
# reader is the app SP. Reading permissions requires CAN_MANAGE on the object,
# and a bundle-created app does not put its own SP on its ACL. Without this grant
# both reads fail, the server falls back to the stored roster, and any member who
# was added to the App ACL but never given a stored PIA role (the common case for
# a fresh grant) is invisible -- no restart clears it, because it is a permission
# gap, not a cache.
#
# This is called by app-release.sh immediately before every app code deploy,
# beside app-db-grant.sh. It is also the manual escape hatch:
#
#   TARGET=<target> PROFILE=<profile> bundle/app-acl-self-grant.sh
#
# The profile identity must hold CAN_MANAGE on the app (an admin, or a seed
# owner) to change its permissions. The grant is a PATCH: it adds the SP and
# leaves every existing user, group, and inherited entry untouched, so it is
# safe to run on every release and is a no-op once the SP already holds it.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd python3
require_target
resolve_profile

APP_NAME="$(bundle_var app_name)"

step "Resolving app service principal for $APP_NAME"

APP_JSON="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json)" \
  || die "Could not read app '$APP_NAME' with profile '$PROFILE'.
The app must already exist: run databricks bundle deploy -t $TARGET first."

APP_SP="$(printf '%s' "$APP_JSON" | python3 -c '
import json,sys
print(json.load(sys.stdin).get("service_principal_client_id") or "")
')"
[[ -n "$APP_SP" ]] \
  || die "App '$APP_NAME' does not expose a service_principal_client_id.
Run databricks bundle deploy -t $TARGET and confirm the app has been created."

# Already held? Read the live ACL and skip the write when the SP already carries
# a direct CAN_MANAGE. Keeps a re-release a pure no-op and keeps the audit log
# quiet, rather than PATCHing the same grant on every deploy.
ACL_JSON="$(databricks permissions get apps "$APP_NAME" --profile "$PROFILE" -o json)" \
  || die "Could not read the ACL for app '$APP_NAME' with profile '$PROFILE'.
The profile identity must hold CAN_MANAGE on the app to read or change it."

ALREADY_HELD="$(printf '%s' "$ACL_JSON" | python3 -c '
import json,sys
sp=sys.argv[1].lower()
body=json.load(sys.stdin)
for entry in body.get("access_control_list",[]):
    name=str(entry.get("service_principal_name") or "").lower()
    if name!=sp:
        continue
    for perm in entry.get("all_permissions",[]):
        if perm.get("permission_level")=="CAN_MANAGE" and not perm.get("inherited"):
            print("yes")
            raise SystemExit(0)
print("no")
' "$APP_SP")"

note "app            $APP_NAME"
note "profile        $PROFILE"
note "service prin.  $APP_SP"

if [[ "$ALREADY_HELD" == "yes" ]]; then
  note "grant          already held (CAN_MANAGE on itself); nothing to do"
  exit 0
fi

step "Granting the app service principal CAN_MANAGE on itself so it can read its own ACL"
# PATCH, not PUT: databricks permissions update MERGES this entry into the ACL
# and leaves every other principal in place. `set` would REPLACE the whole ACL
# and drop the human members -- never use it here.
databricks permissions update apps "$APP_NAME" --profile "$PROFILE" --json "$(
  printf '{"access_control_list":[{"service_principal_name":"%s","permission_level":"CAN_MANAGE"}]}' "$APP_SP"
)" >/dev/null \
  || die "Could not grant CAN_MANAGE to the app service principal.
The profile identity must hold CAN_MANAGE on '$APP_NAME'. Fix that and re-run:
  TARGET=$TARGET PROFILE=\"$PROFILE\" bundle/app-acl-self-grant.sh"

note "grant          applied. The members list will now read the live App ACL."
