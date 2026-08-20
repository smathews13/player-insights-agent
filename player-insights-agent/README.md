# player-insights-agent

A Databricks App powered by [AppKit](https://www.databricks.com/devhub/docs/appkit/v0/), built with React, TypeScript and Tailwind CSS.

**Enabled plugins:**
- **Lakebase**: managed Postgres for transactional workloads on Databricks
- **Server**: Express HTTP server with static file serving and Vite dev mode

> **Do not add a `databricks.yml` to this directory.** The CLI resolves a bundle
> by walking *up* from your working directory, so a file here shadows the root
> bundle for anyone working in the app directory, and a `bundle destroy` typed
> here would delete the running app along with the service principal that holds
> the Postgres grants. `databricks bundle` commands typed here resolve to the
> root bundle, which sets `prevent_destroy` on all eleven resources.

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI, for deployment
- Access to a Databricks workspace

### Entitlements each user needs

Every user needs the `databricks-sql-access` and `workspace-access`
entitlements. Without them sign-in fails at the Databricks consent screen with
"Sorry, there was an error while trying to authenticate to app". The app is
never reached, so it cannot report this itself. A workspace admin grants them:

```bash
databricks api patch /api/2.0/preview/scim/v2/Users/<numeric_user_id> --json '{
  "schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations":[{"op":"add","path":"entitlements","value":[
    {"value":"databricks-sql-access"},{"value":"workspace-access"}]}]}'
```

Admins hold these implicitly for their own CLI calls but not for the app's
on-behalf-of token, so an admin can be refused where they expected to sail
through. Read a user's own entitlements rather than their group's:

```bash
databricks api get "/api/2.0/preview/scim/v2/Users?filter=userName+eq+<email>"
```

## Authentication

### Local development

```bash
cp .env.example .env
```

Then set what you need:

```env
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_APP_PORT=8000
```

Lakebase needs further variables for Postgres connectivity; see the
[Lakebase plugin documentation](https://www.databricks.com/devhub/docs/appkit/v0/plugins/lakebase).

**Point `PGHOST` at a Lakebase branch of your own, never at the one the deployed
app uses.** Local development boots the same server, which runs the same DDL, as
you rather than as the app's service principal.

Every statement is `IF NOT EXISTS`, which makes this look harmless, and for the
tables that already exist it is: Postgres refuses those on ownership and the app
logs that it did. The damage is the statements that **succeed**. A table you have
just added to the DDL does not exist yet, so nothing refuses it. It is created,
and your own role owns it permanently.

That blocks the next release, and it cannot be undone gently. The release runs a
hard ownership gate before it uploads anything, and ownership cannot be handed
back afterwards: `ALTER TABLE ... OWNER TO` requires `SET ROLE` on the target
role, and Lakebase does not grant a person that over a service principal. Neither
does re-running `scripts/grant-app-db-access.mjs`, because this is ownership
rather than privileges. The only remedy left is to drop the tables and let the app
recreate them, which is fine for empty ones and a data loss for anything holding
rows. It has happened once, to three tables that were empty.

Two things catch it, and neither is a substitute for using your own branch:

- The app refuses to run its DDL at all against a schema owned by a role it holds
  no rights over, and says so on the first line of its log. See
  `server/lib/schema-ownership-guard.ts`.
- `node scripts/check-db-ownership.mjs --app <app> --profile <profile>` reports
  every object in the **app data** schema the app cannot maintain. The release
  runs it and stops. Its printed remedy is to drop the listed misowned tables
  one at a time, then restart — **not** `DROP SCHEMA ... CASCADE` on the app
  schema, which would destroy conversations, messages, ratings and runs.
  AppKit's separate cache schema (`appkit`) is remediated by
  `scripts/grant-app-db-access.mjs` (drop-and-recreate; cache only), not by this
  check.

### CLI

OAuth is recommended; personal access tokens are legacy.

```bash
databricks auth login --host https://your-workspace.cloud.databricks.com
```

Credentials are saved to `~/.databrickscfg`, where you can keep several
profiles and select one with `--profile`.

## Getting started

```bash
npm install
npm run dev     # hot reload; the URL is printed to the console
npm run build   # dist/server.js and client/dist/
npm start       # run the production build
```

## Code quality

```bash
npm run typecheck
npm run lint       # lint:fix to apply
npm run format     # format:fix to apply
```

## Tests

```bash
npm test           # unit tests
npm run typecheck  # both the server and client projects
```

`npm test` does not open a browser. The browser suites are separate and are run
on purpose, never as part of the default test command:

```bash
npm run test:e2e    # the browser suite
npm run test:smoke  # the smaller browser smoke suite
```

Both need Chromium. Playwright downloads its own from a Microsoft CDN, and where
that download is blocked the suite looks unrunnable. It is not. Borrow an
installed Chrome or Edge instead with `PLAYWRIGHT_CHANNEL=chrome`.

## Deployment

The CLI path below builds and directly releases the app from a maintainer's
working copy. Internal and customer deployments use the same three-command
bootstrap in the root README: agent release, complete bundle deploy, then app
release. After the bundle has created the app and its bindings, normal app-code
updates use the existing app's **Deploy → From Git** flow, pointed at the
committed `player-insights-agent/build/deploy` directory.
That Git flow does not rebuild, reconcile resources, or change roles; Lakebase
is the runtime source of truth for every role. Maintainers refresh and commit
the deploy snapshot with `npm run build:deploy`; customers select the newer
commit in Deploy from Git and do not rerun this CLI release merely to update app
code.

`npm run deploy` is an alias for
`../bundle/app-release.sh --apply`. App name, destination workspace path and CLI
profile are read from the root bundle's target. `TARGET` has no default.
This command is not part of Deploy from Git. A Git update runs no bundle deploy,
agent release, app-release wrapper, resource reconciliation, or model log.

```bash
cd player-insights-agent
TARGET=<target> PROFILE=<your-profile> npm run deploy
```

`PROFILE` is optional for a target that names its own CLI profile in
`../databricks.yml`; every other target must state one. Running
`../bundle/app-release.sh` without `--apply` is a dry run that prints the steps
it would take and the paths it resolved.

`--apply` builds the client, esbuilds the server into a **dependency-free** tree,
prints the findings of any local advisory checks the tree carries, uploads with
`workspace import-dir` and deploys. Those checks report and never gate: a release
continues whatever they say, and a tree that carries none is released the same way.
The deployed tree must have no `package.json`: Databricks Apps would then run
`npm install` against 508 packages on compute with no registry egress and hang.

### Rollback

**A failed app deploy takes the URL down** with an HTTP 502 and there is no
automatic rollback. Recovery is to re-point the app at a source directory
already in the workspace that holds a known-good build:

```bash
TARGET=<target> npm run deploy:rollback -- /Workspace/Users/you@corp.com/player-insights-agent-src
```

Nothing is rebuilt or uploaded, so this is only a rollback if that directory
still holds the build you want.

### The rest of the stack

For the initial bootstrap only, this app is one step of a longer deployment.
Unity Catalog, both Genie spaces, Lakebase, the setup job and the agent serving
endpoint come first, and the asset bundle at the repository root deploys them in
that order. Run `databricks bundle deploy -t <target>` before the app exists,
not before a later Deploy-from-Git code update.

## Project structure

```
* client/          # React frontend
  * src/           # Source code
  * public/        # Static assets
* server/          # Express backend
  * server.ts      # Server entry point
  * routes/        # Routes
* shared/          # Shared types
* app.yaml         # App configuration
* .env.example     # Environment variables example
```

The bundle lives at the repository root (`../databricks.yml`), not here.

## Tech stack

- **Backend**: Node.js, Express
- **Frontend**: React, TypeScript, Vite, Tailwind CSS, React Router
- **UI components**: Radix UI, shadcn/ui
- **Databricks**: AppKit SDK
