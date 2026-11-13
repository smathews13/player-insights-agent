#!/usr/bin/env python3
"""Offline cases for bundle/manifest_drift.py, against a fake workspace."""

from __future__ import annotations

import json
import sys
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import manifest_drift as drift  # noqa: E402

GROUP = "Example_PIA_Engineer"
GOLD, RAW = "main.games.gold_players", "main.games.raw_players"
CONFIG = {
    "manifest": [GOLD],
    "groups": [GROUP],
    "data_schemas": ["main.games"],
    "genie_spaces": ["space1"],
}


class FakeWorkspace:
    def __init__(self) -> None:
        self.tables = {"main.games": [GOLD, RAW]}
        self.readable = {(GOLD, GROUP)}
        self.genie = {"space1": [GOLD]}
        self.pages = False

    def __call__(self, path: str):
        url = urllib.parse.urlsplit(path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if url.path == "/api/2.1/unity-catalog/tables":
            tables = self.tables[f"{query['catalog_name']}.{query['schema_name']}"]
            if self.pages and "page_token" not in query:
                return {"tables": [{"full_name": tables[0]}], "next_page_token": "next"}
            rest = tables[1:] if self.pages else tables
            return {"tables": [{"full_name": t} for t in rest]}
        if url.path.startswith("/api/2.1/unity-catalog/effective-permissions/table/"):
            table = url.path.rsplit("/", 1)[1]
            held = ["SELECT"] if (table, query["principal"]) in self.readable else []
            return {"privilege_assignments": [{"privileges": [{"privilege": p} for p in held]}]}
        if url.path.startswith("/api/2.0/genie/spaces/"):
            space = url.path.rsplit("/", 1)[1]
            tables = [{"identifier": f"`{t}`"} for t in self.genie[space]]
            return {"serialized_space": json.dumps({"data_sources": {"tables": tables}})}
        raise AssertionError(f"unexpected GET {path}")


def failures(api: FakeWorkspace, config: dict = CONFIG) -> list[str]:
    return [message for status, message in drift.check(api, config) if status == "FAIL"]


class ManifestDriftTest(unittest.TestCase):
    def test_no_drift_passes(self) -> None:
        self.assertEqual(failures(FakeWorkspace()), [])

    def test_a_readable_table_missing_from_the_manifest_fails(self) -> None:
        api = FakeWorkspace()
        api.readable.add((RAW, GROUP))
        self.assertEqual(failures(api), [f"{GROUP} can read {RAW}, which is not in the manifest."])

    def test_a_manifest_table_no_group_can_read_fails(self) -> None:
        api = FakeWorkspace()
        api.readable.clear()
        self.assertEqual(
            failures(api), [f"{GOLD} is in the manifest but no listed group can read it."]
        )

    def test_a_manifest_table_that_is_missing_or_out_of_scope_fails(self) -> None:
        config = {**CONFIG, "manifest": [GOLD, "main.games.gone", "other.schema.table"]}
        self.assertEqual(
            failures(FakeWorkspace(), config),
            [
                "main.games.gone is in the manifest but does not exist.",
                "other.schema.table is in the manifest but outside the agent's data scope.",
            ],
        )

    def test_a_genie_space_reaching_past_the_manifest_fails(self) -> None:
        api = FakeWorkspace()
        api.genie["space1"] = [GOLD, RAW]
        self.assertEqual(
            failures(api), [f"Genie space space1 uses tables not in the manifest: {RAW}."]
        )

    def test_every_page_of_tables_is_read(self) -> None:
        api = FakeWorkspace()
        api.pages = True
        api.readable.add((RAW, GROUP))
        self.assertIn(f"{GROUP} can read {RAW}, which is not in the manifest.", failures(api))

    def test_names_compare_without_case(self) -> None:
        self.assertEqual(failures(FakeWorkspace(), {**CONFIG, "manifest": [GOLD.upper()]}), [])

    def test_an_empty_manifest_or_no_groups_cannot_pass(self) -> None:
        for config in [{**CONFIG, "manifest": []}, {**CONFIG, "groups": []}]:
            with self.assertRaises(drift.Unreadable):
                drift.check(FakeWorkspace(), config)


if __name__ == "__main__":
    unittest.main()
