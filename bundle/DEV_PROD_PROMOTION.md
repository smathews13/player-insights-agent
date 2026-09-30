# Dev and Prod from one registered model

This runbook creates two new Databricks Apps while leaving the existing
`astrolabe` App untouched until verification:

| Environment | App | Serving endpoint | Model version | Lakebase app schema |
|---|---|---|---|---|
| Dev | `player-insights-agent-dev` | `player-insights-agent-dev` | highest approved version | `pia_dev` |
| Prod | `player-insights-agent-prod` | `player-insights-agent-prod` | second-highest approved version | `pia_prod` |

Both environments may share the SQL warehouse, governed data catalogs, Genie
spaces, Lakebase project/branch/database, and registered Unity Catalog model.
They cannot share a serving endpoint: endpoint traffic chooses the model
version for every caller, so one endpoint cannot pin Dev to N and Prod to N-1.

The source-data catalog/schema may be shared through `data_catalogs`. Dev is the
single bundle-state owner of the shared app-owned Unity Catalog schema and
volume; Prod sets their resource maps to `{}` and points `model_name` at the
same registered model. This prevents two bundle states from independently
updating or destroying one UC object.

## 1. Inventory without changing anything

Use the intended workspace profile for every command. Record:

```bash
databricks apps get astrolabe --profile "<profile>" -o json
databricks serving-endpoints get "<existing-endpoint>" --profile "<profile>" -o json
databricks registered-models get "<catalog.schema.model>" \
  --include-aliases --profile "<profile>" -o json
databricks model-versions list "<catalog.schema.model>" \
  --profile "<profile>" -o json
```

Copy the existing warehouse, Genie-space, Lakebase, governed-data, and model
values into both ignored target files. Keep separate source paths:

```text
.databricks/bundle/dev/variable-overrides.json
.databricks/bundle/prod/variable-overrides.json
```

Set the same explicit three-level `model_name` in both files. Keep `app_schema`
the same only when it is the existing schema that owns that model; Prod will not
manage that schema. The target defaults already provide distinct App names,
endpoint names, experiment paths, telemetry schemas, and Lakebase app schemas.

## 2. Pin exact versions

Sort model versions numerically. Record the highest existing approved version
as `DEV_VERSION` and the second-highest existing approved version as
`PROD_VERSION`. Do not calculate `N-1` without checking that it exists, and do
not use a moving alias during deployment.

Both versions must carry the current AnswerContract, user-auth policy, API
scopes, and Genie-space fingerprint. A version that predates fingerprinting is
not safe to promote through this workflow.

## 3. Create the two endpoints first

The App resource binds an existing endpoint, so prepare each endpoint before
the corresponding bundle deploy. `--skip-log` deploys the registered artifact;
it does not replace or re-log model code.

```bash
TARGET=dev PROFILE="<profile>" \
  bash bundle/agent-release.sh --apply --skip-log --model-version "$DEV_VERSION"

TARGET=prod PROFILE="<profile>" \
  bash bundle/agent-release.sh --apply --skip-log --model-version "$PROD_VERSION"
```

The release checks each pinned version's baked Genie fingerprint against the
live spaces before changing endpoint traffic.

## 4. Create and release the Apps

For each target, validate, review the interactive bundle change list, and then
release the App:

```bash
databricks bundle validate --strict -t dev --profile "<profile>"
TARGET=dev PROFILE="<profile>" bash bundle/deploy.sh
TARGET=dev PROFILE="<profile>" bash bundle/app-release.sh --apply

databricks bundle validate --strict -t prod --profile "<profile>"
TARGET=prod PROFILE="<profile>" bash bundle/deploy.sh
TARGET=prod PROFILE="<profile>" bash bundle/app-release.sh --apply
```

Do not bind, rename, stop, or delete `astrolabe` during this sequence.

## 5. Verify before cutover

Confirm:

- each App binds only its matching endpoint;
- Dev endpoint traffic is 100% on `DEV_VERSION`;
- Prod endpoint traffic is 100% on `PROD_VERSION`;
- both Apps use the intended warehouse, Genie spaces, and registered model;
- Dev writes only to `pia_dev` and Prod writes only to `pia_prod`;
- one governed question succeeds under a signed-in non-admin user in each App.

Retire `astrolabe` only after both new App URLs and service principals are
approved.
