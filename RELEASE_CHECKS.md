# Release check tiers and hot paths

The release path has two explicit tiers:

```bash
# Workspace-free checks whose failure makes an app release unsafe.
bash bundle/release-checks.sh fast

# Complete non-browser audit. Run manually before a handoff or broad release.
bash bundle/release-checks.sh full
```

GitHub Actions is disabled for this repository by an enterprise administrator.
The full command is therefore a manual pre-release/nightly audit; this repository
does not claim that an inert workflow runs it.

## What runs where

### `git push origin main`

The managed Databricks pre-push hook runs first. There is no repository-local or
user-local pre-push hook. The managed hook scans the pushed commits for secrets
and attempts its destination/repository policy check; it does not run Vitest,
pytest, typecheck, lint, format, a build, or bundle tests. On the final measured
push, secret scanning ran but the managed metadata check reported that its
GitHub token was missing and skipped that leg. The mirror's own exact-remote,
account-switching, origin-equality, divergence, and normal-push checks are
independent of that managed metadata leg and all ran.

Observed managed-hook time on this machine: **0.10-0.37 seconds**.

### `bash sync-mirror.sh`

The mirror script fetches internal `origin/main`, requires local/internal
equality, archives that exact commit, removes private paths, materializes public
README/API/logo inputs from committed blobs, substitutes neutral icons, and
audits the committed dependency-free app artifact. It then prunes the internal
bundle target, applies the rewrite once, proves it with the rewrite canary,
validates the public guides, and scans the final derived tree for confidential
paths/private values. Finally it switches to the public GitHub account, refuses
an unowned public HEAD, creates a child of the live public HEAD, and pushes
normally. The EXIT trap always restores the internal account.

It never installs packages or rebuilds. The artifact audit uses Node standard
library code against the committed `build/deploy` tree. The external push also
passes through the managed pre-push secret/repository guard.

Measured dry run: **53.07 seconds before, 46.54 seconds after**.

### `bundle/app-release.sh --apply`

Before upload, the app release:

1. resolves and caches the bundle once;
2. applies the recorded-decision gate;
3. runs the strict live scope/resource release gate;
4. installs locked dependencies only when `node_modules` is absent;
5. runs the compact fast allowlist (app.yaml, admin, session, v23/v24 migration
   safety, 90-day telemetry retention, migration order, the public-tree leak
   canary, and source scope contract);
6. builds and audits the deploy artifact;
7. checks schema ownership and applies app-database grants.

It then verifies that any active App runs from Databricks' separate `SNAPSHOT`
copy, validates the exact app-specific staging path under the profile actor's
Workspace home, deletes only that staging directory, imports the exact artifact,
starts a new app when necessary, and deploys in explicit `SNAPSHOT` mode. The
mock-CLI staging test pins path refusals, stale-hash removal, command order, and
failure-before-deploy behavior.
The broad advisory live sweep is still available as
`TARGET=... PROFILE=... bundle/preflight.sh --live`; it is not repeated on every
code upload. The post-deploy status read remains, but the same scope contract is
not checked a second time because an app code upload does not mutate the App
resource or OAuth policy.

The fast static allowlist measures **1.66 seconds** on this machine, up from
**1.20 seconds** before the operation-critical migration and leak tests were
added and still well below its two-minute target. Databricks
platform upload/start/deploy wait is not included in local-preflight timing.

### `npm run build:deploy`

The release build runs the production Vite/CSS build, bundles the dependency-free
server/worker tree, then performs one artifact audit. The audit covers:

- complete clean source stamp;
- no package/install manifest;
- no source maps or source-map references;
- platform per-file limit and recorded bundle budgets;
- deployable `app.yaml`, production command/environment, and non-empty scopes.

`npm run build:client` still includes typecheck for development/full audit.
`build:deploy` does not repeat full typecheck; the full tier owns it.

Warm measured build: **12.70 seconds before, 4.87 seconds after**. A cold
observed `build:client` was **60.88 seconds**, including a **43.34-second**
typecheck that is now owned by the full tier.

### Bundle and agent commands

`bundle/run-checks.sh` remains the complete workspace-free bundle checker suite.
Its own control-flow meta-test now uses tiny fixtures instead of rerunning the
entire bundle suite five times: **504.24 seconds before, 6.89 seconds after**.

`bundle/agent-release.sh` does not run the app/Python full suites. Its hot path
keeps only model-release-specific live safety: recorded decisions, app-intention
correlation, configured/documented/logged model scopes, served-entity capacity,
traffic confirmation, and served user-authorization policy. No model or agent
behavior changed in this refactor.

## Full tier

`bash bundle/release-checks.sh full` invokes each complete suite once:

- all Vitest unit tests;
- TypeScript typecheck, ESLint, and Prettier check;
- all agent pytest tests and Ruff;
- all bundle static/checker regression suites plus the runner meta-test;
- the mirror derivation regression suite;
- one production deploy build and artifact audit.

Browser/Playwright tests are deliberately not included.
