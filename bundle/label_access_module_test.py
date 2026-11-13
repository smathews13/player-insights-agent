#!/usr/bin/env python3
"""Offline tests for the label access module the Genie Code skill runs.

bundle/label-access.test.sh covers the shell entry point through the CLI; this
covers the module itself: apply, verify, the access matrix, export, and failing
closed on unreadable grants.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).resolve().parents[1] / "genie" / "skills" / "label-access" / "scripts")
)

import label_access

CONFIG = {
    "catalog": "prod",
    "shared_schemas": ["global_production"],
    "central_groups": ["Central"],
    "labels": [
        {"label": "A", "group": "Label_A", "schemas": ["label_a"]},
        {"label": "B", "group": "Label_B", "schemas": ["label_b"]},
    ],
    "master_tables": [
        {"table": "prod.xlabel.master", "label_column": "label", "readers": "all_labels"}
    ],
}


LABEL_CATALOGS = {
    "catalog": "global_production",
    "shared_schemas": ["global_production.shared"],
    "central_groups": ["Central"],
    "no_data_principals": ["App_SP"],
    "labels": [
        {"label": "A", "group": "Label_A", "schemas": ["label_a_production.games"]},
        {"label": "B", "group": "Label_B", "schemas": ["label_b_production.games"]},
    ],
    "master_tables": [
        {
            "table": "xlabel_prod.master.master_table",
            "label_column": "label",
            "readers": "all_labels",
        }
    ],
}


class FakeWorkspace:
    def __init__(self) -> None:
        self.grants: dict[tuple[str, str, str], set[str]] = {}
        self.row_filters: dict[str, str] = {}
        self.statements: list[str] = []
        self.unreadable: set[str] = set()
        self.open_schemas = False
        self.owners: dict[str, str] = {}
        self.open_catalogs: set[str] = set()

    def __call__(self, method: str, path: str, query=None, body=None):
        parts = path.split("/")
        if method == "PATCH" and "/permissions/" in path:
            kind, name = parts[-2], parts[-1]
            for change in body["changes"]:
                self.grants.setdefault((kind, name, change["principal"]), set()).update(
                    change["add"]
                )
            return {}
        if method == "GET" and "/effective-permissions/" in path:
            kind, name = parts[-2], parts[-1]
            if kind in self.unreadable:
                raise PermissionError("denied")
            held = set(self.grants.get((kind, name, query["principal"]), set()))
            if self.open_schemas and kind == "schema":
                held |= {"ALL_PRIVILEGES"}
            return {
                "privilege_assignments": [{"privileges": [{"privilege": p} for p in sorted(held)]}]
            }
        if method == "GET" and ("/catalogs/" in path or "/schemas/" in path):
            name = parts[-1]
            isolation = "OPEN" if name in self.open_catalogs else "ISOLATED"
            return {"owner": self.owners.get(name, "Data_Governance"), "isolation_mode": isolation}
        if method == "GET" and "/permissions/" in path:
            kind, name = parts[-2], parts[-1]
            held = [
                {"principal": principal, "privileges": sorted(privileges)}
                for (k, n, principal), privileges in self.grants.items()
                if (k, n) == (kind, name)
            ]
            return {"privilege_assignments": held}
        if method == "GET" and "/tables/" in path:
            name = parts[-1]
            return (
                {"row_filter": {"function_name": self.row_filters[name]}}
                if name in self.row_filters
                else {}
            )
        if method == "POST" and path == "/api/2.0/sql/statements":
            statement = body["statement"]
            self.statements.append(statement)
            if statement.startswith("ALTER TABLE "):
                table = statement.split()[2]
                self.row_filters[table] = statement.split(" SET ROW FILTER ")[1].split()[0]
            return {"status": {"state": "SUCCEEDED"}}
        raise AssertionError(f"unexpected call {method} {path}")


class Client:
    def __init__(self, api: FakeWorkspace) -> None:
        self.api_client = type("ApiClient", (), {"do": staticmethod(api)})()


def run(fake: FakeWorkspace, mode: str, config=None, **kwargs) -> tuple[list[str], list[str]]:
    lines: list[str] = []
    failures = label_access.run(
        config or CONFIG, mode, client=Client(fake), out=lines.append, **kwargs
    )
    return failures, lines


class LabelAccessModuleTest(unittest.TestCase):
    def test_plan_changes_nothing(self) -> None:
        fake = FakeWorkspace()
        failures, lines = run(fake, "plan")
        self.assertEqual(failures, [])
        self.assertEqual(fake.grants, {})
        self.assertIn("SET ROW FILTER", "\n".join(lines))

    def test_apply_grants_filters_and_verifies(self) -> None:
        fake = FakeWorkspace()
        failures, _ = run(fake, "apply", warehouse_id="wh-1")
        self.assertEqual(failures, [])
        self.assertIn("SELECT", fake.grants[("schema", "prod.label_a", "Label_A")])
        self.assertNotIn(("schema", "prod.label_b", "Label_A"), fake.grants)
        self.assertEqual(fake.row_filters["prod.xlabel.master"], "prod.xlabel.master_label_filter")

    def test_apply_refuses_row_filter_sql_without_a_warehouse(self) -> None:
        with self.assertRaises(RuntimeError):
            run(FakeWorkspace(), "apply")

    def test_verify_reports_a_cross_label_read(self) -> None:
        fake = FakeWorkspace()
        run(fake, "apply", warehouse_id="wh-1")
        fake.open_schemas = True
        failures, _ = run(fake, "verify")
        self.assertIn(
            "Label_A can read another label's schema prod.label_b (holds: ALL_PRIVILEGES)", failures
        )

    def test_verify_fails_closed_when_privileges_cannot_be_read(self) -> None:
        fake = FakeWorkspace()
        run(fake, "apply", warehouse_id="wh-1")
        fake.unreadable = {"schema"}
        failures, lines = run(fake, "verify")
        self.assertIn("Label_A on prod.label_b could not be read", failures)
        self.assertFalse(any(line.startswith("  ok   Label_A: reads") for line in lines))

    def test_verify_fails_a_central_only_table_it_cannot_read(self) -> None:
        config = {**CONFIG, "master_tables": [{**CONFIG["master_tables"][0], "readers": "central"}]}
        fake = FakeWorkspace()
        run(fake, "apply", config=config, warehouse_id="wh-1")
        fake.unreadable = {"table"}
        failures, lines = run(fake, "verify", config=config)
        self.assertIn("Label_A on prod.xlabel.master could not be read", failures)
        self.assertNotIn("  ok   prod.xlabel.master: no label group reads it", lines)

    def test_scope_is_checked_only_when_known(self) -> None:
        fake = FakeWorkspace()
        run(fake, "apply", warehouse_id="wh-1")
        failures, lines = run(fake, "verify")
        self.assertEqual(failures, [])
        self.assertTrue(any("not known here" in line for line in lines))
        failures, _ = run(fake, "verify", scope=["prod.label_a", "prod.global_production"])
        self.assertIn("outside the agent's read scope: B: prod.label_b", failures)

    def test_rejects_a_name_that_is_not_plain(self) -> None:
        for config in [
            {**CONFIG, "catalog": "prod; DROP"},
            {**CONFIG, "shared_schemas": ["prod.global; DROP"]},
            {**CONFIG, "shared_schemas": ["a.b.c"]},
        ]:
            with (
                self.subTest(config=config["catalog"]),
                self.assertRaises(label_access.ConfigError),
            ):
                label_access.build_plan(config)

    def test_each_label_may_have_a_catalog_of_its_own(self) -> None:
        plan = label_access.build_plan(LABEL_CATALOGS)
        self.assertIn(["catalog", "label_a_production", "Label_A", ["USE_CATALOG"]], plan["grants"])
        self.assertIn(["catalog", "global_production", "Label_A", ["USE_CATALOG"]], plan["grants"])
        self.assertNotIn(
            ["catalog", "label_b_production", "Label_A", ["USE_CATALOG"]], plan["grants"]
        )
        self.assertIn(
            ["schema", "label_b_production.games", "Central", ["USE_SCHEMA", "SELECT"]],
            plan["grants"],
        )
        fake = FakeWorkspace()
        failures, _ = run(fake, "apply", config=LABEL_CATALOGS, warehouse_id="wh-1")
        self.assertEqual(failures, [])
        fake.open_schemas = True
        failures, _ = run(fake, "verify", config=LABEL_CATALOGS)
        self.assertIn(
            "Label_A can read another label's schema label_b_production.games (holds: ALL_PRIVILEGES)",
            failures,
        )

    def test_the_access_matrix_is_the_one_the_architecture_states(self) -> None:
        rows = label_access.access_matrix(label_access.build_plan(LABEL_CATALOGS))
        self.assertEqual(
            rows,
            [
                [
                    "",
                    "label_a_production.games",
                    "label_b_production.games",
                    "global_production.shared",
                    "xlabel_prod.master.master_table",
                ],
                ["Label_A", "reads", "no", "reads", "own rows"],
                ["Label_B", "no", "reads", "reads", "own rows"],
                ["Central", "reads", "reads", "reads", "all rows"],
                ["App_SP", "no", "no", "no", "no"],
            ],
        )
        central_only = {
            **LABEL_CATALOGS,
            "master_tables": [{**LABEL_CATALOGS["master_tables"][0], "readers": "central"}],
        }
        rows = label_access.access_matrix(label_access.build_plan(central_only))
        self.assertEqual([row[-1] for row in rows[1:]], ["no", "no", "all rows", "no"])

    def test_an_identity_that_must_hold_no_label_data_fails_when_it_holds_some(self) -> None:
        fake = FakeWorkspace()
        run(fake, "apply", config=LABEL_CATALOGS, warehouse_id="wh-1")
        failures, lines = run(fake, "verify", config=LABEL_CATALOGS)
        self.assertEqual(failures, [])
        self.assertIn("  ok   App_SP: no label data", lines)
        fake.grants[("table", "xlabel_prod.master.master_table", "App_SP")] = {"SELECT"}
        failures, _ = run(fake, "verify", config=LABEL_CATALOGS)
        self.assertEqual(
            failures,
            [
                "App_SP can read xlabel_prod.master.master_table, and must hold no label data (holds: SELECT)"
            ],
        )

    def test_a_person_owning_a_label_schema_fails(self) -> None:
        fake = FakeWorkspace()
        run(fake, "apply", warehouse_id="wh-1")
        fake.owners["prod.label_a"] = "someone@example.com"
        failures, _ = run(fake, "verify")
        self.assertEqual(
            failures,
            ["prod.label_a is owned by a person (someone@example.com); make a group the owner"],
        )
        failures, _ = run(fake, "verify", config={**CONFIG, "owners_must_be_groups": False})
        self.assertEqual(failures, [])

    def test_workspace_binding_is_checked_when_asked(self) -> None:
        fake = FakeWorkspace()
        run(fake, "apply", warehouse_id="wh-1")
        fake.open_catalogs = {"prod"}
        failures, _ = run(fake, "verify")
        self.assertEqual(failures, [])
        failures, _ = run(fake, "verify", config={**CONFIG, "require_workspace_binding": True})
        self.assertEqual(
            failures,
            ["prod is open to every workspace on the metastore; bind it to the ones that need it"],
        )

    def test_export_lists_owners_and_grants_and_changes_nothing(self) -> None:
        fake = FakeWorkspace()
        run(fake, "apply", warehouse_id="wh-1")
        before = dict(fake.grants)
        _, lines = run(fake, "export")
        exported = {(e["kind"], e["name"]): e for e in json.loads(lines[-1])}
        self.assertEqual(fake.grants, before)
        self.assertEqual(exported[("schema", "prod.label_a")]["owner"], "Data_Governance")
        self.assertIn(
            {"principal": "Label_A", "privileges": ["SELECT", "USE_SCHEMA"]},
            exported[("schema", "prod.label_a")]["grants"],
        )
        self.assertIn(("table", "prod.xlabel.master"), exported)


if __name__ == "__main__":
    unittest.main(verbosity=2)
