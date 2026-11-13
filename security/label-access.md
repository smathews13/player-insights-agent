# Label data access: decision record and runbook

Which labels a person sees is decided by Unity Catalog grants on the data, not
by PIA. PIA asks every question as the signed-in person, so the same grants
hold in PIA, Genie, notebooks and dashboards. This page records how the
cross-label master table is protected and how the label grants are kept in the
repository and checked.

`bundle/label-access.sh` does the work. Its config (from
`bundle/label-access.example.json`) is the version-controlled grant set: keep it
in the deployment's private config repository, reviewed by data governance.

## Decision: the cross-label master table

**Status: proposed, waiting for data governance to confirm.** The architecture
packet keeps the access matrix marked "Illustrative" until they do.

Both options are built and tested; the config chooses one per table with
`master_tables[].readers`.

| | Central only (`"readers": "central"`) | Row filter by label (`"readers": "all_labels"`) |
|---|---|---|
| Who can query it | The all-labels group only | Every label group and the all-labels group |
| What a label analyst sees | No access | Only rows whose label column is their label |
| What the all-labels group sees | Every row | Every row |
| Enforced by | Grants | Grants plus a Unity Catalog row filter |
| Risk if misconfigured | A label grant on the table exposes every label | A label value missing from the filter shows that label to no one |

**Recommendation: row filter by label**, if any label team needs its own rows
from the master table (for example in a cross-title Genie question). Choose
central only if no label team needs it; it is the simpler control.

Either way, `--verify` proves it: under central only it fails if any label group
can select the table; under the row filter it fails if the filter is missing.
The identity end-to-end test asks the same cross-label question as each test
identity and checks that a label sees only its own label and central sees all.

## The agent's cross-label key guard

The agent also refuses SQL that self-joins on, or returns, the key that links
one player across labels. Name that column in the bundle variable
`cross_label_key_columns` (comma-separated, in the deployment's private target
or `.databricks/bundle/<target>/variable-overrides.json`). The public
repository ships it empty, so a model built from the public tree guards only the
built-in name until the deployment sets its own. The value is baked into the
model: set it before the model release (`bundle/agent-release.sh --apply`).

## The access matrix

`bash bundle/label-access.sh` (no flag) prints the intended matrix from the
config. With the row filter it reads:

| | Label A catalog | Label B catalog | Global catalog | Master table |
|---|---|---|---|---|
| Label A data group | reads | no | reads | own rows |
| Label B data group | no | reads | reads | own rows |
| All-labels group | reads | reads | reads | all rows |
| App and agent identities | no | no | no | no |

`--verify` holds the workspace to it, using effective privileges, so a grant
inherited from a catalog or another group counts.

## Runbook

1. **Export the current grants** for review:

   ```bash
   LABEL_ACCESS_CONFIG=<file> TARGET=<target> PROFILE=<profile> \
     bash bundle/label-access.sh --export > label-grants-current.json
   ```

   Data governance marks each grant as approved or to remove. Do not commit the
   export.
2. **Write the approved state into the config.** Each label lists its schemas as
   `catalog.schema`, so each label may have its own catalog. Set:
   - `central_groups`: the all-labels group;
   - `master_tables[].readers`: the decision above;
   - `no_data_principals`: the app's service principal and the agent's own
     identity, which must hold no label data;
   - `require_workspace_binding: true` once each label catalog is bound to the
     workspaces that need it (*Catalog → Workspaces* in Catalog Explorer).
3. **Make groups the owners** of every label catalog and schema
   (`ALTER CATALOG <c> OWNER TO <group>`). `--verify` fails when a person owns
   one.
4. **Apply**, which only adds grants and never revokes:

   ```bash
   LABEL_ACCESS_CONFIG=<file> TARGET=<target> PROFILE=<profile> bash bundle/label-access.sh --apply
   ```

5. **Revoke what the review marked for removal** by hand, with `REVOKE`, then
   re-run `--verify` until it passes.
6. **Prove it as people.** A label A analyst runs the cross-label question and
   sees only label A; an all-labels user sees every label.

## Done when

- `--verify` exits 0, including the owners, bindings and no-data identities.
- The config is in the private config repository, reviewed by data governance.
- Data governance has confirmed the master-table decision, and the packet's
  "Illustrative" label is removed.
