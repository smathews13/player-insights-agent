#!/usr/bin/env python3
"""Apply the AI Gateway policy to the PIA agent serving endpoint.

Sets usage tracking and the per-user and per-endpoint rate limits, and turns
off the endpoint's inference table. Questions and answers are kept in Lakebase
by the app, under its retention and erasure rules; an inference table would be
a second copy in the Lakehouse that those rules do not reach. Turning capture
off leaves any table it already wrote in place, for an operator to drop.

Every other part of the endpoint's AI Gateway configuration (guardrails,
fallbacks, other rate limits) is kept exactly as it is, because the API
replaces the whole configuration and a missing field would turn it off.

Guardrails (PII and safety filters) are not set here. They apply to
foundation-model and external-model routes, so they belong on the Unity
Catalog AI Gateway model service the agent calls, not on this custom-model
endpoint.

Some workspaces refuse usage tracking or rate limits on a custom-model
endpoint ("... is not currently supported for this endpoint type in this
workspace"). The script then applies the rest, turning the request log off,
and names what was refused; set those on the AI Gateway model service instead.

Dry run by default. Exit 0 when the endpoint already matches or was changed,
1 when --check finds a difference, 2 when a read or write failed.

    python3 bundle/ai_gateway_policy.py --endpoint NAME [--profile P] \\
        [--user-calls 60] [--endpoint-calls 2000] [--apply|--check]
"""

from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import urllib.parse
from typing import Any

DEFAULT_USER_CALLS = 60
DEFAULT_ENDPOINT_CALLS = 2000


def desired(current: dict[str, Any], user_calls: int, endpoint_calls: int) -> dict[str, Any]:
    """The full AI Gateway configuration to PUT, from the current one."""

    if user_calls <= 0 or endpoint_calls <= 0:
        raise ValueError("Rate limits must be positive; there is no 'unlimited' here.")
    config = copy.deepcopy(current or {})
    config["usage_tracking_config"] = {"enabled": True}
    others = [
        limit
        for limit in config.get("rate_limits") or []
        if str(limit.get("key", "")).lower() not in {"user", "endpoint"}
    ]
    config["rate_limits"] = [
        {"calls": user_calls, "key": "user", "renewal_period": "minute"},
        {"calls": endpoint_calls, "key": "endpoint", "renewal_period": "minute"},
        *others,
    ]
    config["inference_table_config"] = {"enabled": False}
    return config


OPTIONAL_FEATURES = {
    "usage tracking": "usage_tracking_config",
    "rate limits": "rate_limits",
}


def refused_feature(error: str) -> str | None:
    """The optional feature a workspace said it does not support, if that was the refusal."""

    text = error.lower()
    if "not currently supported" not in text:
        return None
    return next((name for name in OPTIONAL_FEATURES if name in text), None)


def without(target: dict[str, Any], current: dict[str, Any], feature: str) -> dict[str, Any]:
    """The target with one refused feature left as the endpoint has it now."""

    key = OPTIONAL_FEATURES[feature]
    config = copy.deepcopy(target)
    if key in (current or {}):
        config[key] = copy.deepcopy(current[key])
    else:
        config.pop(key, None)
    return config


def comparable(config: dict[str, Any]) -> dict[str, Any]:
    """The fields this script owns, normalised, for a change check."""

    return {
        "usage": bool((config.get("usage_tracking_config") or {}).get("enabled")),
        "limits": sorted(
            (str(item.get("key")), int(item.get("calls") or 0), str(item.get("renewal_period")))
            for item in config.get("rate_limits") or []
        ),
        "request_log": bool((config.get("inference_table_config") or {}).get("enabled")),
    }


def cli(profile: str | None, method: str, path: str, body: dict | None = None) -> Any:
    command = ["databricks", "api", method, path, "-o", "json"]
    if body is not None:
        command += ["--json", json.dumps(body)]
    if profile:
        command += ["--profile", profile]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else path
        raise RuntimeError(detail)
    return json.loads(result.stdout or "{}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--user-calls", type=int, default=DEFAULT_USER_CALLS)
    parser.add_argument("--endpoint-calls", type=int, default=DEFAULT_ENDPOINT_CALLS)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)

    name = urllib.parse.quote(args.endpoint, safe="")
    try:
        endpoint = cli(args.profile, "get", f"/api/2.0/serving-endpoints/{name}")
        current = endpoint.get("ai_gateway") or {}
        target = desired(current, args.user_calls, args.endpoint_calls)
    except (RuntimeError, ValueError) as error:
        print(f"ERROR {error}", file=sys.stderr)
        return 2

    before, after = comparable(current), comparable(target)
    if before == after:
        print(f"PASS {args.endpoint} already has this AI Gateway policy.")
        return 0
    print(f"{args.endpoint} AI Gateway policy:")
    print(f"  now:    {json.dumps(before)}")
    print(f"  target: {json.dumps(after)}")
    if args.check:
        return 1
    if not args.apply:
        print("Dry run. Re-run with --apply to change the endpoint.")
        return 0
    refused: list[str] = []
    try:
        while True:
            try:
                cli(args.profile, "put", f"/api/2.0/serving-endpoints/{name}/ai-gateway", target)
                break
            except RuntimeError as error:
                feature = refused_feature(str(error))
                if feature is None or feature in refused:
                    raise
                refused.append(feature)
                target = without(target, current, feature)
        after = comparable(target)
        applied = comparable(
            cli(args.profile, "get", f"/api/2.0/serving-endpoints/{name}").get("ai_gateway") or {}
        )
    except RuntimeError as error:
        print(f"ERROR {error}", file=sys.stderr)
        return 2
    if applied != after:
        print(f"ERROR the endpoint reads back {json.dumps(applied)}", file=sys.stderr)
        return 2
    if refused:
        print(
            f"PASS {args.endpoint} has the AI Gateway policy, except "
            f"{' and '.join(refused)}, which this workspace does not support on this "
            "endpoint type. Set them on the AI Gateway model service the agent calls."
        )
    else:
        print(f"PASS {args.endpoint} now has the AI Gateway policy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
