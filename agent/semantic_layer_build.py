"""Build the semantic-layer source table from what the deployment already knows.

FOUR SOURCES, IN ORDER OF HOW MUCH ANYONE HAS REVIEWED THEM.

  Unity Catalog. One entry per declared table, from the table's own COMMENT and
  its columns' comments. This is the customer's sentence about the customer's
  table, so it is right on any estate, and it is the only description of a schema
  this repo is willing to carry: nothing here asserts what anyone's table is for.

  The Genie spaces. What each space curates, as a data product, plus whatever
  example questions the space records. A space's curation is a statement that
  somebody expects these tables to answer questions together, which is exactly
  the discovery signal a manifest cannot express.

  The deployment's data dictionary, if the manifest declares it. A term per
  documented COLUMN, which is the only column-level meaning this layer has where
  Unity Catalog's column comments are empty — as they are on every table here.

  A curated file, supplied by the deployment. Metrics, terms and approved joins.
  THE ONLY SOURCE ALLOWED TO CLAIM CERTIFICATION, because certification is a
  review somebody performed and the other three have been through none.

THE ASSET LIST IS THE DECLARED MANIFEST, never a live Unity Catalog listing.
Indexing semantics for a table outside the manifest would let the agent discover
something it has no grant to read and offer it to a stakeholder, and the failure
would arrive at the warehouse one turn later.

`authorized_scope` IS A CACHED PROJECTION OF UNITY CATALOG GRANTS, taken here and
already stale by the time anyone queries it. It narrows what discovery reveals.
It does not decide what can be read: the caller's own grants do that, at the
warehouse, on every read the agent performs. A grantee this build cannot map to
a token the caller will present, such as a service principal's application id,
produces no token and therefore no match, which is the direction to fail in.

NOTHING HERE DEPLOYS. `--dry-run` is the default and prints what would be
written. `--apply` runs the statements against the configured warehouse.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import sdk_attribution
import semantic_layer as sl
from config import ENV_VARS, REQUIRED_KEYS, Settings

sdk_attribution.register_sdk_product()

#: Table properties a deployment sets to classify its own tables, so the filter
#: dimensions come from the estate rather than from a guess made here. Set them
#: with ALTER TABLE ... SET TBLPROPERTIES ('semantic.domain' = 'monetisation').
#:
#: Properties rather than Unity Catalog tags because `tables.get` already returns
#: them, so classification costs no extra call per table and no extra grant.
PROPERTY_PREFIX = "semantic."
LABEL_PROPERTY = f"{PROPERTY_PREFIX}label"
TITLE_PROPERTY = f"{PROPERTY_PREFIX}title"
DOMAIN_PROPERTY = f"{PROPERTY_PREFIX}domain"

#: The Unity Catalog group meaning every account user. Recognised by name because
#: it is the one grantee that is genuinely public, and mapping it to a group
#: token would leave public semantics matching nobody.
ALL_ACCOUNT_USERS = "account users"

#: Privileges that let a principal read an asset. `ALL_PRIVILEGES` is included
#: because a principal holding it holds SELECT, and a build that only looked for
#: the literal string would hide an admin's own semantics from them.
READ_PRIVILEGES = frozenset({"SELECT", "ALL_PRIVILEGES"})

#: A grantee spelled as a uuid, which in this estate is a service principal's
#: application id. Groups appear by display name and users by email, so this is
#: the shape that belongs to nobody who can sign in.
SERVICE_PRINCIPAL_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


class BuildError(RuntimeError):
    """The build cannot produce a trustworthy table, so it produces none."""


@dataclass
class BuildResult:
    """What a build produced, and everything a reader should be told about it."""

    entries: list[sl.SemanticEntry] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def summary(self) -> list[str]:
        """Counts worth reading before anything is written.

        `invisible` is reported loudly rather than as a statistic. An entry no
        token can match is indexed, embedded, paid for, and returned to nobody,
        and the symptom is a retrieval that quietly finds less than it should.
        """

        by_kind: dict[str, int] = {}
        for entry in self.entries:
            by_kind[entry.entry_kind] = by_kind.get(entry.entry_kind, 0) + 1
        invisible = [entry.name for entry in self.entries if not entry.authorized_scope]
        lines = [
            f"{len(self.entries)} entries: "
            + ", ".join(f"{count} {kind}" for kind, count in sorted(by_kind.items()))
        ]
        certified = sum(1 for entry in self.entries if entry.certification == sl.CERTIFIED)
        lines.append(f"{certified} certified, {len(self.entries) - certified} not")
        if invisible:
            lines.append(
                f"WARNING: {len(invisible)} entr(y/ies) carry no authorized_scope, so no "
                "caller can retrieve them. Either the build could not read the asset's "
                "grants, or the only grantees were principals it cannot map to a token a "
                "caller presents (a service principal's application id, for example): "
                + ", ".join(sorted(invisible)[:10])
            )
        return lines


# ---------------------------------------------------------------------------
# Unity Catalog
# ---------------------------------------------------------------------------


def _privileges(assignment: Any) -> set[str]:
    """The privilege names on one assignment, however the SDK spells them.

    `.value` FIRST, AND THIS IS NOT DEFENSIVENESS. The SDK returns a `Privilege`
    enum, and `str()` of it is "Privilege.SELECT", which uppercases to something
    that matches no privilege name and silently drops every assignment. That is
    what happened: the first real build produced eight entries readable by
    nobody, with no error, because the whole grant list had quietly evaluated to
    the empty set. Unit tests missed it by passing plain strings.
    """

    names: set[str] = set()
    for privilege in getattr(assignment, "privileges", None) or []:
        held = getattr(privilege, "privilege", privilege)
        name = str(getattr(held, "value", held) or "").strip().upper()
        if name:
            names.add(name)
    return names


def principal_token(principal: str) -> str:
    """The scope token one grantee produces, or `""` for one that produces none.

    A caller under user authorization is always a person, so the tokens worth
    emitting are the ones a person can present: their email, a group they are
    in, or everybody. Anything else is a grantee no caller will ever match, and
    emitting a token for it only makes the corpus look more visible than it is.
    """

    name = principal.strip()
    if not name:
        return ""
    if name.lower() == ALL_ACCOUNT_USERS:
        return sl.PUBLIC_SCOPE
    if "@" in name:
        return sl.user_scope(name)
    if SERVICE_PRINCIPAL_ID.match(name):
        # A service principal's application id. Nobody signs in as one, so it is
        # dropped rather than turned into a group token that matches nothing:
        # this workspace grants SELECT to a dozen of them per table, and every
        # one of those would otherwise be an entry in a list read as "who can
        # see this". A group identified by a uuid rather than a name would be
        # dropped too, which narrows and is the direction to be wrong in.
        return ""
    return sl.group_scope(name)


def scope_tokens(workspace: Any, full_name: str, owner: str = "") -> tuple[tuple[str, ...], str]:
    """`(tokens, note)` for who Unity Catalog says may read one asset.

    Effective privileges rather than direct ones, so a grant inherited from the
    catalog or the schema counts. Reading grants can fail for a build identity
    that is not the owner, and that is NOT downgraded to "everyone": it returns
    no token, the entry becomes invisible, and `summary` says so.

    The owner is included because ownership is not a grant and does not appear
    in the list, so an estate that governs by ownership rather than by GRANT
    would otherwise hide every table from the person who owns it.
    """

    try:
        effective = workspace.grants.get_effective("TABLE", full_name)
    except Exception as error:  # noqa: BLE001 - reported as invisible, never widened
        return (), f"{full_name}: grants unreadable ({error}), so its entries match nobody"

    tokens: list[str] = []
    owner_token = principal_token(str(owner or ""))
    if owner_token:
        tokens.append(owner_token)
    for assignment in getattr(effective, "privilege_assignments", None) or []:
        if not _privileges(assignment) & READ_PRIVILEGES:
            continue
        token = principal_token(str(getattr(assignment, "principal", "") or ""))
        if token and token not in tokens:
            tokens.append(token)
    return tuple(tokens), ""


def _column_descriptions(table: Any) -> list[sl.ColumnDescription]:
    described: list[sl.ColumnDescription] = []
    for column in getattr(table, "columns", None) or []:
        name = str(getattr(column, "name", "") or "").strip()
        if not name:
            continue
        comment = str(getattr(column, "comment", "") or "").strip()
        # A masked column is disclosed here because it changes what a query
        # against it returns, and the model choosing a column deserves to know
        # before it writes the SQL rather than after reading the result.
        if getattr(column, "mask", None):
            comment = (comment + " " if comment else "") + "[a Unity Catalog column mask applies]"
        described.append(
            sl.ColumnDescription(
                name=name,
                type_text=str(getattr(column, "type_text", "") or "unknown"),
                comment=comment,
            )
        )
    return described


def _classification(table: Any) -> dict[str, str]:
    properties = dict(getattr(table, "properties", None) or {})
    return {
        "label": str(properties.get(LABEL_PROPERTY, "") or "").strip(),
        "title": str(properties.get(TITLE_PROPERTY, "") or "").strip(),
        "domain": str(properties.get(DOMAIN_PROPERTY, "") or "").strip(),
    }


def table_source_entries(workspace: Any, assets: Sequence[str], stamp: datetime) -> BuildResult:
    """One or more entries per declared table, from Unity Catalog's own words."""

    result = BuildResult()
    for full_name in assets:
        try:
            table = workspace.tables.get(full_name)
        except Exception as error:  # noqa: BLE001 - one unreadable table is not a failed build
            result.notes.append(f"{full_name}: not described ({error})")
            continue
        columns = _column_descriptions(table)
        if not columns:
            result.notes.append(
                f"{full_name}: Unity Catalog returned no columns, so it was not indexed. An "
                "entry naming a table and listing none of it is not discovery."
            )
            continue
        tokens, note = scope_tokens(
            workspace, full_name, owner=str(getattr(table, "owner", "") or "")
        )
        if note:
            result.notes.append(note)
        try:
            result.entries.extend(
                sl.table_entries(
                    full_name,
                    columns,
                    table_comment=str(getattr(table, "comment", "") or ""),
                    authorized_scope=tokens,
                    source=sl.SOURCE_UNITY_CATALOG,
                    source_ref=full_name,
                    generated_at=stamp,
                    **_classification(table),
                )
            )
        except sl.SemanticLayerError as error:
            result.notes.append(f"{full_name}: not indexed ({error})")
    return result


# ---------------------------------------------------------------------------
# Genie spaces
# ---------------------------------------------------------------------------

#: Keys a serialized Genie space has been seen to record its example questions
#: under. Tried in order, because the shape is not a documented contract and a
#: space that records none is normal rather than broken.
QUESTION_KEYS = ("sample_questions", "curated_questions", "example_questions", "questions")


def genie_entries(
    workspace: Any,
    spaces: Sequence[tuple[str, str]],
    scope_by_asset: dict[str, tuple[str, ...]],
    stamp: datetime,
) -> BuildResult:
    """A data product per space, and an entry per example question it records.

    A space's curation is a human saying these tables answer questions together.
    Nothing in the manifest carries that, and it is the cheapest real discovery
    signal this deployment has.

    A question entry inherits the UNION of the scopes of the assets its space
    curates, not the intersection. That is deliberate and is the weaker choice:
    the question text names no data, and intersecting would hide a space's
    example questions from everyone the moment one of its tables was restricted.
    """

    result = BuildResult()
    for role, space_id in spaces:
        if not space_id:
            continue
        try:
            space = workspace.genie.get_space(space_id, include_serialized_space=True)
        except Exception as error:  # noqa: BLE001 - a space is a source, not the build
            result.notes.append(f"{role} Genie space {space_id}: not read ({error})")
            continue
        document: dict[str, Any] = {}
        serialized = getattr(space, "serialized_space", None)
        if serialized:
            try:
                document = json.loads(serialized)
            except ValueError as error:
                result.notes.append(f"{role} Genie space {space_id}: unparseable ({error})")

        curated = [
            str((entry or {}).get("identifier") or "").strip().strip("`")
            for entry in ((document.get("data_sources") or {}).get("tables") or [])
        ]
        curated = [name for name in curated if name.count(".") == 2]
        # Only assets the manifest declares. A space may curate a table this
        # release did not declare, and naming it here would advertise something
        # the agent cannot read.
        declared = [name for name in curated if name in scope_by_asset]
        tokens: list[str] = []
        for name in declared:
            for token in scope_by_asset[name]:
                if token not in tokens:
                    tokens.append(token)

        title = str(getattr(space, "title", "") or f"{role} Genie space")
        if declared:
            result.entries.append(
                sl.definition_entry(
                    sl.KIND_DATA_PRODUCT,
                    title,
                    "A Genie space curating these tables to be answered from together: "
                    + ", ".join(declared)
                    + ". Ask it through the Genie tool rather than querying the tables "
                    "directly when a question spans more than one of them.",
                    authorized_scope=tuple(tokens),
                    source=sl.SOURCE_GENIE_SPACE,
                    source_ref=space_id,
                    generated_at=stamp,
                )
            )
        if len(curated) != len(declared):
            result.notes.append(
                f"{role} Genie space {space_id}: {len(curated) - len(declared)} curated "
                "table(s) are outside the declared manifest and were left out of its data "
                "product entry"
            )

        for question in _example_questions(document):
            result.entries.append(
                sl.definition_entry(
                    sl.KIND_EXAMPLE_QUESTION,
                    question,
                    f"A question the {title} space is set up to answer. Route it to that "
                    "space rather than writing SQL for it.",
                    authorized_scope=tuple(tokens),
                    source=sl.SOURCE_GENIE_SPACE,
                    source_ref=space_id,
                    generated_at=stamp,
                )
            )
    return result


def _example_questions(document: dict[str, Any]) -> list[str]:
    """Example questions out of a serialized space, whatever it calls them.

    Both places and both shapes, because the live spaces record them at
    `config.sample_questions` with each question a LIST of strings, and looking
    only at the top level for a string found nothing at all: the first real
    build produced two data products and no questions, which reads as "these
    spaces have no examples" rather than as a parse that missed.
    """

    containers = [document, document.get("config") or {}]
    for container in containers:
        for key in QUESTION_KEYS:
            raw = container.get(key) if isinstance(container, dict) else None
            if not raw:
                continue
            found: list[str] = []
            for item in raw:
                asked = item if isinstance(item, str) else (item or {}).get("question") or ""
                for text in asked if isinstance(asked, list) else [asked]:
                    text = str(text).strip()
                    if text and text not in found:
                        found.append(text)
            if found:
                return found
    return []


# ---------------------------------------------------------------------------
# Curated definitions
# ---------------------------------------------------------------------------

#: What a curated file may set on an entry. Listed rather than passed through, so
#: a typo is refused instead of silently dropping a filter dimension.
CURATED_FIELDS = frozenset(
    {"kind", "name", "definition", "asset", "label", "title", "domain", "certification", "scope"}
)


def curated_entries(path: Path, stamp: datetime) -> BuildResult:
    """Metrics, terms and joins a human wrote down.

    Refuses the whole file on a malformed entry rather than skipping it. A
    definition that silently failed to load is a definition the agent answers
    without, and the answer looks the same as one given with it.
    """

    result = BuildResult()
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise BuildError(f"the curated definitions at {path} could not be read: {error}") from error
    if not isinstance(document, list):
        raise BuildError(f"{path} must hold a JSON list of definitions.")

    for position, item in enumerate(document, start=1):
        if not isinstance(item, dict):
            raise BuildError(f"{path} entry {position} is not an object.")
        unknown = set(item) - CURATED_FIELDS
        if unknown:
            raise BuildError(
                f"{path} entry {position} sets {', '.join(sorted(unknown))}, which nothing "
                f"reads. Known fields: {', '.join(sorted(CURATED_FIELDS))}."
            )
        try:
            result.entries.append(
                sl.definition_entry(
                    str(item.get("kind") or sl.KIND_TERM),
                    str(item.get("name") or ""),
                    str(item.get("definition") or ""),
                    asset=str(item.get("asset") or ""),
                    label=str(item.get("label") or ""),
                    title=str(item.get("title") or ""),
                    domain=str(item.get("domain") or ""),
                    certification=str(item.get("certification") or sl.UNCERTIFIED),
                    authorized_scope=tuple(item.get("scope") or ()),
                    source=sl.SOURCE_CURATED,
                    source_ref=path.name,
                    generated_at=stamp,
                )
            )
        except sl.SemanticLayerError as error:
            raise BuildError(f"{path} entry {position}: {error}") from error
    return result


# ---------------------------------------------------------------------------
# The data dictionary
#
# THE DEFINITIONS EXISTED ALL ALONG AND THE INDEX HELD NONE OF THEM. This
# deployment curates a business definition, a sensitivity and a usage guardrail
# per COLUMN in a table, and the semantic layer never read it. The only
# column-level text the build looked at was Unity Catalog's column comments,
# which are empty on every described table here — 0 of 154 columns carry one. So
# the layer said which tables exist and never what a column MEANS, which is most
# of what anyone asks a semantic layer.
#
# READ FROM THE TABLE RATHER THAN FROM COLUMN COMMENTS, and the alternative was
# real: populate the columns' COMMENTs and keep reading those, which would also
# feed Catalog Explorer, Genie and autocomplete rather than this index alone.
# The table wins on the two that decide it — it is already the curated, governed
# source of truth, so entries inherit the same grant-derived scope as the table
# entries beside them, and a customer reproduces it by shipping one table
# instead of running ALTER COLUMN ... COMMENT against tables they may not own.
# ---------------------------------------------------------------------------

#: Schema-relative name of the dictionary. Resolved against the configured
#: catalog and schema so this names an object in the deployment being built and
#: never a hardcoded estate.
DICTIONARY_TABLE = "data_dictionary"

#: The dictionary's own shape. Named explicitly so a renamed or dropped column
#: fails the SELECT loudly, rather than this quietly indexing fewer facts per
#: definition than it did yesterday.
DICTIONARY_QUERY = (
    "SELECT table_name, column_name, data_type, business_definition, sensitivity, "
    "usage_guardrail FROM {dictionary} "
    "WHERE business_definition IS NOT NULL AND trim(business_definition) <> '' "
    "ORDER BY table_name, column_name"
)


def query(workspace: Any, warehouse_id: str, sql: str) -> list[list[str]]:
    """The rows a statement returned, every cell as a string.

    Separate from `execute` because that one discards results, and a source that
    has to be READ cannot share a helper that only checks the exit state.
    """

    from databricks.sdk.service.sql import StatementState

    response = workspace.statement_execution.execute_statement(
        statement=sql,
        warehouse_id=warehouse_id,
        wait_timeout="50s",
        query_tags=sdk_attribution.query_tags("build", "dictionary_read"),
    )
    state = getattr(getattr(response, "status", None), "state", None)
    if state != StatementState.SUCCEEDED:
        detail = getattr(getattr(response, "status", None), "error", None)
        raise BuildError(f"statement did not succeed ({state}): {detail}\n\n{sql[:500]}")
    rows = getattr(getattr(response, "result", None), "data_array", None) or []
    return [["" if cell is None else str(cell) for cell in row] for row in rows]


def dictionary_entries(
    workspace: Any,
    settings: Any,
    scope_by_asset: dict[str, tuple[str, ...]],
    stamp: datetime,
) -> BuildResult:
    """A term per documented column, from the deployment's own data dictionary.

    Scope is INHERITED FROM THE TABLE THE COLUMN BELONGS TO, not from the
    dictionary. A definition of a restricted column is itself a disclosure about
    that column, so it must be retrievable by exactly whoever may read the table
    and not by everyone who may read the dictionary.

    ONLY COLUMNS OF DECLARED ASSETS. A dictionary may document a table this
    release did not declare, and indexing that would advertise something the
    agent has no grant to read — the same rule the rest of this build follows.
    """

    result = BuildResult()
    dictionary = f"{settings.catalog}.{settings.schema}.{DICTIONARY_TABLE}"
    declared = set(settings.readable_tables)
    if dictionary not in declared:
        result.notes.append(
            f"{dictionary}: not declared by this model version, so no column definitions "
            "were indexed. The dictionary is read as a source only when the manifest "
            "declares it, because its rows describe other tables."
        )
        return result

    rows = query(workspace, settings.warehouse_id, DICTIONARY_QUERY.format(dictionary=dictionary))
    undeclared: set[str] = set()
    for row in rows:
        table_name, column_name, data_type, definition, sensitivity, guardrail = (
            list(row) + [""] * 6
        )[:6]
        column_name = column_name.strip()
        if not column_name or not definition.strip():
            continue
        asset = (
            table_name.strip()
            if table_name.count(".") == 2
            else f"{settings.catalog}.{settings.schema}.{table_name.strip()}"
        )
        if asset not in declared:
            undeclared.add(asset)
            continue
        body = definition.strip()
        if data_type.strip():
            body += f" Type {data_type.strip()}."
        if sensitivity.strip():
            body += f" Sensitivity: {sensitivity.strip()}."
        if guardrail.strip():
            body += f" Usage guardrail: {guardrail.strip()}"
        try:
            result.entries.append(
                sl.definition_entry(
                    sl.KIND_TERM,
                    f"{asset.split('.')[-1]}.{column_name}",
                    body,
                    asset=asset,
                    authorized_scope=scope_by_asset.get(asset, ()),
                    source=sl.SOURCE_CURATED,
                    source_ref=f"{DICTIONARY_TABLE}.{column_name}",
                    generated_at=stamp,
                )
            )
        except sl.SemanticLayerError as error:
            result.notes.append(f"{asset}.{column_name}: not indexed ({error})")

    if not result.entries:
        # LOUD, BECAUSE THIS IS THE FAILURE THAT ALREADY HAPPENED SILENTLY. The
        # dictionary is declared, so somebody expects its definitions in the
        # index; a build that wrote every table entry and no definition still
        # produces a corpus that answers, and answers without the only
        # column-level meaning the deployment has.
        raise BuildError(
            f"{dictionary} is declared but contributed no column definitions, from "
            f"{len(rows)} row(s) read. Either the dictionary is empty or every row names a "
            "table this version does not declare, and an index missing an entire category "
            "of content still answers as though nothing were wrong."
        )
    if undeclared:
        result.notes.append(
            f"{dictionary}: {len(undeclared)} documented table(s) are not declared by this "
            f"version, so their columns were not indexed: {', '.join(sorted(undeclared)[:5])}"
        )
    return result


# ---------------------------------------------------------------------------
# The build
# ---------------------------------------------------------------------------


def build(
    settings: Settings,
    workspace: Any,
    *,
    curated: Path | None = None,
    stamp: datetime | None = None,
) -> BuildResult:
    """Every entry this deployment's semantic layer should hold."""

    when = stamp or datetime.now(tz=UTC).replace(microsecond=0)
    assets = list(settings.readable_tables)
    if not assets:
        raise BuildError(
            "this model version declares no tables, so there is nothing to describe. The "
            "semantic layer indexes the declared manifest and never a live catalog listing."
        )

    result = table_source_entries(workspace, assets, when)
    scope_by_asset = {
        entry.asset: entry.authorized_scope for entry in result.entries if entry.asset
    }
    spaces = (
        ("data", settings.data_genie_space_id),
        ("dictionary", settings.dictionary_genie_space_id),
    )
    for part in (
        genie_entries(workspace, spaces, scope_by_asset, when),
        dictionary_entries(workspace, settings, scope_by_asset, when),
        curated_entries(curated, when) if curated else BuildResult(),
    ):
        result.entries.extend(part.entries)
        result.notes.extend(part.notes)

    duplicates = _duplicate_ids(result.entries)
    if duplicates:
        raise BuildError(
            "two entries resolved to one id, so one would overwrite the other on every "
            f"build: {', '.join(sorted(duplicates))}. Entry ids come from (kind, asset, "
            "name), so give them distinct names."
        )
    return result


def _duplicate_ids(entries: Iterable[sl.SemanticEntry]) -> set[str]:
    seen: dict[str, str] = {}
    clashes: set[str] = set()
    for entry in entries:
        if entry.entry_id in seen:
            clashes.add(f"{seen[entry.entry_id]} / {entry.name}")
        seen[entry.entry_id] = entry.name
    return clashes


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

#: Rows per MERGE. A statement carrying every entry at once has been the thing
#: that breaks first on a wide estate, and the failure is a statement-size error
#: that names nothing about the semantic layer.
MERGE_BATCH = 50


def _literal(value: object) -> str:
    if isinstance(value, list):
        # CAST because an empty ARRAY() has no element type to infer, and the
        # column is ARRAY<STRING> NOT NULL: empty means nobody, which is a value
        # this table has to be able to hold.
        inner = ", ".join(sl.sql_string(str(item)) for item in value)
        return f"CAST(ARRAY({inner}) AS ARRAY<STRING>)"
    if isinstance(value, datetime):
        return f"TIMESTAMP '{value.astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S')}'"
    return sl.sql_string(str(value))


def merge_statements(table: str, entries: Sequence[sl.SemanticEntry]) -> list[str]:
    """MERGE statements that make the table match `entries`.

    MERGE rather than INSERT because entry ids are stable across builds, so a
    rebuild has to update in place. An append would leave every edited definition
    competing with its own previous wording in every search.
    """

    columns = ", ".join(sl.COLUMN_NAMES)
    statements: list[str] = []
    for start in range(0, len(entries), MERGE_BATCH):
        batch = entries[start : start + MERGE_BATCH]
        values = ",\n    ".join(
            "(" + ", ".join(_literal(entry.as_row()[name]) for name in sl.COLUMN_NAMES) + ")"
            for entry in batch
        )
        # The column names go on an inner alias, not on `source`. Databricks SQL
        # refuses a column alias list on a MERGE source with
        # COLUMN_ALIASES_NOT_ALLOWED, which no amount of reading the statement
        # reveals: it parses, and it fails at the warehouse.
        statements.append(
            f"MERGE INTO {table} AS target\n"
            f"USING (\n  SELECT * FROM (VALUES\n    {values}\n  ) AS entries ({columns})\n"
            ") AS source\n"
            "ON target.entry_id = source.entry_id\n"
            "WHEN MATCHED THEN UPDATE SET *\n"
            "WHEN NOT MATCHED THEN INSERT *"
        )
    return statements


def prune_statement(table: str, entries: Sequence[sl.SemanticEntry]) -> str:
    """Delete entries the build no longer produces.

    REFUSES TO EMPTY THE TABLE. A build that produced nothing is a broken build,
    and a pruning step that trusted it would take the whole semantic layer out of
    the index while every check downstream still reported a healthy sync.
    """

    if not entries:
        raise BuildError(
            "pruning was asked to keep no entries, which would empty the semantic layer. A "
            "build that produced nothing is a failed build, not an empty estate."
        )
    keep = ", ".join(sl.sql_string(entry.entry_id) for entry in entries)
    return f"DELETE FROM {table} WHERE entry_id NOT IN ({keep})"


def statements(table: str, entries: Sequence[sl.SemanticEntry]) -> list[str]:
    """Everything a build runs, in order: create, merge, prune."""

    return [
        sl.create_table_sql(table),
        *merge_statements(table, entries),
        prune_statement(table, entries),
    ]


def execute(workspace: Any, warehouse_id: str, sql: str) -> None:
    from databricks.sdk.service.sql import StatementState

    response = workspace.statement_execution.execute_statement(
        statement=sql,
        warehouse_id=warehouse_id,
        wait_timeout="50s",
        query_tags=sdk_attribution.query_tags("build", "semantic_write"),
    )
    state = getattr(getattr(response, "status", None), "state", None)
    if state != StatementState.SUCCEEDED:
        detail = getattr(getattr(response, "status", None), "error", None)
        raise BuildError(f"statement did not succeed ({state}): {detail}\n\n{sql[:500]}")


def sync_index(workspace: Any, index: str) -> str:
    """Ask the Delta Sync index to pick up what was just written.

    The index is TRIGGERED rather than continuous, so a build that wrote the
    table and stopped leaves the agent retrieving the previous corpus while every
    check reports both the table and the index healthy. Best effort and reported:
    a failed sync must not undo a successful write.
    """

    try:
        workspace.vector_search_indexes.sync_index(index_name=index)
    except Exception as error:  # noqa: BLE001 - reported, never fatal to the write
        return (
            f"WARNING: {index} was not synced ({error}). The table is written and the index "
            "still serves the previous build until a sync succeeds:  databricks "
            f"vector-search-indexes sync-index {index}"
        )
    return f"{index}: sync requested."


def settings_from(args: argparse.Namespace, env: Any = None) -> Settings:
    """Configuration for this run, with the command line over the environment.

    THE OVERRIDES EXIST FOR THE SCHEDULED REBUILD. A serverless job task cannot
    set environment variables, and everything in agent/ resolves its
    configuration from the environment, so job parameters are the only way for a
    scheduled build to say which deployment it is rebuilding. Only the five
    values that name a workspace; everything else this script reads is code.

    `baked={}` because this never runs inside a model load, and an artifact
    resolving over a value somebody typed would rebuild the wrong workspace's
    semantic layer while reporting success against the right one's name.
    """

    environment = dict(os.environ if env is None else env)
    for key in REQUIRED_KEYS:
        value = str(getattr(args, key, "") or "").strip()
        if value:
            environment[ENV_VARS[key]] = value
    return Settings.from_env(env=environment, baked={})


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for key in REQUIRED_KEYS:
        parser.add_argument(
            "--" + key.replace("_", "-"),
            dest=key,
            default="",
            help=f"Overrides {ENV_VARS[key]}. For job parameters, which cannot be "
            "environment variables on serverless compute.",
        )
    parser.add_argument(
        "--curated",
        type=Path,
        default=None,
        help="JSON file of metric, term and join definitions. The only source that may "
        "claim certification.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Run the statements. Without it nothing is written and the SQL is printed.",
    )
    parser.add_argument(
        "--print-sql", action="store_true", help="Print the statements as well as the summary."
    )
    args = parser.parse_args(argv)

    from databricks.sdk import WorkspaceClient

    settings = settings_from(args)
    workspace = WorkspaceClient()
    table = sl.source_table(settings.catalog, settings.schema)

    result = build(settings, workspace, curated=args.curated)
    for line in (*result.summary(), *result.notes):
        print(line)

    sql = statements(table, result.entries)
    if args.print_sql or not args.apply:
        print()
        for statement in sql:
            print(statement + ";\n")
    if not args.apply:
        print(f"Nothing was written. Re-run with --apply to build {table}.")
        return 0

    for statement in sql:
        execute(workspace, settings.warehouse_id, statement)
    print(f"{table} now holds {len(result.entries)} entries.")
    print(sync_index(workspace, sl.index_name(settings.catalog, settings.schema)))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    # EXIT ZERO BY RETURNING, NEVER BY RAISING. A serverless `spark_python_task`
    # execs this file inside an IPython kernel, and IPython reports the
    # SystemExit that `sys.exit(0)` raises as the task's error. `sys.exit(main())`
    # therefore failed the job on a COMPLETELY SUCCESSFUL build: the run of
    # 2026-08-16 wrote all 16 entries, requested the index sync, and reported
    # `INTERNAL_ERROR / FAILED` with `SystemExit: 0` as the only error. This job
    # had never once reported success, on any environment version.
    #
    # A red run on a good build is not a harmless cosmetic: it is the same
    # failure as a green run on a bad one. It trains whoever gets the on-failure
    # email to ignore it, and it hides the next real breakage inside a nightly
    # alert that always fires.
    #
    # Non-zero still raises, so a failed build still fails the task.
    _code = main()
    if _code:
        sys.exit(_code)
