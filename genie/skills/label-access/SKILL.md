---
name: label-access
description: Plan, apply and verify per-label data access in Unity Catalog for the Player Insights Agent (PIA). Use when someone asks to give a label's data group access to its schemas, check that one label cannot read another label's data, add or check the row filter on a cross-label master table, or prove label isolation before onboarding a label partner.
---

# Label access for the Player Insights Agent

PIA answers every question as the signed-in person, so a person sees exactly the
label data Unity Catalog lets them read. This skill sets up and proves that
access: one data group per label, each granted only its own schemas plus the
shared ones, and a row filter (or central-only access) on any table that mixes
labels.

All work goes through `scripts/label_access.py`. Do not hand-write the GRANT or
row-filter SQL: the module is the same code the PIA release tooling uses, and
its verify step reads *effective* privileges, which catch access inherited from a
catalog or another group that `SHOW GRANTS` misses.

## Steps

1. **Get the config.** Ask for the path of the person's label access JSON in the
   workspace. If they have none, draft one with them in their home folder using
   the shape below, and confirm every group and schema name with them. Never
   guess a group name.
2. **Plan.** Run the plan and show the output, including the access matrix at
   the end: who reads which schema, and who sees which rows of the master table.
   It changes nothing.

   ```python
   import sys
   sys.path.append("/Workspace/.assistant/skills/label-access/scripts")
   import label_access
   label_access.run("/Workspace/Users/<them>/label-access.json", mode="plan")
   ```

3. **Apply only after an explicit yes.** Applying adds grants and creates and
   attaches row filters. It needs a SQL warehouse for the row-filter SQL, and
   the person must be able to grant on the catalog (owner or MANAGE). It never
   revokes anything.

   ```python
   label_access.run(config_path, mode="apply", warehouse_id="<warehouse id>")
   ```

4. **Verify.** Apply ends with a verify; run it on its own to check existing
   access. Report every `FAIL` line in plain words, and say the access is proven
   only when the run ends with `All label access checks passed.`

   ```python
   failures = label_access.run(config_path, mode="verify")
   ```

5. **Export, when asked what is granted today.** It lists the owner and direct
   grants of every catalog, schema and master table in the config, and changes
   nothing. Use it before a review with data governance.

   ```python
   label_access.run(config_path, mode="export")
   ```

## Config shape

```json
{
  "catalog": "prod_catalog",
  "shared_schemas": ["global_production"],
  "central_groups": ["Central_Readers"],
  "group_check": "is_account_group_member",
  "labels": [
    {"label": "Northwind", "group": "Northwind_Data_Readers", "schemas": ["northwind_production"]},
    {"label": "Contoso", "group": "2K_Data_Readers", "schemas": ["twok_catalog.production"]}
  ],
  "master_tables": [
    {"table": "xlabel.prod.master", "label_column": "label", "readers": "central"}
  ],
  "no_data_principals": ["<PIA app service principal application ID>"],
  "require_workspace_binding": false,
  "agent_read_scope": ["prod_catalog"]
}
```

- A schema is either a name inside `catalog` or `catalog.schema`, so each label
  may have a catalog of its own.
- `no_data_principals` lists identities that must hold no label data at all,
  such as the PIA app's own service principal: PIA reads data as the signed-in
  person, so a data grant to the app is a way around label isolation.
- Verify fails when a person, rather than a group, owns a label catalog or
  schema. Set `"owners_must_be_groups": false` only for a test.
- `"require_workspace_binding": true` makes verify fail for a label catalog that
  every workspace on the metastore can use.

- `readers: "central"` means only central groups may read the master table, so
  no row filter is created and verify fails if a label group can read it.
  `"all_labels"` creates a row filter admitting each label to its own rows and
  central groups to all.
- `agent_read_scope` is optional: the catalogs or `catalog.schema` entries the
  PIA agent may query. Without it, verify says the scope was not checked.

## Edge cases

- **Workspace-local groups cannot be granted in Unity Catalog.** Label groups
  must be account groups (synced from Entra ID). If a grant fails for that
  reason, say so; do not substitute individual users.
- **An open catalog fails verify on purpose.** If `account users` holds
  ALL_PRIVILEGES on the catalog, every label can read every schema and verify
  reports cross-label reads. That is a real finding, not a tool error.
- **"could not be read" is a failure.** It means the privilege lookup was
  refused, so isolation is unproven. Usually the person cannot see grants on
  that object.
- **Do not widen access to make verify pass.** Report the failure and let the
  data owner decide.
