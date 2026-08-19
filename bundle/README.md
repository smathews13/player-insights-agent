# `bundle/`: the imperative steps

All of these default to a dry run. `--apply` executes.

**Read `DECISIONS.md` before changing a target's variables.** It records the
standing product decisions a release must not contradict, each with the date it
was taken and a sentence of reason. A decision that needs to change is changed in
that file, deliberately, rather than drifting.

`decisions-gate.py` holds a release's resolved configuration against the
machine-checkable ones and stops the release, naming the decision and its date,
before anything irreversible happens. There is no bypass flag, on purpose. The
decisions it can only display rather than enforce are printed beside the
configuration and marked as displayed in both places, because a check that
implied more coverage than it has would be worse than none.

**Both release scripts now call it, and there is no path around it.** In
`agent-release.sh` it runs immediately after the configuration readout and before
anything is exported to `log_model.py`; in `app-release.sh` it runs before the
rollback branch and before the dry-run branch, so a dry run and a rollback are both
held to it. A dry run reports it deliberately: a dry run is where somebody checks a
target before committing to it, and a gate that only spoke on `--apply` would stay
quiet at the one moment it is cheap to act on.

`genie-drift.sh` answers a different and narrower question: does the Genie
content committed under `genie/` still match what the workspace is serving? It
reads and changes nothing, so it is safe to run mid-deploy or mid-demo. Exit 0
means the reference bodies and the live spaces agree; exit 1 means they do not.

It compares the TEXT rather than `serialized_space.version` or the instruction
ids. The spaces themselves are **not** bundle-managed any more: this bundle
attaches by id and does not overwrite instructions or curated tables on deploy.
Use the drift check when you deliberately want to know whether a reference body
and the live space have diverged; fixing drift is a Genie UI (or reference
re-export) step, not a `bundle deploy`.

What it cannot tell you is whether an instruction that landed is being **followed**.
Those look identical from outside; ask the space a question that depends on the
change. Whether the curated tables are inside the model's declared scopes is
`genie-live-check.py`, kept separate because it is a different question.

`TARGET` is required and has no default: guessing one aims a release at a
workspace. `PROFILE` is optional for a target that names its CLI profile in
`databricks.yml`, since it is read back from there; every other target must state
one (`PROFILE=<their-profile>`). If a profile name contains a space, keep it
quoted wherever you pass it.

## Deployment order on a fresh workspace

Nothing enforces this order, so following it is on you. The order below is the
one that works without an existing app and without temporary endpoint swaps.

0. Provision Lakebase (project / branch / database) and curate the two Genie
   spaces **outside** this bundle. Name them in
   `.databricks/bundle/<target>/variable-overrides.json`
   (`lakebase_project_id`, `genie_data_space_id`, `genie_dictionary_space_id`,
   plus `warehouse_id`, `admin_emails`, and the other required inputs).
1. `bundle deploy -t <target>` with `--select` for every resource **except** the
   app (schemas, volume, experiment, optional semantic job). The bundle
   attaches to existing Lakebase and Genie; it does not create them.
2. `bundle/agent-release.sh --apply`, which logs the model and creates the
   serving endpoint. This does **not** need the app to exist: governed reads
   run as the signed-in user, and there is no Unity Catalog gate on the app
   service principal before the re-log.
3. `bundle deploy -t <target>` again with no `--select`, which creates the app
   attached to the endpoint from step 2. `Apps.Create` refuses an attachment
   naming a serving endpoint that does not exist yet.
4. Run `bundle/app-release.sh --apply`. Before it pushes code, it resolves the
   app role and the attached Lakebase connection from the live bundle resources,
   applies the Postgres grants, and remediates AppKit cache ownership. The code
   deploy does not begin if that step fails.

Do **not** create an app shell against a temporary old endpoint, rewrite
`variable-overrides.json` mid-deploy, or use `--allow-missing-endpoint`. Those
were workarounds for a deleted gate.

Two inputs outside the app release still need an operator. The administrator
input fails validation when skipped; Genie sharing still requires review.

- **Name the deployment's administrators**, before step 4, because there is no
  way to appoint the first one from inside the running app:

  ```bash
  # .databricks/bundle/<target>/variable-overrides.json, which is git-ignored
  { "admin_emails": "someone@example.com,someone.else@example.com" }
  ```

  `admin_emails` is a required bundle variable, and the app release also rejects
  an explicitly empty value. Without those checks, the app would start and
  refuse every caller on Monitoring, Ops and the settings gear with a 403.
  **The admin-list editor that would fix it is behind the same refusal, so that
  deployment would be self-locking and the only way out would be another
  release.**

  The value must not go in `databricks.yml`, which is tracked and published: an
  address is a personal name and an employer, and both are on the publication's
  sensitive list. `databricks.yml` declares `admin_emails` without a default so
  validation requires a private override. `PLAYER_INSIGHTS_ADMIN_EMAILS` in the
  environment wins over the file for a one-off that should not change what the
  target records.

  **`build/deploy/app.yaml` is where the addresses actually land, and it is
  tracked.** The release uploads the local build tree directly, so the container
  gets the list without a commit. Do not commit it:
  `git restore player-insights-agent/build/deploy/app.yaml`. The build prints
  the same warning, and a test fails while the addresses are there:

  ```bash
  cd player-insights-agent && npm test -- scripts/deploy-app-yaml.test.ts
  ```

  **That test is the only thing catching this before the commit**, so do not
  weaken it to get one through. The mirror leak check still blocks on the
  addresses, but it gates the publication and no longer scans the internal tree,
  which puts it after the commit rather than before it.

- **The app release grants the app's Postgres role automatically**, after the
  bundle has created the app service principal and immediately before the code
  deploy that restarts it. `bundle/app-db-grant.sh` reads the app role, attached
  branch and database from the live app, reads `PGHOST` from the branch's direct
  connection (`databricks postgres get-branch`, never the pooled AppKit host),
  and uses the profile's current identity as `PGUSER`. The profile must hold
  `DATABRICKS_SUPERUSER`; an unreachable branch or failed grant stops the
  release with the values it could not resolve.

  The hook also drops a misowned AppKit cache schema (`appkit`) —
  `GRANT USAGE, CREATE` alone cannot fix later `CREATE INDEX` ownership
  failures. It is idempotent and leaves an app-owned cache schema alone.

  After a Lakebase detach/reattach when no full app release is otherwise needed,
  run the same hook as the manual escape hatch, then restart the app:

  ```bash
  TARGET=<target> PROFILE='<profile>' bundle/app-db-grant.sh
  databricks apps stop <app-name> --profile '<profile>'
  databricks apps start <app-name> --profile '<profile>'
  ```

  Skipped, every route answers from representative data at HTTP 200 with no
  error anywhere, and AppKit's persistent cache stays in-memory across restarts.

- **Share each Genie space with the people or groups who will use the app, at
  `CAN RUN`.** With `execution_identity: user-authorization`, Genie runs as the
  person who asked, not as the app or serving-endpoint service principal.
  Skipped, every Genie call fails `PermissionDenied` and the agent's SQL fallback
  answers anyway. Those same callers also need `CAN USE` on the warehouse and
  `SELECT` on the curated tables, because Genie's query runs under their grants.
  There is no bundle resource for the grant, but there **is** a CLI, so it need
  not be a UI step:

  ```bash
  databricks permissions update genie <space_id> \
    --json '{"access_control_list":[{"user_name":"someone@example.com","permission_level":"CAN_RUN"}]}'
  ```

  Do **not** grant the *serving-endpoint* principal `CAN RUN`: that was the old
  passthrough remedy, and under user authorization it grants nothing the caller
  needs.

## The scripts

| Script | What it does |
| --- | --- |
| `agent-release.sh` | Log the model, deploy it to the serving endpoint, wait for the traffic switch, read back the served versions, then prune the entities the release superseded. `--no-prune` leaves them and reports what it would have removed. |
| `prune-served-entities.py` | Remove idle served entities from the endpoint, keeping whatever holds traffic plus `var.serving_rollbacks_kept` rollbacks — which defaults to **none**, because the version a kept rollback reaches is the one released *before* the current fix. Run by `agent-release.sh`; also runnable alone. Reports by default, acts on `--apply`, exits 3 when there is something to prune and it was not asked to. Endpoint only: it has no code path that reaches the registry, so every version stays registered and can be served again with `deploy_agent.py --model-version N` — that is the rollback path, and it needs no idle entity held open for it. |
| `app-release.sh` | Resolve the MLflow experiment id, build the dependency-free tree, gate on `app-db-grant.sh`, upload, and deploy. The only way app code is pushed; `npm run deploy` is an alias for it. `--rollback-to <workspace-path>` applies the same grant gate and re-points the app at a known-good source directory without rebuilding. |
| `app-db-grant.sh` | Resolve the app role, direct branch host, database, operator role and app schema from the target and live resources, then run `scripts/grant-app-db-access.mjs`. Called by every app release; runnable directly after Lakebase reattach without a full release. |
| `app-spec.sh` | Emit the complete app spec for a target, generated from `bundle validate` so it can only carry that target's own values. Prints by default; `--apply` sends it and verifies what the API kept. Recovery only: the bundle owns this resource. Refuses to write on a host mismatch, a Lakebase project absent from the workspace, a serving endpoint that does not exist, a lost load-bearing `user_api_scopes` entry, or a `sql-warehouse` resource with no id. There is no `--allow-missing-endpoint`. |
| `plan-gate.sh` | Refuse a `bundle deploy` that would delete or replace a resource. **This one blocks** — unlike the advisory suites, which report and are swallowed. About two seconds, so chain it: `TARGET=<t> bundle/plan-gate.sh && databricks bundle deploy -t <t>`. Decision logic in `plan-gate.py`, proved by `plan-gate.test.sh`. |

Identity split (do not re-introduce an app-SP Unity Catalog data gate on release):

- **Signed-in user** — governed UC / Genie / SQL reads (`execution_identity: user-authorization`).
- **App service principal** — app-owned Lakebase operational storage and non-data control-plane work only. Lakebase grants are checked after app creation (`scripts/grant-app-db-access.mjs`, `/api/storage`, app-release ownership), not by asking UC what the SP can `SELECT` on customer catalogs.

## Before `bundle deploy`

Nothing in this repository runs `bundle deploy`; it is always a person at a
terminal, and it is the one command here that can remove a resource. Two of them
hold things that do not come back — `schemas.player_insights_schema` has the
registered model and app-owned semantic assets, and
`schemas.player_insights_telemetry_schema` has app history that does not backfill.
Both carry `prevent_destroy`, which stops `bundle destroy` and does **not** stop a
`replace`.

So run the gate and let `&&` do the deciding:

```bash
TARGET=<target> bundle/plan-gate.sh && databricks bundle deploy -t <target>
```

`bundle deploy` prints its own plan and asks, so this is redundant in principle.
In practice the twentieth deploy is read less carefully than the first. If a
removal is intended, acknowledge it by name rather than skipping the gate:

```bash
TARGET=<target> PIA_PLAN_ALLOW_DESTROY=resources.jobs.some_retired_job \
  bundle/plan-gate.sh && databricks bundle deploy -t <target>
```

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
