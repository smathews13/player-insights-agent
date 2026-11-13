# Runbook: account-level groups

PIA grants access to groups only. Those groups must be **account-level** groups
synced from the identity provider (Entra ID), not groups created inside one
workspace. A workspace-local group cannot be granted in Unity Catalog across
workspaces, is not changed by the identity provider, and drifts from it.

This runbook needs an account admin and the identity team. Nothing in PIA can
do it for you; `bundle/security-posture.sh` tells you when it is done.

## The groups

| Bundle variable | Purpose | In-app role |
|---|---|---|
| `app_engineer_group` | Engineers who ask questions | Consumer |
| `app_exec_group` | Executives who ask questions | Consumer |
| `app_admin_group` | App administrators | Admin |
| `app_super_admin_group` | Identity and persona owners, at least two people | Super admin |
| `app_manager_group` | Platform team that can redeploy or stop the app | none (App `CAN_MANAGE`) |
| Label data groups | One per label, plus the all-labels group | none (Unity Catalog grants) |

Each name goes in `.databricks/bundle/<target>/variable-overrides.json`. The
label groups go in the label access config (`bundle/label-access.example.json`).

## Steps

1. **Check provisioning.** In the account console, open *User management →
   Provisioning*. Account-level SCIM or automatic identity management should be
   on. If only workspace-level SCIM is used, plan the move with the identity
   team first; do not delete workspace groups until every grant is re-pointed.
2. **Create or sync the account groups** with exactly the names the identity
   provider uses.
3. **Assign them to each PIA workspace** (*Workspaces → <workspace> →
   Permissions*, role **User**).
4. **Re-point grants.** Run the release (`bundle/app-release.sh --apply`) so the
   App, endpoint and experiment grants name the account groups, then
   `bundle/label-access.sh --apply` for the Unity Catalog label grants.
5. **Remove individual grants** and workspace-local duplicates from the App,
   endpoint, warehouse, Genie spaces and catalogs.
6. **Verify:**

   ```bash
   TARGET=<target> PROFILE=<profile> bash bundle/security-posture.sh
   ```

   Every `groups` line must read "is an account-level group". Then add a test
   user to one group in the identity provider and confirm they can open the app
   within the sync window with no Databricks step.

## Done when

- `databricks account groups list` shows every PIA group as externally synced.
- `SHOW GRANTS` on each PIA catalog lists only account groups and the owner.
- `bundle/security-posture.sh` has no `groups` or `app` failures.
