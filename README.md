# Player Insights Agent

A Databricks App and MLflow ResponsesAgent for governed player analytics.

Deployed as a Databricks Asset Bundle. `bundle/README.md` is the runbook and is
more detailed than this page; what follows is the shortest path through it.

## What the workspace needs first

The bundle creates the app, the model, the serving endpoint and the two Genie
spaces. It does not create these, so have them before you start:

- a Unity Catalog catalog and schema for the agent's own objects,
- a SQL warehouse,
- a Lakebase (Postgres) instance, and the project id and owner role id from
  `databricks postgres list-projects` and `databricks postgres list-roles`,
- the tables you want the agent to read, in a catalog it is allowed to see.

## Deploy

Every value below is yours; nothing is guessed for you, and a missing one stops
`validate` rather than resolving to something wrong.

```bash
databricks bundle validate -t customer --profile <your-profile> \
  --var catalog=<catalog> \
  --var schema=<schema> \
  --var warehouse_id=<id> \
  --var app_source_code_path=/Workspace/Shared/player-insights-agent-src \
  --var lakebase_project_id=<project-id> \
  --var lakebase_owner_role_id=<role-id>
```

Put those in `.databricks/bundle/customer/variable-overrides.json` instead of
repeating them, and they apply to every command below.

The order matters, because `Apps.Create` refuses an app that names a serving
endpoint which does not exist yet, and it creates nothing when it refuses:

1. `databricks bundle deploy -t customer` with `--select` for every resource
   except the app.
2. `TARGET=customer bundle/agent-release.sh --apply`, which logs the model and
   creates the serving endpoint.
3. `databricks bundle deploy -t customer` again, with no `--select`, which
   creates the app.
4. `TARGET=customer bundle/app-release.sh --apply`, which pushes the app's code.

## Two steps nothing does for you

Neither fails loudly. Skipped, the app returns HTTP 200 and answers are wrong in
a way no error reports.

**Grant the app's Postgres role**, after step 3, since the app's service
principal does not exist until the app does:

```bash
cd player-insights-agent && node scripts/grant-app-db-access.mjs
```

Skipped, every route answers from representative data rather than yours.

**Share each Genie space with the serving endpoint's principal as `CAN RUN`.**
There is no CLI or bundle resource for this, so it is a UI step. Skipped, every
Genie call fails `PermissionDenied` and the agent answers from SQL anyway.

## Who can sign in

Each person using the app needs the `workspace-access` and
`databricks-sql-access` entitlements. Without the second, the OAuth sign-in
fails in a loop rather than saying what is missing. The app's own refusal screen
prints the command that grants them.

## Verifying it actually works

A deployment can be built correctly and still answer everything from canned
data. `bundle/README.md` lists what to establish; the short version is that
`databricks apps get <app-name> -o json` should show both the `postgres` and
`serving-endpoint` resources attached and every declared scope in effect.
