# Player Insights Agent

A Databricks App and MLflow ResponsesAgent for governed player analytics.

Deployed as a Databricks Asset Bundle. `bundle/README.md` is the runbook and is
more detailed than this page; what follows is the shortest path through it.

## Read this before you point Apps at this repo

**Source code path is `player-insights-agent/build/deploy`. Nothing to build first.**
That directory is committed, holds the bundled server and the built client, and has no
`package.json` on purpose, so the platform skips `npm install` and the deploy takes about
15 seconds. Only rebuild it if you change the code: `cd player-insights-agent && npm
install && npm run build:deploy`, then `git add build/deploy` and commit.

**Both of the obvious paths fail without telling you why.** The repo root has no
`app.yaml`. `player-insights-agent/` hangs, because the platform finds a `package.json`
and runs `npm install` across 508 packages with no registry egress.

**Two `app.yaml` files exist and only one is deployable.**
`player-insights-agent/app.yaml` is the source, runs `npm run start`, and is not what
Apps deploys. `player-insights-agent/build/deploy/app.yaml` is the built one, runs the
bundled server, and is the one Apps reads.

## What the workspace needs first

The bundle declares the app, its Unity Catalog schema and volume, and its MLflow
experiment. The release script logs the model and creates the serving endpoint.

**Lakebase and the Genie spaces are attached, not created.** The bundle binds the
app to a Lakebase database that already exists and names Genie spaces that
already exist; it creates, modifies and destroys none of them. Provision those
first, then name them. That is deliberate: they hold state and curation that a
deploy has no business overwriting.

Have these inputs before you start:

- an existing Unity Catalog catalog for the app's own objects;
- the production catalogs or schemas the agent may read;
- **an existing Lakebase project, branch, and database** — create one in the
  Lakebase UI or with `databricks postgres create-project`, then read the ids
  back with `databricks postgres list-projects`. No owner role is needed: that
  was an input to creating a database;
- **two existing Genie spaces**, one for data and one for the data dictionary,
  with their tables already curated. You supply their ids, not their contents.
  `genie/*.reference.yml` contains optional reference instructions;
- an existing SQL warehouse;
- a workspace source path for the committed deploy tree;
- one or more initial app administrator email addresses.

## Deploy

Set the required values in
`.databricks/bundle/customer/variable-overrides.json`:

```json
{
  "app_catalog": "<their_catalog>",
  "app_schema": "<their_app_schema>",
  "data_catalogs": ["<their_data_catalog>", "<their_catalog>.<their_schema>"],
  "warehouse_id": "<their_warehouse_id>",
  "app_source_code_path": "/Workspace/Shared/player-insights-agent-src",
  "lakebase_project_id": "<their_existing_lakebase_project_id>",
  "genie_data_space_id": "<their_data_genie_space_id>",
  "genie_dictionary_space_id": "<their_dictionary_genie_space_id>",
  "admin_emails": "<their_admin@example.com>"
}
```

`lakebase_branch_id` and `lakebase_database_id` default to `production` and
`databricks-postgres`; set them if your instance uses other names.
`app_name` defaults to `player-insights-agent`, and `experiment_path` defaults
to `/Shared/player-insights-agent`; override either when needed.

Validate after saving the file:

```bash
databricks bundle validate -t customer --profile <their-profile>
```

`data_catalogs` is the complete read boundary. A catalog name includes all of
its non-system schemas; `catalog.schema` limits the boundary to one schema.
The app schema is separate and holds only app-owned objects.

**You do not list the Genie spaces' tables.** With `manifest_source=genie` the
model's table manifest — which is what grants the serving principal SELECT — is
read from what the live spaces curate when the model is logged. That same step
refuses to log a model if any curated table falls outside `data_catalogs`, so
discovering the tables instead of typing them does not widen the read boundary.
Adding a table to a Genie space therefore changes the agent's grants, and takes
effect at the next model re-log.

The order matters, because `Apps.Create` refuses an app that names a serving
endpoint which does not exist yet, and it creates nothing when it refuses:

1. `databricks bundle deploy -t customer` with `--select` for every resource
   except the app.
2. `TARGET=customer bundle/agent-release.sh --apply`, which logs the model and
   creates the serving endpoint.
3. `databricks bundle deploy -t customer` again, with no `--select`, which
   creates the app.
4. `TARGET=customer bundle/app-release.sh --apply`, which pushes the app's code.

## How the app gets onto the workspace, and how it is updated

**Initial deploy is the bundle, once.** The four CLI steps above create the app
schema, volume, experiment, registered model, serving endpoint, OAuth scopes,
resource bindings, and app. They attach the existing SQL warehouse, Lakebase
database, and Genie spaces; they do not create those three resources.

**Going forward, app-code updates are manual Deploy from Git onto that existing
app.** UI, server, and other TypeScript in `player-insights-agent/build/deploy`
are pulled from this public repository onto the live app. Deploy from Git does
**not** replace or redo the bundle. It does **not** re-attach resources,
recreate Lakebase, re-log the model, or change OAuth scopes by itself. Most of
the time you are deploying onto an already-live app, not starting greenfield.

**No build first for the customer.** `player-insights-agent/build/deploy/` is
committed and is what you point the platform at: a dependency-free tree holding
an `app.yaml`, the bundled server and the built client, with **no package.json**.
The missing package.json is the point. The platform runs `npm install` whenever
the source it downloads contains one, and a full install of this app's
508-package tree has no registry egress on app compute and hangs. Without one,
the platform logs "No dependencies file found. Skipping installation" and the
deploy takes ~15s. Maintainers rebuild and commit that tree when source changes;
deployers do not.

### Updating an already-deployed app from `main` (the usual path)

Once the app exists from the initial bundle deploy and its resources are
attached, later **app-code** updates come from this public repository — you do
not rebuild anything and you do not touch the rest of the stack.

1. Open the **existing** app's detail page (not Create app).
2. Choose **Deploy → From Git**.
3. Confirm the Git settings (set once; re-check if the UI clears them):

   | Setting | Value |
   |---|---|
   | Repository | `https://github.com/smathews13/player-insights-agent` |
   | Provider | **GitHub** |
   | Branch / reference | **`main`** (Reference type **Branch**) |
   | Source code path | **`player-insights-agent/build/deploy`** |

   Public repository, so no Git credential is required. **Do not leave Source
   code path blank.** Left blank, the platform deploys from the repository root,
   which does not contain `app.yaml`, and the deploy fails ("No command to run
   and no Python file found / Failed to load app spec"). Confirm the path before
   every deploy; the field may not persist when you start a new Deploy from Git
   flow.
4. Click **Deploy**. The app updates when you click Deploy, and only then. Do
   **not** enable `Auto deploy on push events`; updates are a deliberate step,
   not something that follows every push to the public repository.

**What Deploy from Git does.** It replaces the app's source tree
(`player-insights-agent/build/deploy`) and the runtime `app.yaml` that tree
ships with, on top of the existing, working app.

**What Deploy from Git does not do.** It is not a full substitute for the
initial bundle. It does not:

- rerun the asset bundle or recreate catalog / schema / Lakebase / Genie /
  warehouse / serving-endpoint resources
- re-attach resource bindings already configured on the app
- re-log the model or update the serving endpoint's model version
- change OAuth scopes (`user_api_scopes`)

Those stay as the initial bundle (and any later deliberate bundle/app
configuration change) left them. If you detach a resource or drop a scope, no
amount of redeploying from `main` restores it.

**When you still need a bundle redeploy.** Resource bindings, OAuth scopes, and
other app.yaml / bundle-owned settings. A Git deploy alone will not pick those
up.

**When you still need a model / agent release.** Changes to the **agent** (its
Python, its tools, or the model itself) are not app-code and are not picked up
by Deploy from Git. They go through
`TARGET=<target> bundle/agent-release.sh --apply`, which re-logs the model and
updates the serving endpoint. That is a different release on a different cadence.

**Changing the OAuth scopes is not a Git deploy.** The scopes a user consents to
(`user_api_scopes`) are part of the app's bundle/app configuration, not its
source. When the requested scopes change — for example the catalog, workspace
and Vector Search browse scopes are now requested by default so the Connections
page can list and browse — picking them up takes three steps a Deploy-from-Git
does not do: update the app's scope configuration (bundle deploy or `apps
update`), **fully stop and start the app** (a redeploy alone leaves the new scope
inert), and have each user **sign in again in a fresh private window** to grant
the updated consent. Until a user re-consents, their session carries the old
scope set and the new capability stays dark for them.

### Creating the app from Git (only if the bundle already created the backend)

The four CLI steps above remain the supported greenfield path. If the **backend
already exists** — catalog, schema, SQL warehouse, Lakebase, and the **serving
endpoint** (steps 1–2 of the CLI path, which have no browser equivalent) — and
you still need to **create** the app object itself from the UI rather than from
`bundle deploy`, you can: **Apps → Create app → Deploy from Git**, use the same
repository / branch / Source code path table above, **attach** the Lakebase,
serving endpoint and SQL warehouse resources and set the OAuth scopes the app
declares, then Deploy. That is still not "Deploy from Git instead of the
bundle": the resources and scopes must be attached at create time, and later
updates remain the "onto the existing app" flow above.

Then do the two steps below — they apply however the app was first created.

## Release-time grants and one manual share

Neither fails loudly. Skipped, the app returns HTTP 200 and answers are wrong in
a way no error reports.

**The canonical app release grants the app's Postgres role.** The service
principal does not exist until the bundle creates the app, so
`bundle/app-release.sh --apply` runs `bundle/app-db-grant.sh` immediately before
each code deploy. It derives the app role and attached branch/database from the
live app, the schema from the resolved target, `PGUSER` from the profile
identity, and `PGHOST` only from the branch's direct connection. It deliberately
does not try the pooled AppKit hostname, which rejects the operator OAuth login.
A missing direct host, unreachable Postgres, or failed grant stops the release.

The profile identity must hold `DATABRICKS_SUPERUSER` on the Lakebase branch.
After a Lakebase detach/reattach when a full release is unnecessary, use the
same hook manually, then restart the app so it can recreate a dropped AppKit
cache schema as owner:

```bash
TARGET=<target> PROFILE='<profile>' bundle/app-db-grant.sh
databricks apps stop <app-name> --profile '<profile>'
databricks apps start <app-name> --profile '<profile>'
```

That grants the app role on the app data schema, and drops a misowned AppKit
cache schema (`appkit`) so the app recreates and owns it. A bare
`GRANT USAGE, CREATE ON SCHEMA appkit` is not enough: later `CREATE INDEX`
needs table ownership, which Lakebase will not let a developer hand over.
`appkit` holds only framework cache; conversations and settings live elsewhere
and are not dropped. Skipped, storage routes fall back to representative data
and AppKit's persistent cache resets on every restart.

**Share each Genie space with the people or groups who will use the app, at
`CAN RUN`.** With `execution_identity: user-authorization`, Genie runs as the
person who asked, not as the app or serving-endpoint service principal. Those
same callers also need `CAN USE` on the SQL warehouse and `SELECT` on the
curated tables, because Genie's query runs under their grants. Skipped, every
Genie call fails `PermissionDenied` and the agent answers from SQL anyway.

This does not have to be a UI step:

```bash
databricks permissions update genie <space_id> \
  --json '{"access_control_list":[{"user_name":"someone@example.com","permission_level":"CAN_RUN"}]}'
```

Do **not** grant the *serving-endpoint* principal `CAN RUN`: that was the old
passthrough remedy, and under user authorization it grants nothing the caller
needs.

## Who can sign in

Each person using the app needs the `workspace-access` and
`databricks-sql-access` entitlements. Without the second, the OAuth sign-in
fails in a loop rather than saying what is missing. The app's own refusal screen
prints the command that grants them.

## Who can administer it

Administrators see Monitoring, Ops and the settings gear. Every admin route
still refuses consumers with a 403.

The first administrators are named at release time and cannot be appointed from
inside the app. Put the list in the git-ignored
`.databricks/bundle/<target>/variable-overrides.json`, beside `app_catalog` and
`warehouse_id`:

```json
{ "admin_emails": "someone@example.com,someone.else@example.com" }
```

`bundle/app-release.sh` reads it and passes it to the build, which writes it into
the app's `app.yaml`. `PLAYER_INSIGHTS_ADMIN_EMAILS` in the environment you
release from wins over the file. Administrators added later from the settings
gear are stored in Lakebase and are additional to these.

**`admin_emails` is required.** Bundle validation fails when it is unset, and
the release script also refuses an explicitly empty value. Without those
checks, the app would start and refuse every admin surface, including the editor
that appoints someone. There is no way in from the running app; the only fix
would be another release with a value set. The bundle and release script refuse
that self-locking configuration before deployment.

Deploying from Git in the browser bypasses the release, so it produces a
deployment with no administrators. Supply the list yourself in that flow, either
by running `bundle/app-release.sh` once against the same workspace, or by setting
`PLAYER_INSIGHTS_ADMIN_EMAILS` before the build so it lands in the app.yaml the
build writes — your repo, your employees. Do not send it back upstream.

## The semantic layer (optional, off by default)

The semantic layer is a governed index over your schema's metadata: table and
column descriptions, metric and term definitions, approved joins and example
questions. It helps the agent find the right table faster. It indexes metadata,
not measurements, and the agent never answers from it. Every number still comes
from Genie and the guarded SQL path, which run under the caller's grants. The app
works fully without it.

It costs money while it exists. Turning it on creates an AI Search endpoint,
which is charged by the hour whether or not anything queries it, roughly $200 a
month for one left running. Turn it on only if better schema discovery is worth
that to you, and delete the index and then the endpoint when you are done.

By default the bundle creates only a **paused** rebuild job. The endpoint and
index are supplied by variables that default to empty, so
`bundle deploy -t customer` creates no billed AI Search resources until you opt
in. The paused job runs nothing and incurs no compute charge.

To turn it on:

1. Deploy the backing resources and paused rebuild job, then run the job once to
   build the source table. It must exist before a `DELTA_SYNC` index can be
   created over it:

   ```bash
   databricks bundle deploy -t customer
   databricks bundle run player_insights_semantic_rebuild -t customer
   ```

2. Add the endpoint name and the two resource maps to your git-ignored
   `.databricks/bundle/customer/variable-overrides.json`. The index name and its
   source table are built from your `app_catalog` and `app_schema`:

   ```json
   {
     "semantic_index_endpoint": "player-insights-semantic",
     "semantic_index_endpoints": {
       "semantic_endpoint": {
         "name": "${var.semantic_index_endpoint}",
         "endpoint_type": "${var.semantic_index_endpoint_type}"
       }
     },
     "semantic_index_indexes": {
       "semantic_index": {
         "name": "${var.app_catalog}.${var.app_schema}.semantic_layer_index",
         "endpoint_name": "${var.semantic_index_endpoint}",
         "index_type": "DELTA_SYNC",
         "index_subtype": "HYBRID",
         "primary_key": "entry_id",
         "delta_sync_index_spec": {
           "source_table": "${var.app_catalog}.${var.app_schema}.semantic_layer_entries",
           "pipeline_type": "${var.semantic_index_pipeline_type}",
           "embedding_source_columns": [
             { "name": "content", "embedding_model_endpoint_name": "${var.semantic_embedding_endpoint}" }
           ]
         }
       }
     }
   }
   ```

3. Deploy: `databricks bundle deploy -t customer`.

4. Re-log the model so it gains the retrieval tool. The Vector Search scopes are
   baked into the model artifact at log time, so a running model does not gain the
   tool until it is logged again:

   ```bash
   TARGET=customer bundle/agent-release.sh --apply
   ```

   With `semantic_index_endpoint` empty the release logs a model with no retrieval
   tool, which is the off state, so this step is what actually turns the layer on.

The rebuild schedule remains paused after deployment. Each entry records who
could read the source when it was built, which decides whose search results it
appears in. Review the job identity and its first output before unpausing the
schedule; a revoked grant remains discoverable until the next successful build.

## Verifying it actually works

A deployment can be built correctly and still answer everything from canned
data. `bundle/README.md` lists what to establish; the short version is that
`databricks apps get <app-name> -o json` should show both the `postgres` and
`serving-endpoint` resources attached and every declared scope in effect.
