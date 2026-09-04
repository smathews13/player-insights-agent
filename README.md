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
asks a question in plain language; PIA finds approved data, runs live queries,
and returns an answer with figures, sources, SQL, caveats, and an MLflow trace.
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
- Optional semantic metadata search using Databricks Vector Search.

## Architecture

```text
User
  │
  ▼
Databricks App ───────────────▶ Lakebase
  │                            conversations, settings, roles
  ▼
Model Serving endpoint ───────▶ MLflow experiment
  │                            traces and run metadata
  ├──▶ Foundation model
  ├──▶ Genie spaces
  ├──▶ SQL warehouse ─────────▶ Unity Catalog data
  └──▶ Vector Search (optional metadata index)
```

The Databricks Asset Bundle creates the application-owned Unity Catalog
objects, MLflow experiment, app resource, and supporting job definitions. It
attaches to, rather than creates or owns, the SQL warehouse, Lakebase database,
and Genie spaces. The model and app code are released separately after the
initial bundle deployment.

## Prerequisites

You need:

- a Databricks workspace with Apps, Model Serving, Unity Catalog, MLflow, Genie,
  Lakebase, and a Pro or Serverless SQL warehouse available;
- the Databricks CLI authenticated to that workspace;
- an existing Unity Catalog catalog for Player Insights Agent-owned objects;
- one or more catalogs or schemas containing the governed data PIA may
  read;
- an existing Lakebase project, branch, and database;
- two curated Genie spaces: one for analytical data and one for data
  definitions;
- one or more initial application administrator email addresses; and
- permissions to deploy bundles, apps, models, and serving endpoints and to
  grant the required data access.

Users need workspace access, Databricks SQL access, `CAN USE` on the warehouse,
`CAN RUN` on both Genie spaces, and `SELECT` on the data they are expected to
query.

## Install and deploy

Clone the public repository and authenticate:

```bash
git clone https://github.com/smathews13/player-insights-agent.git
cd player-insights-agent
databricks auth login --profile "<profile>"
```

Create the git-ignored file
`.databricks/bundle/customer/variable-overrides.json`:

```json
{
  "app_catalog": "<your_catalog>",
  "app_schema": "astrolabe",
  "data_catalogs": ["<data_catalog>", "<data_catalog>.<restricted_schema>"],
  "warehouse_id": "<sql_warehouse_id>",
  "app_source_code_path": "/Workspace/Users/<release-actor>/astrolabe-app-source",
  "lakebase_project_id": "<lakebase_project_id>",
  "lakebase_branch_id": "production",
  "lakebase_database_id": "databricks-postgres",
  "lakebase_app_schema": "astrolabe",
  "genie_data_space_id": "<data_genie_space_id>",
  "genie_dictionary_space_id": "<dictionary_genie_space_id>",
  "admin_emails": "super:<initial_admin@example.com>"
}
```

`data_catalogs` is the deployment's complete Unity Catalog read boundary. A
catalog entry permits discovery within its non-system schemas; a
`catalog.schema` entry narrows that boundary to one schema. Review this list
before every model release.

Run the three deployment stages in order:

```bash
TARGET=customer PROFILE="<profile>" bash bundle/deploy.sh
TARGET=customer PROFILE="<profile>" bash bundle/agent-release.sh --apply
TARGET=customer PROFILE="<profile>" bash bundle/app-release.sh --apply
```

The bundle deploy is interactive. Read its proposed changes before approving
them. Do not use auto-approval for a first deployment. Detailed deployment,
grant, recovery, and verification guidance is in
[bundle/README.md](bundle/README.md).

## Use Player Insights Agent

1. Share the Databricks App with its users.
2. Grant those users access to the warehouse, both Genie spaces, and the
   governed source tables.
3. Open **Connections** and confirm the running model, warehouse, storage,
   Genie spaces, and optional semantic index match the intended configuration.
4. Ask a question on **Ask**. Review the Sources, SQL, Derivation, Caveats, and
   Trace sections before using the result in a decision.
5. Use **Run Explorer** for detailed timing and tool-call inspection.

An answer can be complete, partial, a plan awaiting approval, or a clarification
request. Player Insights Agent does not turn missing access or ambiguous data into a
plausible number.

### Sign out and idle sessions

Use **Sign out of Player Insights Agent** in the account menu when leaving the
app. It ends PIA's application session and opens the native same-origin App sign-out
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
before a new app session can start. This control protects only the PIA
application layer; strict immediate coordinated logout requires a
customer-controlled OIDC/gateway architecture.

## Update an existing deployment

For app-code-only updates, use **Deploy from Git** on the existing Databricks
App:

| Setting          | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Repository       | `https://github.com/smathews13/player-insights-agent` |
| Provider         | GitHub                                                |
| Branch           | `main`                                                |
| Source code path | `astrolabe`                                           |

The public mirror publishes `astrolabe/` as a dependency-free app artifact with
its runtime `app.yaml`. Do not leave the source path blank.

A Git deployment updates app code only. It does not reconcile bundle resources,
change OAuth scopes or bindings, release a new model version, or change stored
roles. Use the bundle scripts for resource or model changes.

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
- The optional semantic layer indexes metadata, not measures. It creates billed
  Vector Search resources and is off until explicitly configured and released.
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
