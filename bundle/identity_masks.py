#!/usr/bin/env python3
"""Player identity columns masked in Unity Catalog, for every client, not only PIA.

A reader outside the privileged group sees a salted SHA-256 of each identity
value, so COUNT(DISTINCT col) and joins on the column still work but the raw
value never leaves Unity Catalog. Members of the privileged account group see
the raw value.

THE SALT. It is kept in a Databricks secret, and that secret cannot be read from
inside the mask: `secret()` runs as the person querying, so it would either fail
for every reader or require granting them the salt. Instead --apply copies the
secret (as the operator, who must hold READ on the scope) into a one-row table in
the governance schema, and the mask reads that table. A mask reads the tables it
names with its owner's rights, so readers need no grant on it, and --verify
fails if any reader group can SELECT it. Re-run --apply after rotating the
secret; every hash changes, so rotate only with the people who rely on them.

    python3 bundle/identity_masks.py --inventory --schemas cat.schema[,cat.schema] --warehouse ID
    python3 bundle/identity_masks.py --plan   --config masks.json
    python3 bundle/identity_masks.py --apply  --config masks.json [--profile P]
    python3 bundle/identity_masks.py --verify --config masks.json [--profile P]

Config: see bundle/identity-masks.example.json. Exit 0 on success, 1 on a
verify finding, 2 when something could not be read or run.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
import time
import urllib.parse
from collections.abc import Callable
from typing import Any

IDENTIFIER = re.compile(r"^[A-Za-z0-9_\-]+$")
# Column names that usually carry a person's identity. A review step, not a
# guarantee: the inventory is a starting list for data governance to confirm.
IDENTITY_COLUMN = re.compile(
    r"(^|_)(cdp_)?(customer|player|user|account|member|device|profile|gamer|psn|xbox|steam|social)_?"
    r"(id|uuid|guid|key|tag|name)$|(^|_)(email|email_address|phone|phone_number|ip|ip_address|gamertag|username|handle)$",
    re.IGNORECASE,
)
MASK_FUNCTION = "mask_identity"
SALT_TABLE = "mask_salt"
READ_PRIVILEGES = {"SELECT", "ALL_PRIVILEGES", "ALL PRIVILEGES"}
CONTROL_PRIVILEGES = {"MANAGE", "MODIFY", "ALL_PRIVILEGES", "ALL PRIVILEGES"}

Api = Callable[[str, str, dict | None], Any]


class Unreadable(Exception):
    pass


def quoted(name: str) -> str:
    """`a`.`b`.`c` for a dotted name, refusing anything that is not a plain identifier."""
    parts = name.split(".")
    if not parts or not all(IDENTIFIER.match(part) for part in parts):
        raise ValueError(f"{name!r} is not a plain catalog/schema/table/column name")
    return ".".join(f"`{part}`" for part in parts)


def literal(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def split_column(full: str) -> tuple[str, str]:
    parts = full.split(".")
    if len(parts) != 4:
        raise ValueError(f"{full!r} must be catalog.schema.table.column")
    return ".".join(parts[:3]), parts[3]


def validate(config: dict) -> dict:
    for key in ("governance_schema", "privileged_group", "salt_secret", "columns"):
        if not config.get(key):
            raise ValueError(f"the config needs {key}")
    if len(config["governance_schema"].split(".")) != 2:
        raise ValueError("governance_schema must be catalog.schema")
    secret = config["salt_secret"]
    if not secret.get("scope") or not secret.get("key"):
        raise ValueError("salt_secret needs scope and key")
    for column in config["columns"]:
        table, name = split_column(column)
        quoted(table)
        quoted(name)
    return config


def plan(config: dict) -> list[str]:
    config = validate(config)
    schema = quoted(config["governance_schema"])
    salt = f"{schema}.`{SALT_TABLE}`"
    function = f"{schema}.`{MASK_FUNCTION}`"
    secret = config["salt_secret"]
    statements = [
        f"CREATE SCHEMA IF NOT EXISTS {schema}",
        f"CREATE TABLE IF NOT EXISTS {salt} (salt STRING)",
        f"INSERT OVERWRITE {salt} "
        f"SELECT secret({literal(secret['scope'])}, {literal(secret['key'])})",
        f"CREATE OR REPLACE FUNCTION {function}(val STRING) RETURNS STRING "
        "COMMENT 'Raw value for the privileged group; salted SHA-256 for everyone else' "
        f"RETURN CASE WHEN is_account_group_member({literal(config['privileged_group'])}) THEN val "
        f"WHEN val IS NULL THEN NULL "
        f"ELSE sha2(concat(val, (SELECT max(salt) FROM {salt})), 256) END",
    ]
    for column in config["columns"]:
        table, name = split_column(column)
        statements.append(f"ALTER TABLE {quoted(table)} ALTER COLUMN `{name}` SET MASK {function}")
    return statements


def cli_api(profile: str | None) -> Api:
    def call(method: str, path: str, body: dict | None = None) -> Any:
        command = ["databricks", "api", method.lower(), path, "-o", "json"]
        if body is not None:
            command += ["--json", json.dumps(body)]
        if profile:
            command += ["--profile", profile]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            lines = result.stderr.strip().splitlines()
            raise Unreadable(lines[-1] if lines else f"{method} {path} failed")
        return json.loads(result.stdout or "{}")

    return call


def run_statement(api: Api, warehouse_id: str, statement: str) -> list[list[Any]]:
    response = api(
        "POST",
        "/api/2.0/sql/statements",
        {"warehouse_id": warehouse_id, "statement": statement, "wait_timeout": "50s"},
    )
    while (response.get("status") or {}).get("state") in ("PENDING", "RUNNING"):
        time.sleep(2)
        response = api("GET", f"/api/2.0/sql/statements/{response['statement_id']}", None)
    status = response.get("status") or {}
    if status.get("state") != "SUCCEEDED":
        raise Unreadable(
            (status.get("error") or {}).get("message") or f"statement ended {status.get('state')}"
        )
    return (response.get("result") or {}).get("data_array") or []


def inventory(api: Api, warehouse_id: str, schemas: list[str]) -> list[dict]:
    found = []
    for scope in schemas:
        catalog, schema = scope.split(".")
        quoted(scope)
        rows = run_statement(
            api,
            warehouse_id,
            "SELECT table_name, column_name, data_type "
            f"FROM `{catalog}`.information_schema.columns "
            f"WHERE table_schema = {literal(schema)} ORDER BY table_name, ordinal_position",
        )
        for table, column, data_type in rows:
            if IDENTITY_COLUMN.search(str(column)):
                found.append(
                    {
                        "column": f"{catalog}.{schema}.{table}.{column}",
                        "data_type": data_type,
                        "maskable": str(data_type).upper() == "STRING",
                    }
                )
    return found


def apply(api: Api, config: dict) -> None:
    for statement in plan(config):
        print(f"  run   {statement.split(' RETURN ')[0]}")
        run_statement(api, config["warehouse_id"], statement)


def effective(api: Api, kind: str, name: str, principal: str) -> set[str]:
    query = urllib.parse.urlencode({"principal": principal})
    body = api("GET", f"/api/2.1/unity-catalog/effective-permissions/{kind}/{name}?{query}", None)
    return {
        str(p.get("privilege"))
        for assignment in body.get("privilege_assignments") or []
        for p in assignment.get("privileges") or []
    }


def verify(api: Api, config: dict) -> list[tuple[str, str]]:
    config = validate(config)
    results: list[tuple[str, str]] = []
    expected = f"{config['governance_schema']}.{MASK_FUNCTION}".lower()
    readers = [*config.get("reader_groups", []), "account users"]
    tables: dict[str, dict] = {}
    for column in config["columns"]:
        table, name = split_column(column)
        if table not in tables:
            tables[table] = api("GET", f"/api/2.1/unity-catalog/tables/{table}", None)
        match = next((c for c in tables[table].get("columns") or [] if c.get("name") == name), None)
        mask = str(((match or {}).get("mask") or {}).get("function_name") or "").lower()
        if match is None:
            results.append(("FAIL", f"{column} does not exist."))
        elif mask != expected:
            results.append(("FAIL", f"{column} is not masked by {expected} ({mask or 'no mask'})."))
        else:
            results.append(("PASS", f"{column} is masked."))
    salt = f"{config['governance_schema']}.{SALT_TABLE}"
    for group in readers:
        try:
            held = effective(api, "table", salt, group) & READ_PRIVILEGES
        except Unreadable as error:
            if "Could not find principal" not in str(error):
                raise
            results.append(
                (
                    "FAIL",
                    f"Unity Catalog does not know {group}; grant and check account-level groups.",
                )
            )
            continue
        results.append(
            ("FAIL", f"{group} can read the mask salt in {salt} ({', '.join(sorted(held))}).")
            if held
            else ("PASS", f"{group} cannot read the mask salt.")
        )
        for table in tables:
            control = effective(api, "table", table, group) & CONTROL_PRIVILEGES
            if control:
                results.append(
                    (
                        "FAIL",
                        f"{group} can change or drop the mask on {table} "
                        f"({', '.join(sorted(control))}).",
                    )
                )
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inventory", action="store_true")
    mode.add_argument("--plan", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--verify", action="store_true")
    parser.add_argument("--config")
    parser.add_argument("--schemas", help="comma-separated catalog.schema list for --inventory")
    parser.add_argument("--warehouse", help="SQL warehouse ID for --inventory")
    parser.add_argument("--out", help="CSV path for --inventory (default: stdout)")
    parser.add_argument("--profile")
    args = parser.parse_args(argv)
    api = cli_api(args.profile)
    try:
        if args.inventory:
            if not args.schemas or not args.warehouse:
                parser.error("--inventory needs --schemas and --warehouse")
            rows = inventory(api, args.warehouse, [s for s in args.schemas.split(",") if s])
            out = open(args.out, "w", newline="") if args.out else sys.stdout  # noqa: SIM115
            writer = csv.DictWriter(out, fieldnames=["column", "data_type", "maskable"])
            writer.writeheader()
            writer.writerows(rows)
            if args.out:
                out.close()
            return 0
        if not args.config:
            parser.error("--plan, --apply and --verify need --config")
        with open(args.config) as handle:
            config = json.load(handle)
        if args.plan:
            print(";\n".join(plan(config)) + ";")
            return 0
        if args.apply:
            if not config.get("warehouse_id"):
                parser.error("--apply needs warehouse_id in the config")
            apply(api, config)
            print("  done  Run --verify next.")
            return 0
        results = verify(api, config)
        for status, message in results:
            print(f"  {status:<5} {message}")
        return 1 if any(status == "FAIL" for status, _ in results) else 0
    except (Unreadable, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
