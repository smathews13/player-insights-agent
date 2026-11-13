#!/usr/bin/env python3
"""The release manifest against what Unity Catalog actually allows.

The manifest is the reviewed list of tables a release may answer from. It lives
in the deployment's private config repository, beside the label access config,
with data governance as its required reviewer. This check fails on drift in
either direction, and on a Genie space that reaches past it:

  * a listed group can SELECT a table inside the agent's data scope that the
    manifest does not name (granted but not reviewed);
  * a manifest table does not exist, is outside the data scope, or no listed
    group can read it (reviewed but not granted);
  * a Genie space the release uses names a table the manifest does not.

Effective privileges are read, so a grant inherited from a catalog, a schema or
another group counts.

    python3 bundle/manifest_drift.py --config <file> [--profile <p>]

Config: {"manifest": [...], "groups": [...], "data_schemas": [...],
"genie_spaces": [...]}; bundle/manifest-drift.sh builds it from the bundle and
the manifest file. Exit 0 on no drift, 1 on drift, 2 when something could not
be read.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse
from collections.abc import Callable
from typing import Any

READ = {"SELECT", "ALL_PRIVILEGES", "ALL PRIVILEGES"}

Api = Callable[[str], Any]


class Unreadable(Exception):
    pass


def cli_api(profile: str | None) -> Api:
    def get(path: str) -> Any:
        command = ["databricks", "api", "get", path, "-o", "json"]
        if profile:
            command += ["--profile", profile]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            lines = result.stderr.strip().splitlines()
            raise Unreadable(lines[-1] if lines else f"GET {path} failed")
        return json.loads(result.stdout or "{}")

    return get


def tables_in(api: Api, schema: str) -> list[str]:
    catalog, name = schema.split(".", 1)
    found: list[str] = []
    token = ""
    while True:
        query = {"catalog_name": catalog, "schema_name": name, "max_results": "500"}
        if token:
            query["page_token"] = token
        body = api(f"/api/2.1/unity-catalog/tables?{urllib.parse.urlencode(query)}")
        found += [
            str(t["full_name"]).lower() for t in body.get("tables") or [] if t.get("full_name")
        ]
        token = body.get("next_page_token") or ""
        if not token:
            return found


def can_read(api: Api, table: str, principal: str) -> bool:
    query = urllib.parse.urlencode({"principal": principal}, quote_via=urllib.parse.quote)
    body = api(f"/api/2.1/unity-catalog/effective-permissions/table/{table}?{query}")
    held = {
        str(p.get("privilege"))
        for assignment in body.get("privilege_assignments") or []
        for p in assignment.get("privileges") or []
    }
    return bool(held & READ)


def genie_tables(api: Api, space_id: str) -> set[str]:
    space = api(f"/api/2.0/genie/spaces/{space_id}?include_serialized_space=true")
    raw = space.get("serialized_space") or "{}"
    document = json.loads(raw) if isinstance(raw, str) else raw
    tables = (document.get("data_sources") or {}).get("tables") or []
    return {
        str(t.get("identifier") or "").strip("`").lower() for t in tables if t.get("identifier")
    }


def check(api: Api, config: dict) -> list[tuple[str, str]]:
    manifest = {str(t).strip().lower() for t in config.get("manifest") or []}
    groups = [g for g in config.get("groups") or [] if g]
    scopes = [str(s).lower() for s in config.get("data_schemas") or [] if s]
    if not manifest:
        raise Unreadable("the manifest names no tables")
    if not groups:
        raise Unreadable("no groups to check; set the access groups or the manifest's groups")
    results: list[tuple[str, str]] = []

    in_scope: set[str] = set()
    for schema in scopes:
        in_scope.update(tables_in(api, schema))

    for table in sorted(manifest):
        if ".".join(table.split(".")[:2]) not in scopes:
            results.append(
                ("FAIL", f"{table} is in the manifest but outside the agent's data scope.")
            )
        elif table not in in_scope:
            results.append(("FAIL", f"{table} is in the manifest but does not exist."))
        elif not any(can_read(api, table, g) for g in groups):
            results.append(("FAIL", f"{table} is in the manifest but no listed group can read it."))
        else:
            results.append(("PASS", f"{table} is in the manifest and readable."))

    for table in sorted(in_scope - manifest):
        readers = [g for g in groups if can_read(api, table, g)]
        if readers:
            results.append(
                ("FAIL", f"{', '.join(readers)} can read {table}, which is not in the manifest.")
            )

    for space in [s for s in config.get("genie_spaces") or [] if s]:
        extra = sorted(genie_tables(api, space) - manifest)
        if extra:
            results.append(
                (
                    "FAIL",
                    f"Genie space {space} uses tables not in the manifest: {', '.join(extra)}.",
                )
            )
        else:
            results.append(("PASS", f"Genie space {space} uses only manifest tables."))
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--config", required=True)
    parser.add_argument("--profile")
    args = parser.parse_args(argv)
    with open(args.config) as handle:
        config = json.load(handle)
    try:
        results = check(cli_api(args.profile), config)
    except (Unreadable, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    for status, message in results:
        print(f"  {status:<5} {message}")
    failed = sum(1 for status, _ in results if status == "FAIL")
    print(
        f"{failed} drift finding(s)."
        if failed
        else "No drift between the manifest, the grants and Genie."
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
