# Astrolabe — Player Insights Agent

A Databricks App and an MLflow `ResponsesAgent` that answer analytical questions
about players from governed data, and show their work. Every number comes from a
live query run under the grants of the person who asked, and every run leaves a
trace anyone can open.

The app ships as a Databricks Asset Bundle. `bundle/README.md` is the operator
runbook and is more detailed than this page; what follows is the shortest path
through it, plus what the thing actually is.

- [What it does](#what-it-does)
- [How an answer is produced](#how-an-answer-is-produced)
- [The shape of an answer](#the-shape-of-an-answer)
- [Runtime settings](#runtime-settings-change-behaviour-without-a-release)
- [The pages](#the-pages)
- [Deploying it: the bundle](#deploying-it-the-bundle)
- [Updating it: Deploy from Git](#updating-it-deploy-from-git)
- [Grants, sharing and sign-in](#release-time-grants-and-one-manual-share)
- [The semantic layer](#the-semantic-layer-optional-off-by-default)

## What it does

Someone asks a question in plain language. The app hands it to an orchestrating
agent on Model Serving, which plans the work, finds and validates the governed
data behind it, and returns a structured answer: a takeaway, a short narrative,
the figures and charts it computed, the tables it read, and the caveats that
apply. The SQL it ran and the full step-by-step trace ship with the answer.

Two properties are the point of the product, and both are enforced rather than
promised:

**Governance is not re-implemented.** The agent reads data as the signed-in
caller, never as its own service principal. Unity Catalog applies that person's
row filters and column masks. A denial is reported as a finding, not routed
around. What the agent may read at all is a table manifest fixed when the model
is logged; the SQL guard refuses anything outside it.

**Nothing is asserted that was not measured.** Figures come from statements the
run actually executed, with per-statement provenance recording what was measured,
over what window, filtered how. Where a question cannot be safely answered, the
run returns a clarification instead of a plausible number.

## How an answer is produced

```text
Browser ──▶ Databricks App ──▶ Orchestrator (Model Serving)
                  │                   │
                  │                   ├──▶ Foundation model
                  │                   ├──▶ Data Source Finder  (optional, in-process)
                  │                   │         ├──▶ Dictionary Genie space
                  │                   │         ├──▶ Data Genie space
                  │                   │         ├──▶ SQL warehouse ──▶ Unity Catalog
                  │                   │         └──▶ Vector Search index  (optional)
                  │                   └──▶ MLflow experiment  (trace)
                  └──▶ Lakebase (Postgres)
```

**The Orchestrator always owns the run.** It is the served model version, and it
plans the answer, decides what to delegate, and writes the final prose.

**The Data Source Finder is a boundary inside that process, not a second
endpoint.** The orchestrator optionally delegates governed discovery to it, as
one self-contained request with a fresh message list and no conversation history.
The finder resolves the table, reads real column metadata before writing SQL,
measures null ratios, states the grain behind every count, and returns an
assessed data package — or a clarification. Because it is invoked rather than
served, it has nothing to probe on the Connections page, and it reports itself as
running in-process.

**Genie answers the metric questions.** Two spaces are attached by id: a data
space for figures, and a dictionary space for what a term or field means. Under
`user-authorization`, Genie runs as the person who asked.

**The warehouse and Unity Catalog are where governance actually happens.** The
warehouse runs generated SQL read-only; the catalog applies the reader's own
grants to every row and column.

**Lakebase (Postgres) is what the deployment keeps.** Conversations, messages,
uploads, feedback, benchmark runs, user roles, and live runtime settings. It is
written as the app serves and is never read to compute an answer.

**The MLflow experiment is the trace.** Tool calls, SQL, timings, token usage,
and which Genie space answered. It is what Run Explorer reads.

**The semantic layer is optional and off by default.** Where a deployment has
one, the finder searches field and metric descriptions to choose what to ask
about. It indexes metadata, never measurements. See
[below](#the-semantic-layer-optional-off-by-default) — it bills by the hour.

## The shape of an answer

Every answer is a structured contract rather than a block of prose, and the same
sections appear on every run:

| Section | What it is |
| --- | --- |
| Takeaway | The single sentence a reader would repeat. |
| Narrative | Short interpretation of the findings. |
| Content | The concrete findings, kept separate from interpretation. |
| Figures | Labelled values with an optional comparison. |
| Charts | Plotly panels, whose kind is derived from the traces rather than declared. |
| Sources | Each table read, and whether it was read for values (`reading`) or for meaning (`reference`). |
| Caveats | Governance, coverage and interpretation limits that apply. |
| Derivation | Per statement: source, metric, window, filter. Parsed from the SQL that ran, never from what the model wrote. |
| SQL | The statements themselves. |
| Trace | Every stage, nested, with its real input and output. |

A turn has three possible outcomes, not one. It can return an **answer**; it can
return a **plan** for approval before doing analytical work; or it can return a
**clarification** — one short, specific question, with the options it found and
the steps it had already taken. A clarification is deliberately not an answer
with a caveat attached: an answer invites a reader to use its figures, and there
are none worth using yet.

Two conventions are worth knowing when reading a stored answer. An empty
derivation field means the statement did not say — not "all time", and not
"unknown". And a source with no role is one recorded before roles existed, so a
reader must say so rather than guess which it was.

## Runtime settings: change behaviour without a release

Administrators can change how the agent runs and how answers are presented from
**Settings**, and the change applies to the next question. These live in
Lakebase, are validated on write, and are handed to the agent as part of each
request. No model re-log, no redeploy.

- **Loop limits** — maximum steps, maximum tool calls, maximum run seconds.
- **Answer sections** — turn takeaway, narrative, charts, figures or caveats on
  or off, and cap how many of each. Turning a section off hides its controls but
  keeps their values, so turning it back on restores what was set.
- **Guidance** — free text handed to the agent alongside the takeaway and the
  narrative it belongs to.
- **Presentation** — how figure cards are ordered, which chart shapes may be
  drawn, how dense the sources list is, and the colours used for catalog, schema,
  table, column, quote and tag mentions in rendered answers.
- **Behaviour** — how readily the agent asks for clarification, the timezone
  relative dates resolve against, and whether today's date is injected.

**What runtime settings cannot do.** They cannot widen what the agent may read.
The catalog allowlist, the table manifest, the system prompts, the guardrails
and the Genie space ids are baked into the MLflow model artifact when the model
is logged. Changing any of those is a deliberate model release, reviewable as
one. That boundary is the reason a settings change is safe to make live.

## The pages

| Page | Who | What it is for |
| --- | --- | --- |
| **Ask** (`/`) | everyone | The conversation. Answers, plans, clarifications, attachments, feedback. |
| **Run Explorer** (`/runs`) | everyone | Every recorded run, and one run's trace read four ways — the answer, the step list, the nested call graph, and the timeline. The timeline is the same component the answer card draws, so the two cannot disagree about a measurement. |
| **Connections** (`/connections`) | everyone | Every dependency this deployment has, what it is configured with, what the running model reports it is actually using, and whether those two disagree. |
| **Architecture** (`/architecture`) | everyone | The same connections as a diagram, with a text equivalent carrying every fact the drawing does. Statuses are the Connections page's own, so a node cannot grade a dependency differently from the row that grades it. |
| **Monitoring** | admins | Usage, latency and failures over time. |
| **Ops** | admins | Serving endpoint, traffic, and operational state. |
| **Settings** | admins | Runtime settings, people and roles, and the deployment's own configuration. |

Admin routes are registered for everyone and refused by every admin API with a
403. Hiding a nav entry and breaking a URL are different decisions; a consumer
who follows an admin's link gets a sentence explaining the refusal rather than a
page of broken panels.

### Connections, and declaring configuration from a notebook

Connections compares two documents. One is what the running model reports about
itself. The other is optional: a declaration a notebook publishes into a table
the app reads, which lets the team that owns the pipeline state what the
deployment is *meant* to be configured with. Each key is badged **In use**,
**Awaiting model version**, **Not applied**, or **Not checked**.

Publishing changes nothing at runtime — that is the design, not a limitation. A
document fetched over the network does not get to widen what an agent may read.
The catalog allowlist is the one key that is permanently **Not applied**: it is
shown for comparison and never adopted. Everything else waits for the next model
release, including a value that would *narrow* the agent's reach, because
narrowing and widening take the same reviewable path.

An administrator who reviews the drift can click **Apply**, which records an
immutable approved request. Executing it is a separate, credentialed step run by
a person, against that exact request id.

To set it up, create a table and point the app at it on the Connections tab:

```sql
CREATE TABLE IF NOT EXISTS <catalog>.<schema>.declarations (
  published_at TIMESTAMP,
  published_by STRING,
  document     STRING
);
```

Publishing appends a row and the app reads the newest, so a notebook run needs
one `INSERT` and no read-modify-write. The app reads the table as the signed-in
user; grant `SELECT` to whoever should see the comparison.

---

## Deploying it: the bundle

Read this before pointing anything at this repository.

**The app source path is `player-insights-agent/build/deploy`. There is nothing
to build first.** That directory is committed and holds the bundled server and
the built client. It deliberately has **no `package.json`**, so the platform logs
"No dependencies file found. Skipping installation" and the deploy takes about
fifteen seconds. Only rebuild it if you change the code:

```bash
cd player-insights-agent && npm install && npm run build:deploy
git add player-insights-agent/build/deploy
```

**Both of the obvious source paths fail quietly.** The repository root has no
`app.yaml`. `player-insights-agent/` hangs, because the platform finds a
`package.json` there and tries to install a 508-package tree with no registry
egress from app compute.

**Two `app.yaml` files exist and only one is deployable.**
`player-insights-agent/app.yaml` is the source one and runs `npm run start`.
`player-insights-agent/build/deploy/app.yaml` is the built one, runs the bundled
server, and is the one the platform reads.

### What the workspace needs first

The bundle declares the app, its Unity Catalog schema and volume, and its MLflow
experiment. The release scripts log the model and create the serving endpoint.

**Lakebase and the Genie spaces are attached, not created.** The bundle binds to
a Lakebase database that already exists and names Genie spaces that already
exist. It creates, modifies and destroys none of them. That is deliberate: they
hold state and curation a deploy has no business overwriting.

Have these before you start:

- an existing Unity Catalog catalog for the app's own objects;
- the production catalogs or schemas the agent may read;
- **an existing Lakebase project, branch, and database** — create one in the
  Lakebase UI or with `databricks postgres create-project`, then read the ids
  back with `databricks postgres list-projects`. No owner role is needed; that
  was an input to creating the database;
- **two existing Genie spaces**, one for data and one for the data dictionary,
  with their tables already curated. You supply their ids, not their contents.
  `genie/*.reference.yml` holds optional reference instructions;
- an existing SQL warehouse;
- a workspace source path for the committed deploy tree;
- one or more initial app administrator email addresses.

### Configure

Set the required values in `.databricks/bundle/customer/variable-overrides.json`,
which is git-ignored:

```json
{
  "app_catalog": "<your_catalog>",
  "app_schema": "<your_app_schema>",
  "data_catalogs": ["<your_data_catalog>", "<your_catalog>.<your_schema>"],
  "warehouse_id": "<your_warehouse_id>",
  "app_source_code_path": "/Workspace/Shared/player-insights-agent-src",
  "lakebase_project_id": "<your_existing_lakebase_project_id>",
  "genie_data_space_id": "<your_data_genie_space_id>",
  "genie_dictionary_space_id": "<your_dictionary_genie_space_id>",
  "admin_emails": "super:<your_admin@example.com>"
}
```

`lakebase_branch_id` and `lakebase_database_id` default to `production` and
`databricks-postgres`; set them if your instance uses other names.
`lakebase_app_schema` defaults to `player_insights`. `app_name` defaults to
`player-insights-agent` and `experiment_path` to `/Shared/player-insights-agent`.
The `super:` prefix lets the first administrator appoint a second one before any
later update.

`data_catalogs` is the complete read boundary. A catalog name includes all of its
non-system schemas; `catalog.schema` limits the boundary to one schema. The app
schema is separate and holds only app-owned objects.

**You do not list the Genie spaces' tables.** With `manifest_source=genie`, the
model's table manifest — which is what grants the serving principal `SELECT` — is
read from what the live spaces curate at the moment the model is logged. That
same step refuses to log a model if any curated table falls outside
`data_catalogs`, so discovering the tables rather than typing them does not widen
the read boundary. Adding a table to a Genie space therefore changes the agent's
grants, and takes effect at the next model re-log.

### Deploy

Three commands, in this order:

```bash
TARGET=customer PROFILE='<your-profile>' bash bundle/deploy.sh
TARGET=customer PROFILE='<your-profile>' bash bundle/agent-release.sh --apply
TARGET=customer PROFILE='<your-profile>' bash bundle/app-release.sh --apply
```

The first runs one complete, interactive `databricks bundle deploy` for the
target, including the App. It does not require a separate `bundle plan`, it never
auto-approves, and it refuses to run against stale local Lakebase state. Read the
change list it prints. The second logs the model and updates the serving
endpoint. The third applies the app's database grants and releases the app code.

**Do not create the App by hand**, exclude it with `--select`, or introduce a
Terraform-engine path as an alternative. The App is bundle-owned.

The deploy preserves existing tags while adding `astrolabe=true` to the attached
Lakebase project and SQL warehouse, and to the AI Search endpoint where one is
configured. The agent release tags the registered model and serving endpoint. AI
Search indexes expose no custom-tag field or patch API, so their billed compute
is attributed through their tagged endpoint.

### Deployment landmines

| Issue | How this process avoids it |
| --- | --- |
| Some CLI versions crash creating an App when an empty `telemetry_export_destinations: []` is rendered | The customer target omits the optional field entirely. The bundle deploy creates the App on the direct engine; Terraform is not offered as an alternative. |
| Old bundle state still *owns* a Lakebase project the current YAML only *attaches* | `bundle/deploy.sh` refuses a local `resources.json` that still tracks `postgres_projects`, `postgres_branches`, or `postgres_databases`. Migrate those entries out of state first, and never pass `--auto-approve`: skipping the change list has destroyed an attached Lakebase project before. |
| A crashed deploy leaves a stale lock | Retry with `--force-lock` only after confirming no deploy is live: set `PIA_CONFIRMED_NO_LIVE_DEPLOY=true` and pass `--force-lock` to the wrapper. Do not make it the normal command. |
| `--select` values passed with spaces | The happy path uses no selection at all. If you are debugging the CLI directly, its selection list is comma-separated. |
| A clean clone has no `node_modules`, so `tsc` exits 127 | `app-release.sh` runs `npm ci` when `node_modules` is absent, before `npm run build:deploy`. |
| An empty schema inside an otherwise usable catalog failed preflight | Empty schemas are skipped. A 90-table ceiling remains a release guard; narrow a large deployment in its git-ignored overrides rather than adding deployment-specific schemas to bundle defaults. |
| A newly created App's compute is `STOPPED` | `app-release.sh` starts compute before its first code deploy. |
| Recreating a deleted App gives it a new service principal, which cannot own the old app schema | Preserve the old data and set `lakebase_app_schema` to a new, unused schema before deploying. The new app creates and owns it on first start. The ownership gate refuses the old schema rather than trying to steal it; move data deliberately afterwards rather than dropping a schema to get past the gate. |
| The Lakebase binding id is `databricks-postgres` while the live PostgreSQL database is named `databricks_postgres` | Leave the binding id alone. The grant step resolves the live name from Lakebase before connecting. |
| First on-behalf-of request returns HTTP 400 `Unable to authenticate using user_credentials` | Treat it as consent and session state: restart the app after a scope change and have the user sign in again. Repeating the bundle deploy does not repair an old token. |
| Additional users cannot run the Genie spaces | Grant every user or group `CAN RUN` on both spaces. No identities are hardcoded anywhere. |
| A restored Lakebase project keeps billing | Inventory and delete the orphan explicitly. This is recovery cleanup, not part of a normal deploy. |

## Updating it: Deploy from Git

**Run the bundle bootstrap above once first.** It creates the app schema, volume,
experiment, registered model, serving endpoint, OAuth scopes, resource bindings,
and the app itself, and attaches the existing warehouse, Lakebase database and
Genie spaces. Do not start the Git flow before the bundle has created the app and
`bundle/app-release.sh` has applied its grants and first code release.

After that, **app-code updates are Deploy from Git onto the existing app**, and
that is the usual path. UI, server and other TypeScript in
`player-insights-agent/build/deploy` are pulled from this repository onto the
live app.

1. Open the **existing** app's detail page — not Create app.
2. Choose **Deploy → From Git**.
3. Confirm the Git settings. Set once; re-check them, because the UI can clear
   the path when you start a new flow.

   | Setting | Value |
   | --- | --- |
   | Repository | `https://github.com/smathews13/player-insights-agent` |
   | Provider | **GitHub** |
   | Branch / reference | **`main`** (reference type **Branch**) |
   | Source code path | **`player-insights-agent/build/deploy`** |

4. Click **Deploy**. The app updates then, and only then. Do **not** enable
   *Auto deploy on push events*; an update is a deliberate step.

**Do not leave Source code path blank.** Left blank, the platform deploys from
the repository root, which has no `app.yaml`, and the deploy fails with "No
command to run and no Python file found / Failed to load app spec".

The repository is public, so no Git credential is required.

### What a Git deploy does not do

This is the important half. A Git update is **code only**. It replaces the app's
deployed code snapshot, including the runtime `app.yaml` in that folder, and
nothing else. It does **not**:

- rerun the asset bundle, or create, update, detach or reconnect any resource —
  catalog, schema, Lakebase, Genie, warehouse, job, model or serving endpoint;
- re-attach resource bindings already configured on the app;
- re-log the model or move the serving endpoint to a new model version;
- change OAuth scopes (`user_api_scopes`);
- add, remove, promote or demote anybody.

Do not run `databricks bundle deploy`, `bundle/agent-release.sh`, or
`bundle/app-release.sh` as part of a Git update. None of them is part of it.

**Roles survive every code deploy.** Lakebase is the runtime source of truth for
super-admin, admin and consumer roles. Deployment configuration can seed the
first rows only while the roster is genuinely empty. Once any row exists, the app
ignores `PLAYER_INSIGHTS_ADMIN_EMAILS` entirely: a stale, different or empty
committed `app.yaml` cannot change anyone's role. Only an explicit action in
Settings → People and roles does. This is why the public snapshot carries no
addresses, and why that absence is harmless.

### When you still need something else

**A bundle redeploy** — only for resource bindings, OAuth scopes, and other
bundle-owned app configuration. Do not rerun the bundle merely to ship UI or
server code: reconciling the app resource can also remove bindings that exist
only as manual workspace changes.

**A model release** — changes to the agent's Python, its tools, its prompts or
the model itself are not app code and are not picked up by a Git deploy. They go
through `TARGET=<target> bundle/agent-release.sh --apply`, on its own cadence.

**A scope change is three steps, and a Git deploy is none of them.** Update the
app's scope configuration, **fully stop and start the app** (a redeploy alone
leaves a new scope inert), and have each user sign in again in a fresh private
window to grant the updated consent. Until a user re-consents, their session
carries the old scope set and the new capability stays dark for them.

## Release-time grants and one manual share

Neither of these fails loudly. Skipped, the app returns HTTP 200 and answers are
wrong in a way no error reports.

**The app-release path grants the app's Postgres role.** The service principal
does not exist until the bundle creates the app, so `bundle/app-release.sh
--apply` runs `bundle/app-db-grant.sh` before its own code deploy. It derives the
app role and attached branch and database from the live app, the schema from the
resolved target, `PGUSER` from the profile identity, and `PGHOST` only from the
branch's direct connection — deliberately not the pooled hostname, which rejects
the operator login. A missing direct host, unreachable Postgres, or failed grant
stops the release. The profile identity must hold `DATABRICKS_SUPERUSER` on the
Lakebase branch.

After a Lakebase detach and reattach, when a full release is unnecessary:

```bash
TARGET=<target> PROFILE='<profile>' bundle/app-db-grant.sh
databricks apps stop <app-name> --profile '<profile>'
databricks apps start <app-name> --profile '<profile>'
```

That grants the app role on the app data schema and drops a misowned framework
cache schema (`appkit`) so the app recreates and owns it. A bare
`GRANT USAGE, CREATE ON SCHEMA appkit` is not enough, because later
`CREATE INDEX` needs table ownership. `appkit` holds only framework cache;
conversations and settings live elsewhere and are not touched. Skipped, storage
routes fall back to representative data and the cache resets on every restart.

**Share each Genie space at `CAN RUN` with the people or groups who will use the
app.** Under `execution_identity: user-authorization`, Genie runs as the person
who asked. Those same callers also need `CAN USE` on the SQL warehouse and
`SELECT` on the curated tables. Skipped, every Genie call fails
`PermissionDenied` and the agent answers from SQL anyway.

```bash
databricks permissions update genie <space_id> \
  --json '{"access_control_list":[{"user_name":"someone@example.com","permission_level":"CAN_RUN"}]}'
```

Do **not** grant the *serving-endpoint* principal `CAN RUN`. That was the old
passthrough remedy; under user authorization it grants nothing the caller needs.

## Who can sign in, and who can administer

Each person needs the `workspace-access` and `databricks-sql-access`
entitlements. Without the second, OAuth sign-in fails in a loop rather than
saying what is missing; the app's refusal screen prints the command that grants
them.

Administrators see Monitoring, Ops and the settings gear. The first ones are
named at release time in the git-ignored
`.databricks/bundle/<target>/variable-overrides.json`:

```json
{ "admin_emails": "super:someone@example.com" }
```

`bundle/app-release.sh` reads it and writes it into the app's `app.yaml`.
`PLAYER_INSIGHTS_ADMIN_EMAILS` in the release environment wins over the file. On
a genuinely empty roster, app boot inserts those first roles into Lakebase once;
after that, Lakebase is the only runtime authority.

**`admin_emails` is required.** Bundle validation fails when it is unset, and the
release script refuses an explicitly empty value. Without those checks the app
would start and refuse every admin surface — including the editor that appoints
someone — and the only way out would be another release. That self-locking
configuration is rejected before deployment rather than after.

## The semantic layer (optional, off by default)

A governed index over your schema's metadata: table and column descriptions,
metric and term definitions, approved joins, example questions. It helps the
agent find the right table faster. It indexes metadata, not measurements, and the
agent never answers from it — every number still comes from Genie and the guarded
SQL path, under the caller's grants. The app works fully without it.

**It costs money while it exists.** Turning it on creates an AI Search endpoint,
billed by the hour whether or not anything queries it — roughly $200 a month for
one left running. Turn it on only if better schema discovery is worth that, and
delete the index and then the endpoint when you are done.

By default the bundle creates only a **paused** rebuild job. The endpoint and
index come from variables that default to empty, so a deploy creates no billed AI
Search resources until you opt in.

1. Deploy the backing resources and paused job, then run the job once to build
   the source table. It must exist before a `DELTA_SYNC` index can be created
   over it:

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

3. Deploy again: `databricks bundle deploy -t customer`.

4. Re-log the model so it gains the retrieval tool. The Vector Search scopes are
   baked into the model artifact at log time, so a running model does not gain
   the tool until it is logged again:

   ```bash
   TARGET=customer bundle/agent-release.sh --apply
   ```

   With `semantic_index_endpoint` empty, the release logs a model with no
   retrieval tool, which is the off state. This step is what actually turns the
   layer on.

The rebuild schedule stays paused after deployment. Each entry records who could
read the source when it was built, which decides whose search results it appears
in. Review the job identity and its first output before unpausing; a revoked
grant remains discoverable until the next successful build.

The Architecture page draws the index and its endpoint as two cards, because they
fail separately and bill separately. An index can be present and refused on an
endpoint that is perfectly healthy.

## Verifying it actually works

A deployment can be built correctly and still answer everything from
representative data. `bundle/README.md` lists what to establish. The short
version:

```bash
databricks apps get <app-name> -o json
```

should show both the `postgres` and `serving-endpoint` resources attached, and
every declared scope in effect. Then open **Connections** in the app: it probes
each dependency and reports what the running model says it is actually using,
which is the difference between a deployment that is configured and one that
works.
