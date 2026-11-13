#!/usr/bin/env python3
"""Offline cases for bundle/identity_masks.py, against a fake workspace."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import identity_masks as masks  # noqa: E402

READER = "Example_PIA_Engineer"
TABLE = "main.games.players"
CONFIG = {
    "warehouse_id": "wh1",
    "governance_schema": "main.governance",
    "privileged_group": "Example_Identity_Readers",
    "salt_secret": {"scope": "governance", "key": "identity-mask-salt"},
    "reader_groups": [READER],
    "columns": [f"{TABLE}.player_id", f"{TABLE}.email"],
}
SALT = "main.governance.mask_salt"


class FakeWorkspace:
    def __init__(self) -> None:
        mask = {"function_name": "main.governance.mask_identity"}
        self.tables = {
            TABLE: {
                "columns": [{"name": "player_id", "mask": mask}, {"name": "email", "mask": mask}]
            }
        }
        self.privileges: dict[tuple[str, str], list[str]] = {}
        self.statements: list[str] = []
        self.unknown: set[str] = set()

    def __call__(self, method: str, path: str, body: dict | None = None):
        if path == "/api/2.0/sql/statements":
            self.statements.append(body["statement"])
            if "information_schema" in body["statement"]:
                rows = [
                    ["players", "player_id", "STRING"],
                    ["players", "crm_customer_ref", "STRING"],
                    ["players", "email", "STRING"],
                    ["players", "email_addressability_status", "STRING"],
                    ["players", "account_id", "BIGINT"],
                    ["players", "revenue", "DECIMAL"],
                ]
                return {"status": {"state": "SUCCEEDED"}, "result": {"data_array": rows}}
            return {"status": {"state": "SUCCEEDED"}}
        if path.startswith("/api/2.1/unity-catalog/tables/"):
            return copy.deepcopy(self.tables[path.rsplit("/", 1)[1]])
        if path.startswith("/api/2.1/unity-catalog/effective-permissions/table/"):
            name, query = path.rsplit("/", 1)[1].split("?")
            principal = query.split("=", 1)[1].replace("+", " ")
            if principal in self.unknown:
                raise masks.Unreadable("Error: Could not find principal with name " + principal)
            held = self.privileges.get((name, principal), [])
            return {"privilege_assignments": [{"privileges": [{"privilege": p} for p in held]}]}
        raise AssertionError(f"unexpected {method} {path}")


def failures(api: FakeWorkspace, config: dict = CONFIG) -> list[str]:
    return [message for status, message in masks.verify(api, config) if status == "FAIL"]


class PlanTest(unittest.TestCase):
    def test_salt_is_copied_from_the_secret_and_read_by_the_mask(self) -> None:
        statements = masks.plan(CONFIG)
        self.assertIn("SELECT secret('governance', 'identity-mask-salt')", statements[2])
        self.assertIn("is_account_group_member('Example_Identity_Readers') THEN val", statements[3])
        self.assertIn(
            "sha2(concat(val, (SELECT max(salt) FROM `main`.`governance`.`mask_salt`)), 256)",
            statements[3],
        )
        self.assertNotIn("secret(", statements[3])
        self.assertEqual(
            statements[4:],
            [
                f"ALTER TABLE `main`.`games`.`players` ALTER COLUMN `{column}` SET MASK "
                "`main`.`governance`.`mask_identity`"
                for column in ("player_id", "email")
            ],
        )

    def test_names_that_are_not_plain_identifiers_are_refused(self) -> None:
        for column in [
            "main.games.players.id`; DROP TABLE x; --",
            "main.games.player_id",
            "a.b.c.d e",
        ]:
            with self.subTest(column=column), self.assertRaises(ValueError):
                masks.plan({**CONFIG, "columns": [column]})

    def test_quotes_in_the_group_name_cannot_end_the_literal(self) -> None:
        statement = masks.plan({**CONFIG, "privileged_group": "x') OR true OR ('"})[3]
        self.assertIn("is_account_group_member('x\\') OR true OR (\\'')", statement)

    def test_missing_settings_are_refused(self) -> None:
        for key in ["governance_schema", "privileged_group", "salt_secret", "columns"]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                masks.plan({k: v for k, v in CONFIG.items() if k != key})


class InventoryTest(unittest.TestCase):
    def test_lists_identity_columns_and_flags_ones_a_string_mask_cannot_cover(self) -> None:
        found = masks.inventory(FakeWorkspace(), "wh1", ["main.games"])
        self.assertEqual(
            [(row["column"].rsplit(".", 1)[1], row["maskable"]) for row in found],
            [
                ("player_id", True),
                ("crm_customer_ref", True),
                ("email", True),
                ("account_id", False),
            ],
        )


class VerifyTest(unittest.TestCase):
    def test_masked_columns_and_a_private_salt_pass(self) -> None:
        self.assertEqual(failures(FakeWorkspace()), [])

    def test_an_unmasked_column_fails(self) -> None:
        api = FakeWorkspace()
        api.tables[TABLE]["columns"][1].pop("mask")
        self.assertEqual(
            failures(api),
            [f"{TABLE}.email is not masked by main.governance.mask_identity (no mask)."],
        )

    def test_a_reader_who_can_read_the_salt_fails(self) -> None:
        api = FakeWorkspace()
        api.privileges[(SALT, "account users")] = ["SELECT"]
        self.assertEqual(
            failures(api), [f"account users can read the mask salt in {SALT} (SELECT)."]
        )

    def test_a_reader_who_can_drop_the_mask_fails(self) -> None:
        api = FakeWorkspace()
        api.privileges[(TABLE, READER)] = ["SELECT", "MANAGE"]
        self.assertEqual(
            failures(api), [f"{READER} can change or drop the mask on {TABLE} (MANAGE)."]
        )

    def test_a_workspace_local_reader_group_fails(self) -> None:
        api = FakeWorkspace()
        api.unknown.add(READER)
        self.assertEqual(
            failures(api),
            [f"Unity Catalog does not know {READER}; grant and check account-level groups."],
        )


if __name__ == "__main__":
    unittest.main()
