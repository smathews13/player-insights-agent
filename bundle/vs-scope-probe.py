#!/usr/bin/env python3
"""Does the Vector Search scope pair actually work, or is it only declared?

Arch#3 asks for a Vector Search scope preflight probe and a synthetic invocation.
Both halves are here, and the second is the one that earns its place.

WHY DECLARING IS NOT ENOUGH, on this repository's own record. The Vector Search
scopes were first declared as the coarse `vector-search`, on the evidence of the
workspace's OAuth metadata, and the Apps API REJECTED the name and failed the
whole bundle deploy -- that metadata lists what the OAuth server ISSUES, and the
field is validated against a narrower Apps list that overlaps it without matching.
Before that, the settings probes were declared with the default scope list alone
and every catalog, schema, table and index call was refused; the page read each
refusal as a missing Unity Catalog grant and printed a GRANT statement for a
reader who could already query every table. Twenty-odd wrong remedies from one
missing declaration, invisible until deploy, because the probe code had only ever
run locally under a full credential.

So this asks three questions in order, and the third is the only one that cannot
be faked by configuration:

  DECLARED   the target declares the scopes the contract says the index needs
  REACHABLE  the endpoint and the index answer a GET at all
  ANSWERS    a SYNTHETIC QUERY comes back with the shape the retrieval tool
             expects -- a result set with the columns it reads

THE SYNTHETIC QUERY IS A READ AND NOTHING ELSE. It sends a fixed nonsense string
that matches no real entry, asks for one row, and looks at the SHAPE of the reply
rather than its content. It creates nothing, changes nothing, and takes no
deployment lock, so it is safe against a workspace somebody is demonstrating on.

    bundle/vs-scope-probe.py --target example --profile "<your profile>"
    bundle/vs-scope-probe.py --target example --responses DIR   # no workspace, for tests

    0  declared, reachable and answering
    1  a finding: one of the three does not hold
    2  the probe could not run, which is NOT a working index
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTRACT = HERE / "scope-contract.json"

EXIT_OK, EXIT_FINDING, EXIT_COULD_NOT_RUN = 0, 1, 2

#: Deliberately matches nothing in any corpus. The probe reads the SHAPE of the
#: reply, so a query that matched something real would make the assertion depend
#: on the data rather than on the scope, and would drift as the corpus does.
SYNTHETIC_QUERY = "zzqx preflight probe string that matches no semantic entry"

#: What agent/semantic_retrieval.py reads out of a result row. A reply that omits
#: one of these is a reply the retrieval tool cannot use, which is a finding even
#: though the call succeeded.
REQUIRED_COLUMNS = ("entry_id", "content")


class CouldNotRun(Exception):
    """The probe was prevented from asking. Never 'the index does not work'."""


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise CouldNotRun(f"{path.name} could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canned(where: Path, name: str) -> dict:
    """A fabricated reply, for the suite that proves each finding can happen."""
    path = where / name
    if not path.is_file():
        raise CouldNotRun(f"{name} is not in {where}, so this leg asked nothing")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CouldNotRun(f"{name} is not readable JSON: {exc}") from exc


def cli(args: list[str], profile: str) -> dict:
    """One read-only Databricks CLI call, as JSON."""
    argv = ["databricks", *args, "-o", "json"]
    if profile:
        argv += ["-p", profile]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    except FileNotFoundError as exc:
        raise CouldNotRun(f"the databricks CLI is not on PATH: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise CouldNotRun(f"`{' '.join(args)}` did not answer within 120s") from exc
    if proc.returncode != 0:
        raise CouldNotRun(
            f"`{' '.join(args)}` failed: {(proc.stderr or proc.stdout).strip().splitlines()[0] if (proc.stderr or proc.stdout).strip() else 'no output'}"
        )
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        # NOT an empty answer. The CLI prints warnings on stdout often enough that
        # "exited 0" is not evidence of a parseable reply, and treating an
        # unparseable one as `{}` is how a probe reports a working index it never
        # reached.
        raise CouldNotRun(f"`{' '.join(args)}` returned output that is not JSON: {exc}") from exc


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--profile", default="")
    ap.add_argument("--responses", metavar="DIR", default=None)
    args = ap.parse_args(argv)

    where = Path(args.responses) if args.responses else None
    findings: list[str] = []
    checked: list[str] = []

    try:
        drift = load("pia_drift_check", HERE / "drift-check.py")
    except CouldNotRun as exc:
        print(f"  COULD NOT RUN. {exc}")
        print("  Nothing was probed. This is not a working Vector Search scope.")
        return EXIT_COULD_NOT_RUN

    try:
        if not CONTRACT.is_file():
            raise CouldNotRun(f"{CONTRACT.name} does not exist; generate it first")
        contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
        index = drift.declared_index(args.target)
    except (CouldNotRun, json.JSONDecodeError, drift.Unreadable) as exc:
        print(f"  COULD NOT RUN. {exc}")
        print("  Nothing was probed. This is not a working Vector Search scope.")
        return EXIT_COULD_NOT_RUN

    if not index.get("endpoint_name"):
        print(f"  COULD NOT RUN. target {args.target} configures no semantic index endpoint,")
        print("  so there is no Vector Search scope for this target to need.")
        return EXIT_COULD_NOT_RUN

    # ---- DECLARED -------------------------------------------------------
    needed = sorted(
        s for s in (contract.get("app_scopes") or {}) if s.startswith("vectorsearch")
    )
    if not needed:
        print("  COULD NOT RUN. the contract records no Vector Search app scope, so what")
        print("  the index needs is not written down anywhere this can read.")
        return EXIT_COULD_NOT_RUN

    try:
        declared = drift.declared_app_scopes(args.target)
    except drift.Unreadable as exc:
        print(f"  COULD NOT RUN. {exc}")
        return EXIT_COULD_NOT_RUN

    checked.append(f"{len(needed)} Vector Search scopes the contract records")
    for scope in needed:
        if scope not in declared:
            findings.append(
                f"{scope} is what the index needs and target {args.target} does not "
                f"declare it. The settings probes will be refused, and the page reads "
                f"a refusal as a missing Unity Catalog grant -- so the symptom is a "
                f"GRANT statement printed at a reader who already has access."
            )

    # ---- REACHABLE + ANSWERS -------------------------------------------
    def ask(name: str, argv_: list[str]) -> dict:
        return canned(where, name) if where else cli(argv_, args.profile)

    try:
        endpoint = ask("endpoint.json", ["vector-search-endpoints", "get-endpoint", index["endpoint_name"]])
        state = ((endpoint.get("endpoint_status") or {}).get("state") or "").upper()
        checked.append(f"endpoint {index['endpoint_name']} is {state or 'in an unreported state'}")
        if state and state != "ONLINE":
            findings.append(
                f"the Vector Search endpoint {index['endpoint_name']} is {state}, not "
                f"ONLINE, so every retrieval fails and the agent's failure reads as "
                f"'found no semantics' rather than as an endpoint that is down."
            )

        live_index = ask("index.json", ["vector-search-indexes", "get-index", index["name"]])
        rows = ((live_index.get("status") or {}).get("indexed_row_count"))
        checked.append(f"index {index['name']} holds {rows} rows")
        if rows == 0:
            findings.append(
                "the index holds zero rows, so the synthetic query below can succeed "
                "against an index that would answer nothing for a real question."
            )

        # THE SYNTHETIC INVOCATION. Declared and reachable are both satisfiable by
        # configuration; this is the one that fails when the scope is spelled in a
        # way the validator accepts and the API does not honour.
        result = ask(
            "query.json",
            # THROUGH `api post`, NOT `vector-search-indexes query-index`. That
            # subcommand cannot express `columns` -- and the shape of the reply is
            # what this probe is about -- and it fails to unmarshal the reply it does
            # get, reporting an SDK bug rather than an answer. The REST path is the
            # same one the index's own `index_url` names.
            [
                "api", "post",
                f"/api/2.0/vector-search/indexes/{index['name']}/query",
                "--json", json.dumps({
                    "columns": list(REQUIRED_COLUMNS),
                    "query_text": SYNTHETIC_QUERY,
                    "num_results": 1,
                }),
            ],
        )
    except CouldNotRun as exc:
        print(f"  COULD NOT RUN. {exc}")
        print()
        print("  The probe was PREVENTED from asking, which is not an answer. A refused")
        print("  call and a working index that returned nothing look identical if this")
        print("  is read as a pass, and that is the reading to refuse.")
        for line in checked:
            print(f"        got as far as: {line}")
        return EXIT_COULD_NOT_RUN

    manifest = (result.get("manifest") or {})
    columns = [c.get("name") for c in (manifest.get("columns") or []) if isinstance(c, dict)]
    data_array = (result.get("result") or {}).get("data_array")

    if not columns:
        findings.append(
            "the synthetic query returned no column manifest, so the reply is not the "
            "shape agent/semantic_retrieval.py reads. An index that answers with the "
            "wrong shape fails at the point of use, inside an answer."
        )
    else:
        checked.append(f"synthetic query answered with columns {columns}")
        for column in REQUIRED_COLUMNS:
            if column not in columns:
                findings.append(
                    f"the synthetic query's reply has no {column!r} column, and the "
                    f"retrieval tool reads it. The call succeeded; the result is "
                    f"unusable, which is the failure a reachability check misses."
                )

    if data_array is None:
        findings.append(
            "the synthetic query's reply carries no data_array at all, not even an "
            "empty one. A reply with no result envelope is a different thing from a "
            "query that matched nothing, and only the second is expected here."
        )
    elif data_array:
        # Not a failure. The string is chosen to match nothing, and a nearest
        # neighbour search returns the closest row regardless -- so this is
        # recorded rather than judged.
        checked.append(f"and returned {len(data_array)} nearest row(s), as a vector search will")

    print()
    if findings:
        print(f"  the Vector Search scope pair is NOT working for target {args.target}:")
        print()
        for finding in findings:
            print(f"  FAIL  {finding}")
        print()
        for line in checked:
            print(f"        checked {line}")
        return EXIT_FINDING

    print(f"  ok    the Vector Search scopes are declared, reachable and answering")
    for line in checked:
        print(f"        {line}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
