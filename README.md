<!-- markdownlint-disable MD033 -->
<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/pia-dpad-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/pia-dpad.svg">
    <img src="assets/pia-dpad.svg" alt="Player Insights Agent logo" width="112">
  </picture>
  <br>
  <h1>Player Insights Agent</h1>
</div>
<!-- markdownlint-enable MD033 -->

[![Experimental](https://img.shields.io/badge/status-Experimental-F59E0B?style=flat-square)](#experimental-status-and-limitations)
[![Deploy to Databricks](https://img.shields.io/badge/Deploy%20to-Databricks-FF3621?style=flat-square&logo=databricks&logoColor=white)](#install-and-deploy)

> **⚠️ Not Official Databricks Software**
> This application is built and maintained by the Databricks field engineering team and is **not an official Databricks product**. It is not covered by Databricks Support SLAs. Your Databricks account team can help you deploy, configure, and troubleshoot this app as part of your engagement.

Player Insights Agent is a governed analytics assistant for Databricks. A user
asks a question in plain language; Player Insights Agent finds approved data,
runs live queries, and returns an answer with figures, sources, SQL, caveats,
and an MLflow trace.
It is designed for analytical use cases where readers need to inspect how an
answer was produced, not just read generated prose.

See the [API access guide](API_ACCESS.md) for the differences between
Apps-hosted agent `/responses`, custom Databricks App `/api` routes, the
Databricks OpenAI Client, and Model Serving `ai_query()`. It also states which
Player Insights Agent surfaces are supported today.

## Capabilities

- Natural-language analytics backed by Databricks Genie and guarded SQL.
- Structured answers with takeaways, findings, figures, charts, source tables,
  derivations, caveats, and executed SQL.
- Plans and clarification questions when a safe answer cannot yet be produced.
- Run Explorer views for answer steps, nested calls, timing, and MLflow traces.
- Connections and Architecture views that show configured and observed
  dependencies.
- Administrator views for monitoring, endpoint operations, runtime settings,
  and application roles.
- An Identity screen that lists groups, people, and service principals, with
  persona assignments and their history.
- Conversation deletion, erasure on request, and optional retention.

## Architecture

```text
User
  │
  ▼
Databricks App ───────────────▶ Lakebase
  │                            conversations, settings, roles, persona history
  ▼
Model Serving endpoint ───────▶ MLflow experiment
  │                            redacted traces and run metadata
  ├──▶ AI Gateway ────────────▶ Foundation model
  ├──▶ Genie spaces
  └──▶ SQL warehouse ─────────▶ Unity Catalog data
```

Every question runs with the signed-in person's own token, from the app through
the endpoint to Genie and the warehouse.

The Databricks Declarative Automation Bundle creates the application-owned Unity Catalog
objects, App resources, and supporting job definitions. It adopts the existing
MLflow experiment for Dev and attaches to, rather than creates or owns, the SQL
warehouse, Lakebase database, Genie spaces, and registered model.

## Access model

Three independent gates decide what a person can do. Passing one never opens
the next.

| Gate            | Decides                                                  | Set by                                                                                                                            |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1. Open the app | `CAN_USE` on the Databricks App                          | Membership of the Engineer, Exec, or Admin access group                                                                           |
| 2. In-app role  | Screens and admin tools: Consumer, Admin, or Super admin | The access groups and the Super admin group                                                                                       |
| 3. Data         | Which rows and columns a question can read               | The person's own Unity Catalog grants, row filters, and masks, plus `CAN_USE` on the warehouse and `CAN_RUN` on both Genie spaces |

- **Roles come from groups.** Engineer and Exec group members are Consumers,
  Admin group members are at least Admins, and Super admin group members are
  Super admins. The app reads each person's groups from their own directory
  record with their own token; if that read fails, no group role applies. Use
  account-level groups, and keep the Super admin group small (at least two
  people).
- **Roles never widen data.** Every question runs as the signed-in person, so
  an Admin sees no more data than they would in a notebook.
- **Personas are the one exception, and they are recorded.** Only a Super admin
  can assign a person a service-principal persona, whose grants that person's
  questions then use. Every assignment change and every question asked under a
  persona is logged in Lakebase, and each such answer carries a persona banner.
  Super admins always run as themselves.
- **The release grants the groups what a question needs.**
  `bundle/app-release.sh` grants the access groups `CAN_USE` on the app and the
  warehouse and `CAN_RUN` on both Genie spaces. It only adds: a group that
  already holds more is left as it is. The optional `app_manager_group` holds
  `CAN_MANAGE` on the app.
- **`admin_emails` names the first administrators** (prefix `super:` to pin a
  Super admin), so the app has an owner before any group is configured.

## Prerequisites

You need:

- a Databricks workspace with Apps, Model Serving, Unity Catalog, MLflow, Genie,
  Lakebase, and a Pro or Serverless SQL warehouse available;
- Node.js/npm, Python 3, `uv`, and the Databricks CLI authenticated to that workspace;
- an existing Unity Catalog catalog for Player Insights Agent-owned objects;
- one or more catalogs or schemas containing the governed data Player Insights Agent may
  read;
- an existing Lakebase project/branch and the full resource path of a role that
  may own databases there; the deploy creates separate `pia-dev` and `pia-prod`
  databases because AppKit Apps must not share one Postgres database;
- two curated Genie spaces: one for analytical data and one for data
  definitions;
- an existing registered model with at least two consecutive READY versions,
  plus the existing MLflow experiment those versions use;
- account-level groups for Engineer, Exec, and Admin access, a Super admin group
  of at least two people, and one initial administrator email address; and
- permissions to deploy bundles, apps, models, and serving endpoints and to
  grant the required data access.

Users get app, warehouse, and Genie access through their access group. Each
person also needs workspace access, Databricks SQL access, and `SELECT` on the
data they are expected to query.

## Install and deploy

Clone the public repository and authenticate:

```bash
git clone https://github.com/smathews13/player-insights-agent.git
cd player-insights-agent
databricks auth login --profile "<profile>"
```

Copy the committed customer template into separate git-ignored paths for
development and production, then replace every placeholder independently:

```bash
mkdir -p .databricks/bundle/dev .databricks/bundle/prod
cp bundle/customer-variable-overrides.example.json \
  .databricks/bundle/dev/variable-overrides.json
cp bundle/customer-variable-overrides.example.json \
  .databricks/bundle/prod/variable-overrides.json
```

Each resulting `variable-overrides.json` contains:

```json
{
  "app_catalog": "<your_catalog>",
  "app_schema": "player_insights_agent",
  "data_catalogs": ["<data_catalog>", "<data_catalog>.<restricted_schema>"],
  "warehouse_id": "<sql_warehouse_id>",
  "experiment_path": "<existing_shared_mlflow_experiment_path>",
  "lakebase_project_id": "<lakebase_project_id>",
  "lakebase_branch_id": "production",
  "lakebase_database_owner_role": "projects/<project-id>/branches/production/roles/<owner-role-id>",
  "genie_data_space_id": "<data_genie_space_id>",
  "genie_dictionary_space_id": "<dictionary_genie_space_id>",
  "admin_emails": "super:<initial_admin@example.com>",
  "app_engineer_group": "<engineer_access_group>",
  "app_exec_group": "<executive_access_group>",
  "app_admin_group": "<admin_access_group>",
  "app_manager_group": "<platform_admin_group>",
  "app_super_admin_group": "<super_admin_group>"
}
```

Before a model release, also set `cross_label_key_columns` to the column that
links one player across labels, and `identity_columns` to any other columns
that identify a person. Both add to the built-in names the SQL guard and trace
redaction already cover.

Use the same existing `experiment_path` in both files. Dev and Prod have
separate Apps and endpoints but intentionally share one MLflow experiment.
The release refuses to create a replacement experiment.

Do not add `lakebase_app_schema` to both files: target defaults isolate App
state as `pia_dev` and `pia_prod`.
Target defaults also bind Dev to database `pia-dev` and Prod to `pia-prod`;
`bundle/deploy.sh` creates either database when it is missing.
Target defaults also provide distinct validated workspace staging paths ending
in `player-insights-agent-dev-src` and `player-insights-agent-prod-src`.

This ignored file is the supported persistent configuration for one local
checkout. Databricks Bundle commands resolve variables in this order, highest
precedence first: `--var`, `BUNDLE_VAR_*`,
`.databricks/bundle/<target>/variable-overrides.json`, target variables, then
tracked defaults. `git pull`, branch checkout, bundle validation, and the
release scripts do not rewrite the ignored file.

Git cannot carry local state to a different checkout. A fresh `git clone` does
not contain this file, so copy it securely from the prior checkout or recreate
it before validating or deploying. Shell environment variables are one-run
overrides only and do not survive a new terminal, clone, or machine.

`data_catalogs` is the deployment's complete Unity Catalog read boundary. A
catalog entry permits discovery within its non-system schemas; a
`catalog.schema` entry narrows that boundary to one schema. Review this list
before every model release.

Run the three deployment stages in order. Dev and Prod intentionally share one
workspace profile because they reuse the same model, experiment, warehouse,
catalog/schema, Genie spaces, and Lakebase database:
The target defaults create `player-insights-agent-dev` and
`player-insights-agent-prod` with separate serving endpoints and Lakebase app
schemas. Both use the existing shared MLflow experiment; only Dev owns that
experiment in bundle state.

```bash
# Development
TARGET=dev PROFILE="<profile>" bash bundle/deploy.sh
TARGET=dev PROFILE="<profile>" bash bundle/agent-release.sh --apply
TARGET=dev PROFILE="<profile>" bash bundle/app-release.sh --apply

# Production
TARGET=prod PROFILE="<profile>" bash bundle/deploy.sh
TARGET=prod PROFILE="<profile>" bash bundle/agent-release.sh --apply
TARGET=prod PROFILE="<profile>" bash bundle/app-release.sh --apply
```

> **Corporate VPN note:** GlobalProtect can intercept Databricks workspace or
> Lakebase traffic and return a proxy response even when the transport reports
> HTTP 200. If a release fails parsing an unexpected 200 response or cannot
> reach the workspace/database, disconnect GlobalProtect and retry the same
> command before changing credentials, resources, or bundle variables.

The bundle deploy is interactive. Read its proposed changes before approving
them. Do not use auto-approval for a first deployment. Detailed deployment,
grant, recovery, and verification guidance is in
[bundle/README.md](bundle/README.md). To run Dev on the newest registered model
version and Prod on the previous approved version, use the normal bundle
deployment. It reconciles both endpoints before creating either App, and
subsequent Dev model logs do the same automatically.

## Use Player Insights Agent

1. Add people to the access groups. The app release has already granted those
   groups the app, the warehouse, and both Genie spaces.
2. Grant `SELECT` on the governed source tables, by label, to the groups or
   people who should read them.
3. Open **Connections** and confirm the running model, warehouse, storage, and
   Genie spaces match the intended configuration.
4. Ask a question on **Ask**. Review the Sources, SQL, Derivation, Caveats, and
   Trace sections before using the result in a decision.
5. Use **Run Explorer** for detailed timing and tool-call inspection.

An answer can be complete, partial, a plan awaiting approval, or a clarification
request. Player Insights Agent does not turn missing access or ambiguous data into a
plausible number.

### Sign out and idle sessions

Use **Sign out of Player Insights Agent** in the account menu when leaving the
app. It ends Player Insights Agent's application session and opens the native same-origin App sign-out
path. This is a partial logout: Databricks App and workspace sessions are
separate, the native App session may persist or refresh for up to 24 hours, and
federated logout is not supported. If the upstream workspace or identity
provider session remains active, Databricks may authenticate you again without
prompting. Workspace logout does not prove the App session ended.

Player Insights Agent adds a server-enforced idle timeout for every protected API route. It
defaults to 120 minutes (2 hours) and can be configured with
`PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES` (`5`-`480`; only `disabled` turns it
off). Background polling and programmatic events do not extend the timeout;
trusted click, input, key, pointer, touch, wheel, and scroll interactions do. On
expiry, the app stops polling, clears user-data caches, and requires sign-out
before a new app session can start. This control protects only the Player Insights Agent
application layer; strict immediate coordinated logout requires a
customer-controlled OIDC/gateway architecture.

## Update an existing deployment

> **November 2026 security release:** after the Deploy from Git below, import
> and run the one-time upgrade notebook described in [UPGRADE.md](UPGRADE.md).
> It applies the new access settings without a bundle deploy: preview first,
> then apply. The new app works with your current model; the agent-side
> protections arrive with your next model release.

For app-code-only updates, use **Deploy from Git** on the existing Databricks
App:

| Setting          | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Repository       | `https://github.com/smathews13/player-insights-agent` |
| Provider         | GitHub                                                |
| Branch           | `main`                                                |
| Source code path | `player-insights-agent/build/deploy`                  |

The public mirror publishes `player-insights-agent/build/deploy/` as a
dependency-free app artifact with its runtime `app.yaml`. Do not leave the
source path blank.

A Git deployment updates app code only. It does not reconcile bundle resources,
change OAuth scopes or bindings, release a new model version, or change stored
roles. Use the bundle scripts for resource or model changes.

This is the established one-step update path. Do not run a local app release
before or after it. The Git importer does not read
`.databricks/bundle/dev/variable-overrides.json` or
`.databricks/bundle/prod/variable-overrides.json` from a laptop, but it also
does not replace the existing App, service principal, resource bindings, OAuth
scopes, telemetry destinations, or Lakebase state that those bundle inputs
configured.

For runtime values, Databricks Apps applies deployment-level environment
variables after `app.yaml`, so existing deployment overrides win over matching
customer-neutral values in the committed artifact. `valueFrom` entries continue
to resolve through the unchanged `postgres`, `serving-endpoint`,
`genie-mcp-signing-key`, and `sql-warehouse` bindings. Stored roles, settings,
and the app-owned schema remain in Lakebase under the unchanged App identity.
The committed manifest is only the fallback for a value that has no deployment
override or durable runtime value.

Pulling `main` in an existing local checkout is independent of that App update:
Git leaves the ignored bundle override file byte-for-byte unchanged for any
future bundle or model operation. A fresh clone still needs a secure copy of the
file, because ignored local state is never transferred by Git.

## Governance and security boundaries

- **Caller-scoped data access.** Genie and SQL run with the signed-in user's
  authorization. Unity Catalog grants, row filters, and column masks continue
  to apply.
- **Declared read scope.** The model artifact contains a table manifest bounded
  by `data_catalogs`. The SQL guard accepts read-only statements and rejects
  undeclared tables.
- **Separated operational storage.** Lakebase stores conversations, settings,
  feedback, benchmark state, and application roles. It is not used as evidence
  for analytical answers.
- **Server-side administration.** Administrative APIs enforce roles even when
  a user navigates directly to an administrator route.
- **Server-side idle enforcement.** A per-browser opaque app-session cookie is
  checked against Lakebase on every protected API request; ordinary reads and
  background refreshes do not extend it.
- **Reviewable changes.** Runtime presentation settings cannot widen data
  access. Catalog scope, table manifests, prompts, guardrails, and Genie space
  identifiers require a model release.
- **Traceability.** Executed SQL, source roles, timings, and tool calls are
  retained in the answer contract and MLflow trace where configured.
- **Protected columns.** The SQL guard refuses to return identity columns or to
  join players across labels through the cross-label key.
- **Untrusted tool results.** Data returned by tools is fenced as untrusted, so
  instructions planted in it are not followed, and result size is capped.
- **Restricted traces.** Traces are redacted, and the MLflow experiment is
  readable only by the app, the endpoint's owner, and the admin group.
- **AI Gateway.** On by default: model calls go through an AI Gateway model
  service with per-person rate limits and usage tracking. It can be switched
  off in **Settings**.
- **One copy of conversations.** The endpoint's request log is off, so
  questions and answers stay in Lakebase, where deletion and erasure reach
  them. People can delete their conversations with their runs, Admin reads of
  other people's conversations are audited, and automatic retention
  (`PLAYER_INSIGHTS_CONVERSATION_RETENTION_DAYS`) is off by default.
- **Secrets.** The signing key supports two-key rotation, and
  `bundle/secret_scan.py` checks tracked files for credentials.
- **Posture checks.** `bundle/security-posture.sh` reports workspace-wide or
  individual grants, Super admin group size, the experiment ACL, and the
  endpoint's settings.

Deployers remain responsible for data classification, grants, Genie curation,
warehouse policy, retention, model endpoint selection, network controls, and
reviewing generated results before operational use. Do not place credentials,
tokens, workspace-specific IDs, or personal addresses in tracked files.
Restrict the Databricks App's **CAN USE** permission to approved groups, retain
Unity Catalog row filters and column masks on governed sources, and audit
application actions without recording cookies, tokens, or raw authorization
headers.

## Experimental status and limitations

- Player Insights Agent is not a transactional system, an autonomous decision
  maker, or a
  replacement for data review.
- Generated interpretation can be incomplete or wrong even when the underlying
  query succeeds. Validate important conclusions against the displayed SQL,
  sources, and governed data.
- Missing grants, unavailable dependencies, ambiguous terminology, or data
  outside the declared manifest can produce a partial answer or clarification.
- Lakebase and Genie spaces must already exist and are not lifecycle-managed by
  this bundle.
- App-code, model, resource, and OAuth-scope changes have separate release
  paths.
- Native App sign-out cannot invalidate or detect a separate workspace/IdP
  logout, and an active upstream session may silently reauthenticate the app.
- This repository currently publishes no formal contribution workflow or
  software license. Confirm permitted use and redistribution with your
  Databricks account team.

## Support

This project is provided without Databricks Support SLA coverage. For
deployment, configuration, or troubleshooting help, work with your Databricks
account team. When reporting a problem, include the release version, deployment
stage, sanitized error text, and relevant MLflow trace identifier. Do not post
credentials, tokens, private workspace URLs, customer data, or personal
information in a public issue.
