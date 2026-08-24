#!/usr/bin/env python3
"""Hold a release's resolved configuration against bundle/DECISIONS.md.

WHAT THIS IS FOR. On 2026-08-16 the instruction "remove all synthetic-data
framing" had been given three times and survived all three. One half of it was a
bundle variable, and its value was printed in the release script's own
configuration readout on every single run:

    data provenance       synthetic: every answer will disclose that its figures
                          are invented.

Nobody compared that line against the instruction, because the instruction lived
in a chat transcript and there was nothing to compare it against. It was noticed
scrolling past during a live model re-log, which is the most expensive moment
available, and it cost a release.

So the decisions are written down now, and this reads the configuration back
against them before anything irreversible happens.

THREE PROPERTIES THIS HAS TO KEEP, each learnt from a gate in this repo that lost
one and went quiet:

1. It runs BEFORE the model is logged and before the endpoint is touched.
   Catching it late is the whole cost being avoided. In agent-release.sh it sits
   immediately after the configuration readout, well before log_model.py; in
   app-release.sh it sits before the dry-run branch, so a dry run reports it too.

2. It is written against the MECHANISM, not against today's values. A rule that a
   variable must not resolve to "true" is SATISFIED when the variable does not
   exist, because a setting that is gone cannot turn anything on. That is what
   lets the synthetic rule keep passing once the variable is deleted, rather than
   becoming a check that has to be deleted along with it.

3. There is NO BYPASS FLAG, and one must not be added. Every other gate in these
   scripts has one, because every other gate asks a question about the world that
   can legitimately be answered "I know, proceed". This one asks what we decided.
   A decision that needs to change is changed in DECISIONS.md, deliberately, in a
   commit somebody can read.

WHAT IT CANNOT DO. Most of the decisions in DECISIONS.md are about copy and
layout, and no release configuration governs them. Those are PRINTED beside the
enforced ones and labelled as printed. A gate that showed them without saying
which half was which would imply a coverage it does not have, which is worse than
showing nothing.

Reads `databricks bundle validate -o json` on stdin. Exits 0 when nothing is
contradicted, 1 when something is, 2 when it could not run at all.
"""

from __future__ import annotations

import json
import os
import re
import sys

# The heading id in DECISIONS.md, the decision it enforces, and the date it was
# taken. The date is printed on refusal because a refusal that says only "policy
# violation" sends the reader looking for the policy.
#
# `kind` is the half that makes these survive their own subject matter:
#   must_not_be  an undeclared variable SATISFIES the rule. Nothing to turn on.
#   must_be      an undeclared variable CONTRADICTS it. Nothing asserts it.
RULES = [
    {
        "id": "D1",
        "title": "No synthetic-data or demo-data framing anywhere a reader can reach",
        "date": "2026-08-16",
        "variable": "synthetic_data",
        "kind": "must_not_be",
        "value": "true",
        "label": "data provenance",
        "consequence": (
            "every answer this release produces would end with a sentence telling "
            "the reader that its figures were invented"
        ),
    },
    {
        "id": "D2",
        "title": "The app never reads governed data as itself",
        "date": "2026-08-10",
        "variable": "execution_identity",
        "kind": "must_be",
        "value": "user-authorization",
        "label": "execution identity",
        "consequence": (
            "every data call would run as one shared principal standing in for "
            "every user, which makes row filters, column masks and per-label "
            "grants decorative"
        ),
    },
    {
        "id": "D3",
        "title": "A figure a reader cannot trace does not reach a screen",
        "date": "2026-08-15",
        "variable": "allow_unattributed_figures",
        "kind": "must_not_be",
        "value": "true",
        "label": "evidence gateway",
        "consequence": (
            "Genie figures that cannot be traced to a governed read would be "
            "answered with a caveat rather than refused"
        ),
    },
]

# Printed, never enforced. Nothing in a bundle governs copy or layout. They are
# here so that comparing a screen against them is one glance rather than a
# memory test, which is the failure this whole file is written against.
DISPLAYED = [
    (
        "D4",
        "Benchmark Lab is not an admin tab. It stays behind the admin-only "
        "experimental toggle, and the Experimental section stays in Settings.",
    ),
    (
        "D5",
        "The role badge sits to the LEFT of the signed-in name. Badge, then "
        "name, then gear.",
    ),
    ("D6", "Refused and failed are never summed, on any surface."),
    (
        "D7",
        "Every rate names its population. Token totals name their coverage. "
        "Under 20 runs a 95th percentile becomes the labelled slowest run.",
    ),
    ("D8", '"Not checked" always means not checked yet, never broken.'),
    ("D9", "No em dashes in user-facing copy."),
    (
        "D10",
        "A cause the app states to a user is derived from evidence it has, or is "
        "labelled unknown. An undetermined verdict carries no causal prose and no "
        "remedy, and a remedy states one action rather than a list to work down. "
        "Enforced by the app's own suite, not by this release: see "
        "server/lib/diagnosis-audit.test.ts, which is the register to add to.",
    ),
    (
        "D11",
        "Keep in mind shows the three highest-risk caveats and folds the rest "
        "behind a control that counts them. This overrides the sources-module "
        "specification, which asks for all of them uncollapsed.",
    ),
    (
        "D12",
        "The header's OAuth badge claims authentication only. Green when a "
        "sign-in reached the app and was readable, INCLUDING one whose token "
        "is short of a declared scope. Red only when no sign-in arrived. A "
        "green badge above the amber stale-session strip is the decided "
        "behaviour, not a bug: pinned by oauth-badge-render.test.tsx.",
    ),
    (
        "D13",
        "Two surfaces never make different claims about the same fact. One "
        "fact, one wording, decided next to its evidence and quoted by "
        "whatever else needs it. Where both must speak, they divide the fact "
        "rather than each summarising it.",
    ),
]

LABEL_WIDTH = 22
WRAP_AT = 68


def resolved(variables: dict, name: str) -> str | None:
    """The value of ${var.<name>} for this target, or None when undeclared.

    A per-target `variables:` block lands in `default`, not `value`. Reading only
    `value` returns empty for a variable a target overrode, which is the exact
    defect bundle/bundle-var.test.sh exists for, so the order here matches
    _lib.sh rather than being rediscovered.

    None means UNDECLARED and is deliberately distinct from "". Telling those two
    apart is what makes a rule outlive the setting it was written about.
    """
    if name not in variables:
        return None
    entry = variables.get(name) or {}
    value = entry.get("value")
    if value is None:
        value = entry.get("default")
    return "" if value is None else str(value)


def wrap(text: str, width: int = WRAP_AT) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in text.split():
        if current and len(current) + len(word) + 1 > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    lines.append(current)
    return lines


def evaluate(variables: dict, recorded: set):
    """Returns (readout lines, findings). A finding is a contradiction."""
    lines: list[str] = []
    findings: list[tuple] = []

    for rule in RULES:
        ident = rule["id"]
        label = rule["label"].ljust(LABEL_WIDTH)
        variable = rule["variable"]
        value = resolved(variables, variable)

        if ident not in recorded:
            # The rule outlived its entry in DECISIONS.md. Refusing rather than
            # skipping: a gate enforcing something no longer written down is the
            # mirror image of the failure that produced this file, and it is the
            # shape that rots quietly.
            findings.append((rule, value, "unrecorded"))
            lines.append(f"  {ident}  {label} REFUSED: no entry in DECISIONS.md")
            continue

        if rule["kind"] == "must_not_be":
            if value is None:
                lines.append(
                    f"  {ident}  {label} ok, no `{variable}` variable exists for this target"
                )
            elif value.strip().lower() == rule["value"]:
                findings.append((rule, value, "contradicted"))
                lines.append(f"  {ident}  {label} CONTRADICTED: {variable}={value!r}")
            else:
                shown = value if value else "(not set)"
                lines.append(f"  {ident}  {label} ok, {variable}={shown}")
            continue

        if value is None:
            findings.append((rule, value, "undeclared"))
            lines.append(
                f"  {ident}  {label} CONTRADICTED: no `{variable}` variable to declare it"
            )
        elif value.strip() != rule["value"]:
            findings.append((rule, value, "contradicted"))
            lines.append(f"  {ident}  {label} CONTRADICTED: {variable}={value!r}")
        else:
            lines.append(f"  {ident}  {label} ok, {variable}={value}")

    # D2 used to have a second half here, comparing the declared intent against
    # whether `--user-authorization` was passed. agent-release.sh now logs every
    # version with the policy and takes no flag, so there is nothing left to
    # disagree: the only value that flag could hold is the one it now always has.
    # Certification still recovers what the served artifact was actually logged
    # with, which is the check that catches a version logged before this change.

    return lines, findings


def report(lines, findings) -> int:
    print("")
    print("  ENFORCED. This release stops if one of these is contradicted.")
    print("")
    for line in lines:
        print(line)

    print("")
    print("  DISPLAYED ONLY. Nothing checks these. Read them against what you are")
    print("  about to ship; no release passing is evidence that one was honoured.")
    print("")
    for ident, text in DISPLAYED:
        wrapped = wrap(text)
        print(f"  {ident}  {wrapped[0]}")
        for extra in wrapped[1:]:
            print(f"      {extra}")

    if not findings:
        print("")
        print("  Nothing contradicted.")
        return 0

    print("")
    print("  REFUSED. This release contradicts a decision that has already been made.")
    print("")
    for rule, value, why in findings:
        ident = rule["id"]
        title = rule["title"]
        date = rule["date"]
        variable = rule["variable"]
        print(f"    {ident}. {title}")
        print(f"        decided {date}, recorded in bundle/DECISIONS.md")
        if why == "unrecorded":
            print(f"        this gate enforces {ident}, and DECISIONS.md has no entry")
            print("        for it. One of the two was changed without the other.")
            print("")
            continue
        if why == "undeclared":
            print(f"        `{variable}` is not declared for this target, so nothing in")
            print("        this deployment asserts the decision.")
        elif why == "flag":
            print(f"        {value}")
        else:
            print(f"        `{variable}` resolves to {value!r} for this target")
        for line in wrap("Released, " + rule["consequence"] + ".", 64):
            print(f"        {line}")
        print("")

    print("  There is no flag that releases past this, on purpose. A decision that")
    print("  needs to change is changed in bundle/DECISIONS.md, deliberately, in a")
    print("  commit somebody can read. Then change the configuration to match.")
    print("")
    print("  Nothing has been logged, deployed or uploaded.")
    return 1


def main() -> int:
    record_path = os.environ.get("DECISIONS_RECORD", "")

    try:
        record = open(record_path, encoding="utf-8").read()
    except OSError:
        print("")
        print(f"  REFUSED. Could not read the decisions record at {record_path!r}.")
        print("")
        print("  This gate holds the release against that file. Without it there is")
        print("  nothing to check, and a release that could not be checked must not")
        print("  be mistaken for one that passed.")
        return 2

    recorded = set(re.findall(r"^### (D\d+)\.", record, re.M))
    if not recorded:
        print("")
        print(f"  REFUSED. {record_path} has no decision headings in it.")
        print("")
        print("  Decisions are read from `### D<n>.` headings. Either the file was")
        print("  reformatted or it is not the file this expects.")
        return 2

    try:
        variables = (json.load(sys.stdin).get("variables") or {})
    except (json.JSONDecodeError, AttributeError):
        print("")
        print("  REFUSED. The resolved bundle configuration could not be read.")
        print("")
        print("  This gate is fed `databricks bundle validate -o json`. Run it")
        print("  yourself to see what it said.")
        return 2

    lines, findings = evaluate(variables, recorded)
    return report(lines, findings)


if __name__ == "__main__":
    sys.exit(main())
