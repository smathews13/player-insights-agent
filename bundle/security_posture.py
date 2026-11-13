#!/usr/bin/env python3
"""Read-only check of who can reach PIA, against the hardening target.

Covers, live:

  groups      every configured PIA group is account-level, not workspace-local,
              and the Super admin group has at least two members
  app         CAN_USE only through the configured groups; CAN_MANAGE only the
              manager group, the app's own service principal and inherited
              workspace admins; no `users` or `account users`
  endpoint    each group holds CAN_QUERY; no broad grant
  warehouse   each group holds CAN_USE; no broad grant
  genie       each group holds CAN_RUN on every space; no broad grant; nobody
              but the manager group manages a space
  experiment  traces are not readable by everyone
  inference   the endpoint keeps no request log of its own (Lakebase holds them)
  gateway     the endpoint's AI Gateway tracks usage and limits each user

Never changes anything. Exit 0 when every check passes, 1 on a finding, 2 when a
check could not run (which is not a pass).

    python3 bundle/security_posture.py --config posture.json [--profile P]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

BROAD = {"users", "account users"}
LEVEL_RANK = {
    "CAN_VIEW": 1,
    "CAN_READ": 1,
    "CAN_RUN": 2,
    "CAN_QUERY": 2,
    "CAN_USE": 2,
    "CAN_EDIT": 3,
    "CAN_MONITOR": 3,
    "CAN_RESTART": 3,
    "CAN_ATTACH_TO": 3,
    "CAN_MANAGE_RUN": 3,
    "CAN_MANAGE": 4,
    "IS_OWNER": 5,
}

Api = Callable[[str], Any]


class Unreadable(Exception):
    """A read the check depends on failed; the check is not a pass."""


@dataclass
class Report:
    results: list[tuple[str, str, str]] = field(default_factory=list)

    def add(self, ok: bool | None, area: str, message: str) -> None:
        status = "PASS" if ok else ("FAIL" if ok is False else "ERROR")
        self.results.append((status, area, message))

    @property
    def exit_code(self) -> int:
        statuses = {status for status, _, _ in self.results}
        if "ERROR" in statuses:
            return 2
        return 1 if "FAIL" in statuses else 0


def cli_api(profile: str | None) -> Api:
    def get(path: str) -> Any:
        command = ["databricks", "api", "get", path, "-o", "json"]
        if profile:
            command += ["--profile", profile]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise Unreadable(
                result.stderr.strip().splitlines()[-1] if result.stderr.strip() else path
            )
        return json.loads(result.stdout or "{}")

    return get


def principal_of(entry: dict) -> tuple[str, str]:
    for kind in ("group_name", "user_name", "service_principal_name"):
        if entry.get(kind):
            return kind, str(entry[kind])
    return "unknown", ""


def levels(entry: dict, direct_only: bool = False) -> list[str]:
    return [
        str(p.get("permission_level"))
        for p in entry.get("all_permissions") or []
        if not (direct_only and p.get("inherited"))
    ]


def highest(entry: dict, direct_only: bool = False) -> int:
    return max((LEVEL_RANK.get(level, 0) for level in levels(entry, direct_only)), default=0)


def acl(api: Api, kind: str, object_id: str) -> list[dict]:
    return list(
        api(f"/api/2.0/permissions/{kind}/{urllib.parse.quote(object_id, safe='')}").get(
            "access_control_list"
        )
        or []
    )


def holder(entries: list[dict], group: str) -> dict | None:
    return next((e for e in entries if str(e.get("group_name", "")).lower() == group.lower()), None)


def broad_grants(entries: list[dict]) -> list[str]:
    return [
        f"{e['group_name']} ({', '.join(levels(e))})"
        for e in entries
        if str(e.get("group_name", "")).lower() in BROAD and levels(e)
    ]


def check_groups(report: Report, api: Api, config: dict) -> None:
    if not config["groups"]:
        report.add(
            False, "groups", "No PIA groups are configured, so access is not granted by group."
        )
    extra = [g for g in (config.get("manager_group"), config.get("super_admin_group")) if g]
    for name in config["groups"] + extra:
        query = urllib.parse.urlencode(
            {"filter": f'displayName eq "{name}"', "attributes": "displayName,meta"}
        )
        found = api(f"/api/2.0/preview/scim/v2/Groups?{query}").get("Resources") or []
        match = next(
            (g for g in found if str(g.get("displayName", "")).lower() == name.lower()), None
        )
        if not match:
            report.add(False, "groups", f"{name} does not exist in this workspace.")
        elif (match.get("meta") or {}).get("resourceType") == "WorkspaceGroup":
            report.add(
                False,
                "groups",
                f"{name} is a workspace-local group; use the account-level group from Entra.",
            )
        else:
            report.add(True, "groups", f"{name} is an account-level group.")


def check_super_admins(report: Report, api: Api, config: dict) -> None:
    name = config.get("super_admin_group")
    if not name:
        report.add(
            False, "groups", "No Super admin group is configured; Super admins are pinned people."
        )
        return
    query = urllib.parse.urlencode(
        {"filter": f'displayName eq "{name}"', "attributes": "displayName,members"}
    )
    found = api(f"/api/2.0/preview/scim/v2/Groups?{query}").get("Resources") or []
    match = next((g for g in found if str(g.get("displayName", "")).lower() == name.lower()), None)
    members = len((match or {}).get("members") or [])
    report.add(
        members >= 2,
        "groups",
        f"{name} has {members} direct member{'' if members == 1 else 's'}; "
        "a Super admin group needs at least two.",
    )


def require_level(
    report: Report, area: str, entries: list[dict], groups: list[str], level: str, what: str
) -> None:
    for group in groups:
        entry = holder(entries, group)
        if entry and highest(entry) >= LEVEL_RANK[level]:
            report.add(True, area, f"{group} holds {level} on {what}.")
        else:
            report.add(False, area, f"{group} does not hold {level} on {what}.")


def refuse_broad(report: Report, area: str, entries: list[dict], what: str) -> None:
    broad = broad_grants(entries)
    if broad:
        report.add(False, area, f"Everyone in the workspace can reach {what}: {'; '.join(broad)}.")
    else:
        report.add(True, area, f"No workspace-wide grant on {what}.")


def check_app(report: Report, api: Api, config: dict) -> None:
    app = api(f"/api/2.0/apps/{urllib.parse.quote(config['app'], safe='')}")
    own = {
        str(app.get("service_principal_client_id") or ""),
        str(app.get("service_principal_name") or ""),
    } - {""}
    entries = acl(api, "apps", config["app"])
    what = f"app {config['app']}"
    refuse_broad(report, "app", entries, what)
    require_level(report, "app", entries, config["groups"], "CAN_USE", what)
    allowed = {g.lower() for g in config["groups"]}
    manager = (config.get("manager_group") or "").lower()
    for entry in entries:
        kind, name = principal_of(entry)
        direct = highest(entry, direct_only=True)
        if not direct or name.lower() in BROAD:
            continue
        if kind == "service_principal_name" and name in own:
            continue
        if kind == "group_name" and (
            name.lower() == manager
            or (name.lower() in allowed and direct < LEVEL_RANK["CAN_MANAGE"])
        ):
            continue
        report.add(
            False,
            "app",
            f"{what} grants {', '.join(levels(entry, True))} directly to {name}; "
            "grant groups only.",
        )
    if manager:
        entry = holder(entries, manager)
        ok = bool(entry) and highest(entry) >= LEVEL_RANK["CAN_MANAGE"]
        report.add(
            ok,
            "app",
            f"{config['manager_group']} {'holds' if ok else 'does not hold'} CAN_MANAGE on {what}.",
        )


def check_endpoint(report: Report, api: Api, config: dict) -> None:
    endpoint = api(f"/api/2.0/serving-endpoints/{urllib.parse.quote(config['endpoint'], safe='')}")
    entries = acl(api, "serving-endpoints", str(endpoint["id"]))
    what = f"endpoint {config['endpoint']}"
    refuse_broad(report, "endpoint", entries, what)
    require_level(report, "endpoint", entries, config["groups"], "CAN_QUERY", what)
    check_inference_table(report, endpoint, config)
    check_gateway(report, endpoint, config)


def check_gateway(report: Report, endpoint: dict, config: dict) -> None:
    gateway = endpoint.get("ai_gateway") or {}
    tracked = bool((gateway.get("usage_tracking_config") or {}).get("enabled"))
    report.add(
        tracked,
        "gateway",
        f"{config['endpoint']} {'tracks' if tracked else 'does not track'} usage in system tables.",
    )
    per_user = [
        limit
        for limit in gateway.get("rate_limits") or []
        if str(limit.get("key", "")).lower() == "user" and int(limit.get("calls") or 0) > 0
    ]
    if per_user:
        limit = per_user[0]
        report.add(
            True,
            "gateway",
            f"{config['endpoint']} limits each user to {limit['calls']} calls per "
            f"{limit.get('renewal_period', 'minute')}.",
        )
    else:
        report.add(
            False,
            "gateway",
            f"{config['endpoint']} has no per-user rate limit; run bundle/ai_gateway_policy.py "
            "--apply, or, where the workspace does not support one on this endpoint type, "
            "set it on the AI Gateway model service.",
        )


def check_inference_table(report: Report, endpoint: dict, config: dict) -> None:
    gateway = (endpoint.get("ai_gateway") or {}).get("inference_table_config") or {}
    capture = (endpoint.get("config") or {}).get("auto_capture_config") or {}
    table = gateway if gateway.get("enabled") else capture if capture.get("enabled") else {}
    if not table:
        report.add(
            True,
            "inference",
            f"{config['endpoint']} keeps no request log; questions and answers stay in Lakebase.",
        )
        return
    report.add(
        False,
        "inference",
        f"{config['endpoint']} logs every request and answer to "
        f"{table.get('catalog_name')}.{table.get('schema_name')}; this deployment keeps them in "
        "Lakebase only. Run bundle/ai_gateway_policy.py --apply to turn the log off.",
    )


def check_warehouse(report: Report, api: Api, config: dict) -> None:
    entries = acl(api, "warehouses", config["warehouse_id"])
    what = f"warehouse {config['warehouse_id']}"
    refuse_broad(report, "warehouse", entries, what)
    require_level(report, "warehouse", entries, config["groups"], "CAN_USE", what)


def check_genie(report: Report, api: Api, config: dict) -> None:
    manager = (config.get("manager_group") or "").lower()
    for space in config.get("genie_spaces") or []:
        entries = acl(api, "genie", space)
        what = f"Genie space {space}"
        refuse_broad(report, "genie", entries, what)
        require_level(report, "genie", entries, config["groups"], "CAN_RUN", what)
        for entry in entries:
            kind, name = principal_of(entry)
            if name.lower() in BROAD or name.lower() == manager or name.lower() == "admins":
                continue
            if highest(entry, direct_only=True) >= LEVEL_RANK["CAN_EDIT"]:
                report.add(
                    False, "genie", f"{name} can change {what}; only the manager group should."
                )


def check_experiment(report: Report, api: Api, config: dict) -> None:
    path = config.get("experiment_path")
    if not path:
        return
    query = urllib.parse.urlencode({"experiment_name": path})
    experiment = (api(f"/api/2.0/mlflow/experiments/get-by-name?{query}").get("experiment")) or {}
    entries = acl(api, "experiments", str(experiment.get("experiment_id")))
    refuse_broad(report, "experiment", entries, f"traces in {path}")


CHECKS = [
    ("groups", check_groups),
    ("super admins", check_super_admins),
    ("app", check_app),
    ("endpoint", check_endpoint),
    ("warehouse", check_warehouse),
    ("genie", check_genie),
    ("experiment", check_experiment),
]


def run(config: dict, api: Api) -> Report:
    report = Report()
    config = {**config, "groups": [g for g in config.get("groups") or [] if g]}
    for area, check in CHECKS:
        try:
            check(report, api, config)
        except (Unreadable, KeyError, ValueError) as error:
            report.add(None, area, f"Could not check: {error}")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--config",
        required=True,
        help="JSON file naming the app, endpoint, warehouse, spaces and groups",
    )
    parser.add_argument("--profile")
    args = parser.parse_args(argv)
    with open(args.config) as handle:
        config = json.load(handle)
    report = run(config, cli_api(args.profile))
    for status, area, message in report.results:
        print(f"  {status:<5} {area:<10} {message}")
    failed = sum(1 for s, _, _ in report.results if s != "PASS")
    print(f"\n{len(report.results) - failed} passed, {failed} not passed")
    return report.exit_code


if __name__ == "__main__":
    sys.exit(main())
