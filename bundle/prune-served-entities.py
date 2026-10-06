#!/usr/bin/env python3
"""Remove idle served entities from the agent's serving endpoint.

WHAT THIS IS FOR: every `agents.deploy()` adds a served entity and leaves the
previous ones in place, each holding its own provisioned capacity with
scale_to_zero off. Nothing in the release path ever took one away, so the
endpoint accumulated one idle replica per release. Measured on the <your profile>
endpoint on 2026-08-17: ten entities, nine of them at 0% traffic, 40 DBU/h
against the 8 DBU/h the two live ones cost. The nine bought nothing. At
$0.07/DBU that is $54/day of provisioned capacity answering no questions.

The cost is per SERVED ENTITY, not per registered version, so this operates on
the endpoint and NOTHING ELSE. It never calls the registry. Every version stays
registered and can be re-served later by name; see --help output. Deleting a
registry version is a different, irreversible act that throws away the artifact
itself, and this tool deliberately has no code path that can do it.

SAFETY. The rules below are the reason this can run unattended:

  * An entity carrying ANY traffic is never a candidate. The serving version
    keeps 100% and the traffic map for kept entities is sent back unchanged, so
    a prune cannot move a request onto a different version.
  * It refuses to act unless the endpoint is settled (NOT_UPDATING/READY).
    Stacking a config write onto an in-flight one is how an endpoint ends up
    mid-update with nobody watching.
  * It refuses to act if no entity holds traffic, which means the endpoint is
    in a shape this tool does not understand.
  * Kept entities that carry traffic are sent back as the API returned them, so
    workload size, scale_to_zero and the environment block survive the write
    untouched. A cold start on the first question of a demo is the thing the
    setting is off to prevent, so a serving entity is never switched.
  * Kept entities that carry NO traffic (the standing rollback) are switched to
    scale_to_zero_enabled=True. Nobody is asking them anything, so there is no
    cold start to protect and an always-on idle replica is pure billing. The
    release deploys the new version always-on, so the version that steps down
    to rollback arrives here still always-on; this is where it is corrected.
    If somebody rolls back by hand in the Serving UI, that one entity pays one
    cold start on the first request, which is the accepted trade.

Rollback selection: the N most recent idle versions BELOW the serving version.
Below, because a rollback is somewhere to retreat to. An idle version ABOVE the
serving one is a deploy that was logged and never took traffic, which is a
failed or abandoned release rather than a version anybody would roll back to.

N DEFAULTS TO 0 -- keep none. A retained rollback is the version released
BEFORE the current one, so a standing rollback slot keeps an older behaviour
one traffic switch away from being live. Removing an entity does not remove the
version: the registry is never touched here, so retreating is still one
`deploy_agent.py --model-version N` away and needs no capacity held open for it.
The release passes var.serving_rollbacks_kept, which carries the same default.

Usage:
  prune-served-entities.py --endpoint NAME --profile P            # report only
  prune-served-entities.py --endpoint NAME --profile P --apply
  prune-served-entities.py --endpoint NAME --profile P --keep-rollbacks 3

Exit codes:
  0  nothing to prune, or --apply succeeded
  3  a prune is needed and --apply was not passed (the loud-warning case)
  1  refused: the endpoint is mid-update, or in a shape that is not understood
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

#: Exit code meaning "there is idle capacity to remove and I did not remove it".
#: Distinct from 1 so a caller can tell a finding from a failure: the release
#: script warns on this and fails on 1.
EXIT_PRUNE_PENDING = 3


def _version_key(version: str) -> tuple[int, int | str]:
    """Sort key that keeps numeric versions numeric.

    Model versions are decimal strings, so a lexical sort puts "9" after "10".
    Anything non-numeric sorts last rather than raising, because refusing to
    plan is worse than planning around one odd name.
    """
    try:
        return (0, int(version))
    except (TypeError, ValueError):
        return (1, str(version))


def plan_prune(config: dict, keep_rollbacks: int) -> dict:
    """Decide which served entities to keep and which to remove.

    Pure: takes the endpoint's `config` block, returns a plan. No network, so
    the interesting rules are testable without a workspace.
    """
    entities = list(config.get("served_entities") or [])
    routes = list((config.get("traffic_config") or {}).get("routes") or [])

    traffic_by_name = {
        r.get("served_entity_name") or r.get("served_model_name"): (
            r.get("traffic_percentage") or 0
        )
        for r in routes
    }

    serving = [e for e in entities if traffic_by_name.get(e.get("name"), 0) > 0]
    idle = [e for e in entities if traffic_by_name.get(e.get("name"), 0) <= 0]

    if not serving:
        return {
            "refuse": (
                "no served entity is taking traffic, so there is nothing to "
                "anchor a prune on. Look at the endpoint before removing anything."
            ),
            "keep": entities,
            "remove": [],
            "always_on_idle": [],
        }

    top_serving = max(_version_key(e.get("entity_version", "")) for e in serving)

    # A rollback is a version you retreat TO, so only versions below the one
    # serving are candidates. Most recent first.
    rollback_candidates = sorted(
        (e for e in idle if _version_key(e.get("entity_version", "")) < top_serving),
        key=lambda e: _version_key(e.get("entity_version", "")),
        reverse=True,
    )
    kept_rollbacks = rollback_candidates[: max(0, keep_rollbacks)]
    kept_names = {e.get("name") for e in serving} | {e.get("name") for e in kept_rollbacks}

    keep = [e for e in entities if e.get("name") in kept_names]
    remove = [e for e in entities if e.get("name") not in kept_names]
    always_on_idle = [
        e
        for e in keep
        if traffic_by_name.get(e.get("name"), 0) <= 0
        and not e.get("scale_to_zero_enabled")
    ]

    return {
        "refuse": None,
        "keep": keep,
        "remove": remove,
        "always_on_idle": always_on_idle,
        "serving_versions": sorted(e.get("entity_version") for e in serving),
        "kept_rollback_versions": [e.get("entity_version") for e in kept_rollbacks],
        "removed_versions": [e.get("entity_version") for e in remove],
        "traffic_by_name": traffic_by_name,
    }


def build_update_payload(plan: dict) -> dict:
    """The config write that applies `plan`.

    Sends the kept entities back verbatim and restates the traffic map for
    exactly those entities. Restating it is the point: omitting traffic_config
    invites the service to redistribute, and this tool exists to not move
    traffic. Idle kept entities (the rollback) are set to scale to zero; an
    entity carrying traffic is never touched.
    """
    traffic_by_name = plan["traffic_by_name"]
    served_entities = []
    for e in plan["keep"]:
        kept = {k: v for k, v in e.items() if k not in _READ_ONLY_ENTITY_FIELDS}
        if traffic_by_name.get(e["name"], 0) <= 0:
            kept["scale_to_zero_enabled"] = True
        served_entities.append(kept)

    routes = [
        {
            "served_model_name": e["name"],
            "traffic_percentage": plan["traffic_by_name"].get(e["name"], 0),
        }
        for e in plan["keep"]
    ]
    return {"served_entities": served_entities, "traffic_config": {"routes": routes}}


#: Fields the API reports back but rejects on write.
_READ_ONLY_ENTITY_FIELDS = {
    "state",
    "creator",
    "creation_timestamp",
    "foundation_model",
    "external_model",
}


def _databricks_json(args: list[str]) -> dict:
    proc = subprocess.run(
        ["databricks", *args], capture_output=True, text=True, check=False
    )
    if proc.returncode != 0:
        sys.exit(f"ERROR: databricks {' '.join(args)} failed:\n{proc.stderr.strip()}")
    return json.loads(proc.stdout)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--endpoint", required=True)
    p.add_argument("--profile", required=True)
    p.add_argument(
        "--keep-rollbacks",
        type=int,
        default=0,
        help="idle versions below the serving one to keep (default 0: keep none)",
    )
    p.add_argument("--apply", action="store_true", help="actually remove them")
    p.add_argument(
        "--config-json",
        help="read the endpoint config from a file instead of the workspace (testing)",
    )
    args = p.parse_args(argv)

    if args.config_json:
        with open(args.config_json) as fh:
            body = json.load(fh)
    else:
        body = _databricks_json(
            ["serving-endpoints", "get", args.endpoint, "--profile", args.profile, "-o", "json"]
        )

    state = body.get("state") or {}
    update = state.get("config_update") or "NONE"
    if update not in ("NOT_UPDATING", "NONE"):
        print(
            f"REFUSING: {args.endpoint} is {update}. A prune stacked on an in-flight\n"
            f"update is how an endpoint ends up mid-config with nobody watching.\n"
            f"Wait for it to settle and re-run.",
            file=sys.stderr,
        )
        return 1

    plan = plan_prune(body.get("config") or {}, args.keep_rollbacks)
    if plan["refuse"]:
        print(f"REFUSING: {plan['refuse']}", file=sys.stderr)
        return 1

    keep_desc = ", ".join(
        f"v{e['entity_version']}({plan['traffic_by_name'].get(e['name'], 0)}%)"
        for e in plan["keep"]
    )
    print(f"  endpoint        {args.endpoint}")
    print(f"  serving         v{', v'.join(plan['serving_versions'])} (traffic unchanged)")
    print(f"  keeping         {keep_desc}")

    always_on = ", ".join(f"v{e['entity_version']}" for e in plan["always_on_idle"])
    if not plan["remove"] and not plan["always_on_idle"]:
        print("  nothing to prune: no idle entities beyond the configured rollbacks")
        return 0

    if plan["remove"]:
        removed = ", ".join(f"v{v}" for v in plan["removed_versions"])
        print(f"  idle to remove  {removed}  ({len(plan['remove'])} entities)")
    if always_on:
        print(f"  idle to scale to zero  {always_on}")

    if not args.apply and not plan["remove"]:
        print(
            f"\nWARNING: idle rollback {always_on} is always-on and answering nothing.\n"
            f"It is NOT changed by this run. Switch it to scale to zero with:\n\n"
            f"  bundle/prune-served-entities.py --endpoint {args.endpoint} \\\n"
            f"    --profile '{args.profile}' --keep-rollbacks {args.keep_rollbacks} --apply\n",
            file=sys.stderr,
        )
        return EXIT_PRUNE_PENDING

    if not args.apply:
        print(
            f"\nWARNING: {len(plan['remove'])} idle served entities are holding provisioned\n"
            f"capacity and answering nothing. They are NOT removed by this run.\n"
            f"Remove them with:\n\n"
            f"  bundle/prune-served-entities.py --endpoint {args.endpoint} \\\n"
            f"    --profile '{args.profile}' --keep-rollbacks {args.keep_rollbacks} --apply\n\n"
            f"This removes them FROM THE ENDPOINT only. Every version stays registered\n"
            f"in Unity Catalog and can be served again at any time.",
            file=sys.stderr,
        )
        return EXIT_PRUNE_PENDING

    payload = build_update_payload(plan)
    print(
        f"\n  applying: {len(plan['keep'])} entities kept, {len(plan['remove'])} removed, "
        f"{len(plan['always_on_idle'])} idle set to scale to zero"
    )
    _databricks_json(
        [
            "serving-endpoints",
            "update-config",
            args.endpoint,
            "--profile",
            args.profile,
            "--json",
            json.dumps(payload),
            "-o",
            "json",
        ]
    )
    print("  done. The registry was not touched; every version is still registered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
