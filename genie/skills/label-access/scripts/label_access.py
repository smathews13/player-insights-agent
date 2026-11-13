#!/usr/bin/env python3
"""Grant, and prove, one data group per label in Unity Catalog.

The one implementation of the label access plan. bundle/label-access.sh builds
its plan here (--plan-json) and applies it with the Databricks CLI; Genie Code
imports this module and applies the same plan with the workspace client.

In a Databricks notebook:

    import sys
    sys.path.append("/Workspace/.assistant/skills/label-access/scripts")
    import label_access
    label_access.run("/Workspace/Users/<you>/label-access.json", mode="plan")
    label_access.run(config_path, mode="verify")
    label_access.run(config_path, mode="apply", warehouse_id="<warehouse id>")

From a shell, with a configured Databricks profile:

    python3 label_access.py --config <file> [--apply --warehouse-id <id> | --verify | --export] [--profile <p>]

Plan prints the grants, the row-filter SQL and the access matrix, and changes
nothing. Apply adds the grants (add-only; nothing is revoked), creates and
attaches each master table's row filter, then verifies. Verify reads EFFECTIVE
privileges, so a grant inherited from a catalog or another group counts, and
also fails when an identity that must hold no label data can read some, when a
person rather than a group owns a label catalog or schema, or (when asked)
when a label catalog is open to every workspace. Export prints the current
grants and owners for review with data governance.

A schema is `schema` (in `catalog`) or `catalog.schema`, so each label may have
a catalog of its own.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

IDENT = re.compile(r"^[A-Za-z0-9_\-]+$")
GROUP_CHECKS = ("is_account_group_member", "is_member", "current_user")


class ConfigError(ValueError):
    pass


def _need(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"label access config: {what} is missing")
    return value.strip()


def sql_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _schema(value: Any, catalog: str, what: str) -> str:
    name = _need(value, what)
    parts = name.split(".")
    if len(parts) == 1:
        parts = [catalog, name]
    if len(parts) != 2 or not all(IDENT.match(p) for p in parts):
        raise ConfigError(
            f"label access config: '{name}' is not a plain schema or catalog.schema name"
        )
    return ".".join(parts)


def _catalogs(schemas: list[str]) -> list[str]:
    return list(dict.fromkeys(s.split(".")[0] for s in schemas))


def build_plan(config: dict[str, Any], scope: list[str] | None = None) -> dict[str, Any]:
    """The grants, expectations and SQL for a config.

    `scope` is the agent's read scope (catalog or catalog.schema entries). None
    means it is unknown here, so no label is reported outside it.
    """
    catalog = _need(config.get("catalog"), "catalog")
    if not IDENT.match(catalog):
        raise ConfigError(f"label access config: '{catalog}' is not a plain catalog or schema name")
    shared = [
        _schema(s, catalog, "shared_schemas entry") for s in config.get("shared_schemas") or []
    ]
    central = [_need(g, "central_groups entry") for g in config.get("central_groups") or []]
    check = config.get("group_check") or "is_account_group_member"
    if check not in GROUP_CHECKS:
        raise ConfigError(
            "label access config: group_check must be is_account_group_member, is_member or current_user"
        )
    labels = [
        {
            "label": _need(entry.get("label"), "labels[].label"),
            "group": _need(entry.get("group"), "labels[].group"),
            "schemas": [
                _schema(s, catalog, "labels[].schemas entry") for s in entry.get("schemas") or []
            ],
        }
        for entry in config.get("labels") or []
    ]
    if not labels:
        raise ConfigError("label access config: no labels")
    no_data = [_need(p, "no_data_principals entry") for p in config.get("no_data_principals") or []]

    def member(principal: str) -> str:
        # current_user names one principal rather than a group. Only for
        # principals that cannot be grouped in Unity Catalog, as in the E2E test.
        if check == "current_user":
            return f"current_user() = {sql_string(principal)}"
        return f"{check}({sql_string(principal)})"

    masters: list[dict[str, str]] = []
    statements: list[str] = []
    for entry in config.get("master_tables") or []:
        table = _need(entry.get("table"), "master_tables[].table")
        column = _need(entry.get("label_column"), "master_tables[].label_column")
        readers = entry.get("readers") or "central"
        if readers not in ("central", "all_labels"):
            raise ConfigError(
                "label access config: master_tables[].readers must be central or all_labels"
            )
        parts = table.split(".")
        if len(parts) != 3 or not all(IDENT.match(p) for p in parts) or not IDENT.match(column):
            raise ConfigError(
                f"label access config: '{table}' must be catalog.schema.table with a plain column"
            )
        function = entry.get("filter_function") or f"{parts[0]}.{parts[1]}.{parts[2]}_label_filter"
        masters.append({"table": table, "column": column, "readers": readers, "function": function})
        if readers == "all_labels":
            terms = [member(g) for g in central]
            terms += [
                f"({column}_value = {sql_string(label['label'])} AND {member(label['group'])})"
                for label in labels
            ]
            statements.append(
                f"CREATE OR REPLACE FUNCTION {function}({column}_value STRING)\n"
                "RETURNS BOOLEAN\nRETURN " + "\n    OR ".join(terms or ["FALSE"])
            )
            statements.append(f"ALTER TABLE {table} SET ROW FILTER {function} ON ({column})")

    grants: list[list[Any]] = []

    def grant(kind: str, name: str, principal: str, privileges: list[str]) -> None:
        item = [kind, name, principal, privileges]
        if item not in grants:
            grants.append(item)

    every_label_schema = [s for label in labels for s in label["schemas"]]
    for label in labels:
        for name in _catalogs([*label["schemas"], *shared]):
            grant("catalog", name, label["group"], ["USE_CATALOG"])
        for schema in [*label["schemas"], *shared]:
            grant("schema", schema, label["group"], ["USE_SCHEMA", "SELECT"])
    for group in central:
        for name in _catalogs([*every_label_schema, *shared]):
            grant("catalog", name, group, ["USE_CATALOG"])
        for schema in [*every_label_schema, *shared]:
            grant("schema", schema, group, ["USE_SCHEMA", "SELECT"])
    for master in masters:
        m_catalog, m_schema, _ = master["table"].split(".")
        readers = (
            [*central, *(label["group"] for label in labels)]
            if master["readers"] == "all_labels"
            else central
        )
        for group in readers:
            grant("catalog", m_catalog, group, ["USE_CATALOG"])
            grant("schema", f"{m_catalog}.{m_schema}", group, ["USE_SCHEMA"])
            grant("table", master["table"], group, ["SELECT"])

    lowered = None if scope is None else [str(s).strip().lower() for s in scope]

    def in_scope(schema_full: str) -> bool:
        if lowered is None or config.get("check_agent_scope") is False:
            return True
        return schema_full.lower() in lowered or schema_full.split(".")[0].lower() in lowered

    out_of_scope = {
        f"{label['label']}: {s}" for label in labels for s in label["schemas"] if not in_scope(s)
    } | {f"shared: {s}" for s in shared if not in_scope(s)}
    master_schemas = [".".join(m["table"].split(".")[:2]) for m in masters]

    return {
        "catalog": catalog,
        "catalogs": _catalogs([*every_label_schema, *shared, *master_schemas]),
        "schemas": list(dict.fromkeys([*every_label_schema, *shared, *master_schemas])),
        "no_data_principals": no_data,
        "owners_must_be_groups": config.get("owners_must_be_groups", True) is not False,
        "require_workspace_binding": config.get("require_workspace_binding") is True,
        "shared": shared,
        "central": central,
        "labels": labels,
        "masters": masters,
        "statements": statements,
        "grants": grants,
        "out_of_scope": sorted(out_of_scope),
        "scope_known": lowered is not None,
    }


def access_matrix(plan: dict[str, Any]) -> list[list[str]]:
    """Who reads what, as the plan intends it: one row per principal, one column per object."""
    shared, labels, masters = plan["shared"], plan["labels"], plan["masters"]
    columns = [
        *(s for label in labels for s in label["schemas"]),
        *shared,
        *(m["table"] for m in masters),
    ]
    rows = [["", *columns]]

    def cell(column: str, own: list[str] | None) -> str:
        master = next((m for m in masters if m["table"] == column), None)
        if master is not None:
            if own is None:
                return "all rows"
            return "own rows" if master["readers"] == "all_labels" else "no"
        return "reads" if own is None or column in own or column in shared else "no"

    for label in labels:
        rows.append([label["group"], *(cell(c, label["schemas"]) for c in columns)])
    for group in plan["central"]:
        rows.append([group, *(cell(c, None) for c in columns)])
    for principal in plan.get("no_data_principals") or []:
        rows.append([principal, *("no" for _ in columns)])
    return rows


def format_matrix(rows: list[list[str]]) -> str:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return "\n".join(
        "  " + "  ".join(v.ljust(w) for v, w in zip(row, widths, strict=True)).rstrip() for row in rows
    )


def format_plan(plan: dict[str, Any]) -> str:
    lines = ["==> Grants (add-only)"]
    for kind, name, principal, privileges in plan["grants"]:
        lines.append(f"  {kind:<7} {name:<60} {principal}: {', '.join(privileges)}")
    lines.append("")
    lines.append("==> Row filters")
    for master in plan["masters"]:
        if master["readers"] == "central":
            lines.append(f"  {master['table']}: central groups only, no row filter needed")
    for statement in plan["statements"]:
        lines.append("\n" + statement + ";")
    lines.append("")
    lines.append("==> Access matrix (what --verify holds the workspace to)")
    lines.append(format_matrix(access_matrix(plan)))
    return "\n".join(lines)


# --- Workspace calls -------------------------------------------------------
#
# Raw REST through the workspace client, so the module works with any SDK
# version and a test can substitute one callable.

Api = Callable[..., Any]


def workspace_api(client: Any = None) -> Api:
    if client is None:
        from databricks.sdk import WorkspaceClient

        client = WorkspaceClient()
    return client.api_client.do


def cli_api(profile: str | None) -> Api:
    """The same calls through the Databricks CLI, for a shell without the SDK."""

    def call(method: str, path: str, query: dict | None = None, body: dict | None = None) -> Any:
        url = f"{path}?{urlencode(query, quote_via=quote)}" if query else path
        command = ["databricks", "api", method.lower(), url, "-o", "json"]
        if body is not None:
            command += ["--json", json.dumps(body)]
        if profile:
            command += ["--profile", profile]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            lines = result.stderr.strip().splitlines()
            raise RuntimeError(lines[-1] if lines else f"{method} {path} failed")
        return json.loads(result.stdout or "{}")

    return call


def _path(name: str) -> str:
    return quote(name, safe="")


def effective_privileges(api: Api, kind: str, name: str, principal: str) -> set[str] | None:
    """Privileges the principal effectively holds, or None when they cannot be read."""
    try:
        body = api(
            "GET",
            f"/api/2.1/unity-catalog/effective-permissions/{kind}/{_path(name)}",
            query={"principal": principal},
        )
    except Exception:  # noqa: BLE001 - any failure means the answer is unknown
        return None
    held: set[str] = set()
    for assignment in (body or {}).get("privilege_assignments") or []:
        for privilege in assignment.get("privileges") or []:
            held.add(str(privilege.get("privilege", "")))
    return held


def row_filter_of(api: Api, table: str) -> str:
    try:
        body = api("GET", f"/api/2.1/unity-catalog/tables/{_path(table)}")
    except Exception:  # noqa: BLE001
        return ""
    return str(((body or {}).get("row_filter") or {}).get("function_name") or "")


def run_statement(api: Api, warehouse_id: str, statement: str) -> None:
    body = api(
        "POST",
        "/api/2.0/sql/statements",
        body={"warehouse_id": warehouse_id, "statement": statement, "wait_timeout": "50s"},
    )
    status = (body or {}).get("status") or {}
    while status.get("state") in ("PENDING", "RUNNING"):
        time.sleep(2)
        body = api("GET", f"/api/2.0/sql/statements/{body['statement_id']}")
        status = (body or {}).get("status") or {}
    if status.get("state") != "SUCCEEDED":
        message = (status.get("error") or {}).get("message") or status.get("state") or "no state"
        raise RuntimeError(f"SQL failed: {statement.splitlines()[0]}: {message}")


def apply_plan(
    api: Api, plan: dict[str, Any], warehouse_id: str | None, out: Callable[[str], None] = print
) -> None:
    if plan["statements"] and not warehouse_id:
        raise RuntimeError("No warehouse to run the row-filter SQL on. Pass warehouse_id.")
    out("==> Adding grants")
    for kind, name, principal, privileges in plan["grants"]:
        api(
            "PATCH",
            f"/api/2.1/unity-catalog/permissions/{kind}/{_path(name)}",
            body={"changes": [{"principal": principal, "add": privileges}]},
        )
        out(f"  {kind} {name} -> {principal}: {', '.join(privileges)}")
    out("==> Row filters")
    for statement in plan["statements"]:
        run_statement(api, str(warehouse_id), statement)
        out(f"  {statement.splitlines()[0]}")


def _has(held: set[str] | None, privilege: str) -> bool:
    return held is not None and (privilege in held or "ALL_PRIVILEGES" in held)


def verify_plan(api: Api, plan: dict[str, Any], out: Callable[[str], None] = print) -> list[str]:
    """Check every expectation. Returns the failures; empty means all passed."""
    failures: list[str] = []

    def fail(message: str) -> None:
        failures.append(message)
        out(f"  FAIL {message}")

    def ok(message: str) -> None:
        out(f"  ok   {message}")

    out("==> Verifying effective privileges")
    shared, labels = plan["shared"], plan["labels"]
    for label in labels:
        group, own = label["group"], label["schemas"]
        for catalog in _catalogs([*own, *shared]):
            held = effective_privileges(api, "catalog", catalog, group)
            if _has(held, "USE_CATALOG"):
                ok(f"{group}: USE CATALOG {catalog}")
            else:
                fail(f"{group} lacks USE CATALOG on {catalog}")
        for schema in [*own, *shared]:
            held = effective_privileges(api, "schema", schema, group)
            if _has(held, "USE_SCHEMA") and _has(held, "SELECT"):
                ok(f"{group}: reads {schema}")
            else:
                shown = (
                    "could not be read" if held is None else (", ".join(sorted(held)) or "nothing")
                )
                fail(f"{group} cannot read {schema} (holds: {shown})")
        for other_label in labels:
            if other_label is label:
                continue
            for other in other_label["schemas"]:
                if other in own or other in shared:
                    continue
                held = effective_privileges(api, "schema", other, group)
                if held is None:
                    fail(f"{group} on {other} could not be read")
                elif _has(held, "SELECT"):
                    fail(
                        f"{group} can read another label's schema {other} (holds: {', '.join(sorted(held))})"
                    )
                else:
                    ok(f"{group}: no read on {other}")

    for master in plan["masters"]:
        table = master["table"]
        if master["readers"] == "central":
            before = len(failures)
            for label in labels:
                held = effective_privileges(api, "table", table, label["group"])
                if held is None:
                    fail(f"{label['group']} on {table} could not be read")
                elif _has(held, "SELECT"):
                    fail(
                        f"{label['group']} can read {table}, which only central groups should read"
                    )
            if len(failures) == before:
                ok(f"{table}: no label group reads it")
        else:
            found = row_filter_of(api, table)
            if found.lower() == master["function"].lower():
                ok(f"{table} is filtered by {master['function']}")
            else:
                fail(f"{table} has no label row filter (found: {found or 'none'})")

    if plan.get("no_data_principals"):
        out("==> Identities that must hold no label data (PIA reads as the signed-in person)")
        objects = [
            *(("schema", s) for label in labels for s in label["schemas"]),
            *(("schema", s) for s in shared),
            *(("table", m["table"]) for m in plan["masters"]),
        ]
        for principal in plan["no_data_principals"]:
            before = len(failures)
            for kind, name in objects:
                held = effective_privileges(api, kind, name, principal)
                if held is None:
                    fail(f"{principal} on {name} could not be read")
                elif _has(held, "SELECT"):
                    fail(
                        f"{principal} can read {name}, and must hold no label data (holds: {', '.join(sorted(held))})"
                    )
            if len(failures) == before:
                ok(f"{principal}: no label data")

    if plan.get("owners_must_be_groups", True) or plan.get("require_workspace_binding"):
        out("==> Owners and workspace bindings")
        for kind, name in [
            *(("catalogs", c) for c in plan["catalogs"]),
            *(("schemas", s) for s in plan["schemas"]),
        ]:
            try:
                body = api("GET", f"/api/2.1/unity-catalog/{kind}/{_path(name)}") or {}
            except Exception:  # noqa: BLE001
                fail(f"{name} could not be read")
                continue
            owner = str(body.get("owner") or "")
            if plan.get("owners_must_be_groups", True):
                if "@" in owner:
                    fail(f"{name} is owned by a person ({owner}); make a group the owner")
                else:
                    ok(f"{name} is owned by {owner or 'nobody named'}")
            if kind == "catalogs" and plan.get("require_workspace_binding"):
                if body.get("isolation_mode") == "ISOLATED":
                    ok(f"{name} is bound to named workspaces")
                else:
                    fail(
                        f"{name} is open to every workspace on the metastore; bind it to the ones that need it"
                    )

    out("==> Agent read scope")
    if not plan.get("scope_known", True):
        out(
            "  note the agent's read scope is not known here; run bundle/label-access.sh --verify to check it"
        )
    elif plan["out_of_scope"]:
        for line in plan["out_of_scope"]:
            fail(f"outside the agent's read scope: {line}")
    else:
        ok("every label schema and shared schema is inside the agent's read scope")

    out(
        f"{len(failures)} label access check(s) failed."
        if failures
        else "All label access checks passed."
    )
    return failures


def export_grants(api: Api, plan: dict[str, Any]) -> list[dict[str, Any]]:
    """Current owner and direct grants on every object the plan covers."""
    objects = [
        *(("catalog", "catalogs", c) for c in plan["catalogs"]),
        *(("schema", "schemas", s) for s in plan["schemas"]),
        *(("table", "tables", m["table"]) for m in plan["masters"]),
    ]
    exported = []
    for kind, collection, name in objects:
        entry: dict[str, Any] = {"kind": kind, "name": name}
        try:
            entry["owner"] = (
                api("GET", f"/api/2.1/unity-catalog/{collection}/{_path(name)}") or {}
            ).get("owner")
            body = api("GET", f"/api/2.1/unity-catalog/permissions/{kind}/{_path(name)}") or {}
            entry["grants"] = [
                {"principal": a.get("principal"), "privileges": sorted(a.get("privileges") or [])}
                for a in body.get("privilege_assignments") or []
            ]
        except Exception as error:  # noqa: BLE001
            entry["error"] = str(error)
        exported.append(entry)
    return exported


def run(
    config: str | dict[str, Any],
    mode: str = "plan",
    warehouse_id: str | None = None,
    scope: list[str] | None = None,
    client: Any = None,
    out: Callable[[str], None] = print,
    api: Api | None = None,
) -> list[str]:
    """Plan, apply, verify or export. Returns verify failures (empty otherwise)."""
    if mode not in ("plan", "apply", "verify", "export"):
        raise ValueError("mode must be plan, apply, verify or export")
    data = (
        config if isinstance(config, dict) else json.loads(Path(config).read_text(encoding="utf-8"))
    )
    plan = build_plan(data, scope if scope is not None else data.get("agent_read_scope"))
    if mode in ("plan", "apply"):
        out(format_plan(plan))
    if mode == "plan":
        return []
    api = api or workspace_api(client)
    if mode == "export":
        out(json.dumps(export_grants(api, plan), indent=2))
        return []
    if mode == "apply":
        apply_plan(api, plan, warehouse_id or data.get("warehouse_id"), out)
    return verify_plan(api, plan, out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--config", required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true")
    group.add_argument("--verify", action="store_true")
    group.add_argument("--export", action="store_true")
    group.add_argument("--plan-json", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--warehouse-id")
    parser.add_argument("--scope-json", help="the agent read scope as a JSON list")
    parser.add_argument(
        "--profile", help="call the workspace through the Databricks CLI with this profile"
    )
    args = parser.parse_args(argv)
    scope = json.loads(args.scope_json) if args.scope_json else None
    try:
        if args.plan_json:
            config = json.loads(Path(args.config).read_text(encoding="utf-8"))
            print(json.dumps(build_plan(config, scope if scope is not None else [])))
            return 0
        mode = next((m for m in ("apply", "verify", "export") if getattr(args, m)), "plan")
        api = cli_api(args.profile) if args.profile else None
        return 1 if run(args.config, mode, args.warehouse_id, scope, api=api) else 0
    except ConfigError as error:
        print(str(error), file=sys.stderr)
        return 2
    except RuntimeError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
