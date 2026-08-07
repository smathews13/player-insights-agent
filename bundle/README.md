# `bundle/`: the imperative steps

All of these default to a dry run. `--apply` executes.

`TARGET` is required and has no default: guessing one aims a release at a
workspace. `PROFILE` is optional for a target that names its CLI profile in
`databricks.yml`, since it is read back from there; every other target must state
one (`PROFILE=<their-profile>`). If a profile name contains a space, keep it
quoted wherever you pass it.

## Deployment order on a fresh workspace

Nothing enforces this order, so following it is on you.

1. `bundle deploy -t <target>` with `--select` for every resource except the app.
2. `bundle/agent-release.sh`, which creates the serving endpoint.
3. `bundle deploy -t <target>` again with no `--select`, which creates the app.
   Both passes are needed: `Apps.Create` refuses an attachment naming a serving
   endpoint that does not exist yet, and creates nothing.
4. `bundle/app-release.sh`, which pushes the app's code.

Two steps in that sequence are manual, and neither fails loudly when skipped.

- **Grant the app's Postgres role**, after step 3, because the app's service
  principal does not exist until the app does:

  ```bash
  cd player-insights-agent && node scripts/grant-app-db-access.mjs
  ```

  Skipped, every route answers from representative data at HTTP 200 with no
  error anywhere.

- **Share each Genie space with the agent's serving principal as `CAN RUN`.**
  There is no CLI and no bundle resource for this, so it is a UI step. Skipped,
  every Genie call fails `PermissionDenied` and the agent's SQL fallback answers
  anyway.

## The scripts

| Script | What it does |
| --- | --- |
| `agent-release.sh` | Log the model, deploy it to the serving endpoint, wait 60s for the traffic switch, read back the served versions. |
| `app-release.sh` | Resolve the MLflow experiment id for the target, build the dependency-free tree, upload, deploy. The only way app code is pushed; `npm run deploy` is an alias for it. `--rollback-to <workspace-path>` re-points the app at a known-good source directory without rebuilding. |
| `app-spec.sh` | Emit the complete app spec for a target, generated from `bundle validate` so it can only carry that target's own values. Prints by default; `--apply` sends it and verifies what the API kept. Recovery only: the bundle owns this resource. Refuses to write on a host mismatch, a Lakebase project absent from the workspace being written to, a serving endpoint that does not exist (`--allow-missing-endpoint` for bootstrap), a lost load-bearing `user_api_scopes` entry, or a `sql-warehouse` resource with no id. |
## Verifying a deployment

A deployment can be built exactly right and still answer every question from
canned representative data, and none of these fail loudly. Establish that:

- both env-var-bearing app resources (`postgres` and `serving-endpoint`) are
  attached to the live app, and every `user_api_scopes` entry the bundle authors
  is in effect on it rather than merely declared. `databricks apps get
  <app-name> -o json` reports the resources and scopes the platform actually
  holds, which is the one place a lost attachment shows;
- the serving endpoint exists and is reachable;
- the app's Postgres role holds grants on the schema the app's own DDL creates;
- every table each Genie space curates is inside the manifest the logged model
  declares. A table outside it fails every Genie call, and the agent's SQL
  fallback answers anyway.
