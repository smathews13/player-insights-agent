#!/usr/bin/env python3
"""Refuse a `databricks bundle deploy` that would destroy something.

Reads `databricks bundle plan -o json` on stdin. `bundle/plan-gate.sh` is the
entry point and holds the reasoning for why this gate blocks where the advisory
suites report; this file is the part worth testing on its own, so it takes a plan
document rather than running the CLI.

    0  the plan destroys nothing
    1  a finding: the plan would delete or replace something
    2  the check could not run, which is NOT evidence that the plan is safe
"""

from __future__ import annotations

import json
import os
import sys

#: Plan actions that cannot lose anything. Everything else is refused BY
#: EXCLUSION, including an action this list has never seen.
#:
#: The CLI's vocabulary is create/delete/replace/skip/update as of CLI 1.9.0.
#: Listing the safe three rather than the dangerous two is deliberate: a sixth
#: verb added by a future CLI is then refused by this gate instead of waved
#: through it. Every silent-failure bug in this repository -- a leak rule that
#: matched nothing for months, four suites that asserted nothing, a `sed` script
#: whose rules were all no-ops -- was a denylist that stopped matching and exited
#: 0. An allowlist cannot fail that way.
SAFE_ACTIONS = frozenset({"skip", "update", "create"})

#: Recognised as destroying something, and named as such in the output. An action
#: outside both sets is still refused; this set only buys a better message.
KNOWN_DESTRUCTIVE = frozenset({"delete", "replace"})

EXIT_OK = 0
EXIT_FINDING = 1
EXIT_COULD_NOT_RUN = 2


def acknowledged() -> list[str]:
    """Resource keys the operator has accepted the destruction of, by name.

    A named acknowledgement rather than a `--force`, for the reason a blanket
    bypass is used once and then always, and stops being read. Naming the
    resource makes the acceptance specific and makes it visible in the shell
    history that ran it.

    Deliberately an environment variable and not a file: unlike a standing
    grant, an intended deletion is true for one deploy and false for every one
    after it, so a committed list would outlive the fact it records.
    """
    raw = os.environ.get("PIA_PLAN_ALLOW_DESTROY", "")
    return [key.strip() for key in raw.split(",") if key.strip()]


def could_not_run(*lines: str) -> int:
    for line in lines:
        print(line)
    return EXIT_COULD_NOT_RUN


def main(argv: list[str]) -> int:
    try:
        document = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        return could_not_run(
            f"  COULD NOT RUN. bundle plan did not return JSON: {exc}",
            "  Nothing has been checked. Do not read this as permission to deploy.",
        )

    plan = document.get("plan")
    if not isinstance(plan, dict):
        # An absent key and an empty plan are different, and only one is good
        # news. Were this a `.get("plan", {})`, a CLI that renamed the key would
        # make this gate report "destroys nothing" forever, on every deploy,
        # while checking nothing at all.
        return could_not_run(
            "  COULD NOT RUN. The plan document carries no `plan` object, so there were",
            "  no resource actions to check. The CLI's output shape has probably changed:",
            "  read `databricks bundle plan -o json` and fix this gate before deploying.",
        )

    allowed = acknowledged()
    destructive: list[tuple[str, object]] = []
    unknown: list[tuple[str, object]] = []
    counts: dict[str, int] = {}

    for key, body in sorted(plan.items()):
        if not isinstance(body, dict):
            continue
        action = body.get("action")
        label = action if isinstance(action, str) else repr(action)
        counts[label] = counts.get(label, 0) + 1
        if action in SAFE_ACTIONS:
            continue
        (destructive if action in KNOWN_DESTRUCTIVE else unknown).append((key, action))

    summary = ", ".join(f"{count} {action}" for action, count in sorted(counts.items()))
    print(f"  plan: {summary or 'no resources'}")

    for key, action in destructive:
        if key in allowed:
            print(f"  ALLOWED  {action:8} {key}")
            print("           acknowledged by PIA_PLAN_ALLOW_DESTROY for this run only.")

    blocking = [(k, a) for k, a in destructive if k not in allowed]
    blocking_unknown = [(k, a) for k, a in unknown if k not in allowed]

    if blocking:
        print()
        print("  THIS DEPLOY WOULD DESTROY DATA. Each line is a resource the deploy removes,")
        print("  or removes and recreates. A replace is a delete wearing one word, and")
        print("  prevent_destroy does not stop one.")
        print()
        for key, action in blocking:
            print(f"  FAIL  {action:8} {key}")

    if blocking_unknown:
        print()
        print("  UNRECOGNISED PLAN ACTION. This gate allows skip, update and create, and")
        print("  refuses everything else, so an action it has not been taught is refused")
        print("  rather than assumed harmless. Read what the CLI means by it, then add it")
        print("  to SAFE_ACTIONS in bundle/plan-gate.py if it cannot lose anything.")
        print()
        for key, action in blocking_unknown:
            print(f"  FAIL  {action!r:10} {key}")

    # An acknowledgement matching nothing is reported rather than ignored, so a
    # list left over from an earlier deploy cannot become a standing bypass that
    # nobody notices is still set.
    matched = {k for k, _ in destructive} | {k for k, _ in unknown}
    stale = [key for key in allowed if key not in matched]
    if stale:
        print()
        print("  STALE ACKNOWLEDGEMENT. PIA_PLAN_ALLOW_DESTROY names something this plan")
        print("  does not touch, so it grants nothing and is probably left over:")
        for key in stale:
            print(f"  WARN  {key}")

    if blocking or blocking_unknown:
        target = os.environ.get("TARGET", "<target>")
        names = ",".join(key for key, _ in blocking + blocking_unknown)
        print()
        print("  Nothing has been deployed. If a removal is intended, acknowledge it BY")
        print("  NAME rather than working around this gate:")
        print()
        print(f"    TARGET={target} PIA_PLAN_ALLOW_DESTROY={names} \\")
        print("      bundle/plan-gate.sh")
        return EXIT_FINDING

    print("  ok    this deploy destroys nothing")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
