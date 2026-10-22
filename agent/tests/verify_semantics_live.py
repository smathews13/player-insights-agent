"""Proves the live semantic index withholds what the caller is not scoped to.

Not a unit test, and deliberately not named ``test_*`` so pytest does not collect
it: it writes to a real table, syncs a real index and needs a real token.

    uv run python tests/verify_semantics_live.py \
        --catalog <your_catalog> --schema <your_schema> \
        --warehouse-id <id>

WHY PROBES RATHER THAN THE REAL CORPUS. The demo catalog grants `account users`
ALL_PRIVILEGES, so every real entry in this estate carries the public token and
every caller matches it. A check that queried the built corpus and found results
would pass just as happily with the scope filter deleted, which is the only
state worth detecting. `verify_identity_live.py` needs a probe table for exactly
this reason and says so; this is the same problem one layer up.

WHAT THE PROBES ARE, and why the raw query is the control. Three rows are
written to the source table, indexed, and then asked for twice:

  UNSCOPED   scoped to a user nobody signs in as. In the index, matched by the
             query, and must not come back.
  MINE       scoped to the caller's own address. Must come back, or the filter
             is not filtering, it is refusing everything.
  OUTSIDE    scoped to everybody, describing an asset outside the declared
             manifest. Must not come back, and this is the gate that does not
             depend on grants at all.

Asking the INDEX directly is what makes the result mean something. It shows the
withheld rows are present, embedded and returned by the same query, so the only
thing standing between them and the caller is the tool. Without that control a
pass is indistinguishable from an index that had nothing in it.

WHAT THIS CANNOT TELL YOU:

  1. It does not prove Unity Catalog would stop a caller who lacks SELECT on the
     index. This runs as one person, and the index is a UC securable whose
     enforcement belongs to UC. What it proves is the layer above: that the tool
     withholds entries the caller's scope does not name, which is the part that
     is ours to get wrong.
  2. `authorized_scope` is a snapshot taken when the build ran. Nothing here
     measures how stale it is; the rebuild schedule is what bounds that.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import semantic_layer as sl  # noqa: E402
import semantic_layer_build as build  # noqa: E402
import semantic_retrieval as sr  # noqa: E402

#: Prefixed so a probe is recognisable in the table, and so the next real build
#: prunes every one of them: the builder deletes what it did not produce.
PROBE_PREFIX = "probe-"

#: A question the probes answer and the real corpus does not, so the ranking has
#: to surface them rather than the six table entries.
PROBE_QUESTION = "warp core containment field harmonics"

UNSCOPED = f"{PROBE_PREFIX}unscoped"
MINE = f"{PROBE_PREFIX}mine"
OUTSIDE = f"{PROBE_PREFIX}outside-manifest"


def probe_entries(caller: str, declared: str, undeclared: str) -> list[sl.SemanticEntry]:
    stamp = build.datetime.now(tz=build.UTC).replace(microsecond=0)
    content = f"{PROBE_QUESTION}. Synthetic probe row written by verify_semantics_live.py."
    return [
        sl.definition_entry(
            sl.KIND_TERM,
            UNSCOPED,
            content + " Scoped to a user nobody signs in as.",
            authorized_scope=(sl.user_scope("nobody@example.invalid"),),
            asset=declared,
            source=sl.SOURCE_CURATED,
            source_ref=PROBE_PREFIX,
            generated_at=stamp,
        ),
        sl.definition_entry(
            sl.KIND_TERM,
            MINE,
            content + " Scoped to the caller.",
            authorized_scope=(sl.user_scope(caller),),
            asset=declared,
            source=sl.SOURCE_CURATED,
            source_ref=PROBE_PREFIX,
            generated_at=stamp,
        ),
        sl.definition_entry(
            sl.KIND_TERM,
            OUTSIDE,
            content + " Public, but about a table the release never declared.",
            authorized_scope=(sl.PUBLIC_SCOPE,),
            asset=undeclared,
            source=sl.SOURCE_CURATED,
            source_ref=PROBE_PREFIX,
            generated_at=stamp,
        ),
    ]


def write(workspace: Any, warehouse: str, statements: list[str]) -> None:
    for statement in statements:
        build.execute(workspace, warehouse, statement)


def sync(workspace: Any, index_name: str, expect: int, timeout: int = 900) -> int:
    """Sync and wait for the indexed row count to reach `expect`.

    Waiting on the COUNT rather than on a status field, because a TRIGGERED
    index answers queries from the previous sync while the next one runs. A
    check that queried as soon as the API returned would be reading the corpus
    from before the probes and calling a missing entry a pass.

    A sync requested while one is running is refused rather than queued, so the
    request is retried until it takes.
    """

    deadline = time.time() + timeout
    requested = False
    indexed = -1
    while time.time() < deadline:
        if not requested:
            try:
                workspace.vector_search_indexes.sync_index(index_name=index_name)
                requested = True
            except Exception as error:  # noqa: BLE001 - the previous sync is still running
                if "not ready to sync" not in str(error).lower():
                    raise
        status = workspace.vector_search_indexes.get_index(index_name).status
        indexed = int(getattr(status, "indexed_row_count", 0) or 0)
        if requested and indexed == expect:
            return indexed
        time.sleep(10)
    raise SystemExit(
        f"{index_name} held {indexed} rows after {timeout}s, expected {expect}. Nothing "
        "below would mean anything against a corpus that is not the one just written."
    )


def query_raw(workspace: Any, index_name: str, question: str) -> list[str]:
    """The control: what the index returns with no tool in the way."""

    response = workspace.vector_search_indexes.query_index(
        index_name=index_name,
        columns=["entry_id", "name", "authorized_scope", "asset"],
        query_text=question,
        query_type="HYBRID",
        num_results=20,
    )
    names: list[str] = []
    manifest = [column.name for column in response.manifest.columns]
    for row in response.result.data_array or []:
        record = dict(zip(manifest, row, strict=False))
        names.append(str(record.get("name") or ""))
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for key in build.REQUIRED_KEYS:
        parser.add_argument("--" + key.replace("_", "-"), dest=key, default="")
    parser.add_argument(
        "--keep-probes",
        action="store_true",
        help="Leave the probe rows in the table. They are pruned by the next real build.",
    )
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    from databricks.sdk import WorkspaceClient

    settings = build.settings_from(args)
    workspace = WorkspaceClient()
    caller = str(workspace.current_user.me().user_name)
    table = sl.source_table(settings.catalog, settings.schema)
    index_name = sl.index_name(settings.catalog, settings.schema)

    declared = settings.readable_tables[0]
    undeclared = f"{settings.catalog}.{settings.schema}.a_table_no_release_declared"
    if undeclared in settings.readable_tables:
        raise SystemExit(f"{undeclared} is declared, so it cannot stand for one that is not")

    entries = probe_entries(caller, declared, undeclared)
    print(f"caller       {caller}")
    print(f"table        {table}")
    print(f"index        {index_name}")
    print(f"declared     {declared}")
    print(f"undeclared   {undeclared}\n")

    before = int(
        workspace.vector_search_indexes.get_index(index_name).status.indexed_row_count or 0
    )
    write(workspace, settings.warehouse_id, build.merge_statements(table, entries))
    indexed = sync(workspace, index_name, before + len(entries))
    print(f"indexed rows {before} -> {indexed}\n")

    results: list[tuple[str, bool, str]] = []

    def check(name: str, passed: bool, detail: str) -> None:
        results.append((name, passed, detail))
        print(f"[{'PASS' if passed else 'FAIL'}] {name}: {detail}")

    raw = query_raw(workspace, index_name, PROBE_QUESTION)
    check(
        "the index itself returns all three probes",
        all(probe in raw for probe in (UNSCOPED, MINE, OUTSIDE)),
        f"raw index query returned {sorted(name for name in raw if name.startswith(PROBE_PREFIX))}",
    )

    retrieval = sr.SemanticRetrieval(settings, workspace, user_authorized=True, index=index_name)
    outcome = retrieval.retrieve(PROBE_QUESTION, limit=10)
    returned = [entry.name for entry in outcome.entries]

    check(
        "an entry scoped to nobody is withheld",
        UNSCOPED not in returned,
        f"tool returned {returned}",
    )
    check(
        "an entry scoped to the caller is returned",
        MINE in returned,
        "the filter narrows rather than refusing everything",
    )
    check(
        "an entry outside the declared manifest is withheld",
        OUTSIDE not in returned,
        f"{undeclared} is not in this release's manifest",
    )
    check(
        "the withheld entries are counted rather than silently dropped",
        outcome.withheld >= 2,
        f"withheld={outcome.withheld}",
    )

    real = retrieval.retrieve("Which tables describe daily engagement by title?", limit=5)
    check(
        "a real question returns real entries",
        bool(real.entries) and not real.failure_code,
        f"{len(real.entries)} entries: {[entry.name for entry in real.entries][:3]}",
    )

    tables_only = retrieval.retrieve("player engagement", kind=sl.KIND_TABLE, limit=5)
    check(
        "a metadata filter is applied",
        bool(tables_only.entries)
        and all(entry.entry_kind == sl.KIND_TABLE for entry in tables_only.entries),
        f"kinds returned: {sorted({entry.entry_kind for entry in tables_only.entries})}",
    )

    tool_result = real.as_tool_result()
    check(
        "retrieval produces nothing an answer can cite",
        sr.PRODUCES_EVIDENCE is False
        and not getattr(tool_result, "sources", ())
        and not getattr(tool_result, "sql", ""),
        "no sources and no statement on the tool result",
    )
    check(
        "the result says so in the text the model reads",
        sr.NOT_EVIDENCE_NOTICE in real.rendered(),
        "the notice is on the rendered output",
    )

    if not args.keep_probes:
        ids = ", ".join(sl.sql_string(entry.entry_id) for entry in entries)
        write(
            workspace,
            settings.warehouse_id,
            [f"DELETE FROM {table} WHERE entry_id IN ({ids})"],
        )
        sync(workspace, index_name, before)
        print("\nprobes removed and the index resynced")

    failed = [name for name, passed, _ in results if not passed]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if args.out:
        args.out.write_text(
            json.dumps([{"check": n, "passed": p, "detail": d} for n, p, d in results], indent=2)
        )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
