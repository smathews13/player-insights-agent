#!/usr/bin/env python3
"""Split serving-endpoint traffic between the live version and a candidate.

PIA-P2 canary. Default is a dry run. --apply writes the traffic map.

    python bundle/canary-traffic.py --endpoint NAME --profile P --candidate 52 --percent 10
    python bundle/canary-traffic.py --endpoint NAME --profile P --candidate 52 --percent 10 --apply
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


def plan_canary(config: dict, candidate_version: str, percent: int) -> dict:
    if percent < 1 or percent > 50:
        return {"refuse": "canary percent must be 1-50 so the current version stays majority"}
    entities = list(config.get("served_entities") or [])
    routes = list((config.get("traffic_config") or {}).get("routes") or [])
    traffic = {
        r.get("served_entity_name") or r.get("served_model_name"): r.get("traffic_percentage") or 0
        for r in routes
    }
    serving = [e for e in entities if traffic.get(e.get("name"), 0) > 0]
    if len(serving) != 1:
        return {"refuse": "canary needs exactly one live version to peel traffic from"}
    live = serving[0]
    candidate = next(
        (e for e in entities if str(e.get("entity_version")) == str(candidate_version)),
        None,
    )
    if candidate is None:
        return {"refuse": f"version {candidate_version} is not a served entity"}
    if candidate.get("name") == live.get("name"):
        return {"refuse": "candidate is already the live version"}
    return {
        "refuse": None,
        "live": live,
        "candidate": candidate,
        "percent": percent,
        "served_entities": entities,
    }


def build_update_payload(plan: dict) -> dict:
    live_name = plan["live"]["name"]
    canary_name = plan["candidate"]["name"]
    percent = plan["percent"]
    return {
        "served_entities": [
            {k: v for k, v in e.items() if k not in {"state", "creator", "creation_timestamp"}}
            for e in plan["served_entities"]
        ],
        "traffic_config": {
            "routes": [
                {"served_model_name": live_name, "traffic_percentage": 100 - percent},
                {"served_model_name": canary_name, "traffic_percentage": percent},
            ]
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--percent", type=int, default=10)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--config-json")
    args = parser.parse_args(argv)
    if args.config_json:
        config = json.loads(__import__("pathlib").Path(args.config_json).read_text(encoding="utf-8"))
    else:
        proc = subprocess.run(
            ["databricks", "serving-endpoints", "get", args.endpoint, "--profile", args.profile, "-o", "json"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode:
            print(proc.stderr, file=sys.stderr)
            return 1
        config = (json.loads(proc.stdout).get("config") or {})
    plan = plan_canary(config, args.candidate, args.percent)
    if plan.get("refuse"):
        print(f"refused: {plan['refuse']}", file=sys.stderr)
        return 1
    payload = build_update_payload(plan)
    print(json.dumps(payload["traffic_config"], indent=2))
    if not args.apply:
        print("dry run; pass --apply to write")
        return 0
    proc = subprocess.run(
        [
            "databricks",
            "serving-endpoints",
            "update-config",
            args.endpoint,
            "--json",
            json.dumps(payload),
            "--profile",
            args.profile,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode:
        print(proc.stderr, file=sys.stderr)
        return 1
    print("applied")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
