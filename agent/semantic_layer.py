"""The semantic layer the agent searches to find out WHERE to look.

WHAT THIS IS FOR. The agent's reach is a manifest of declared tables baked into
the model artifact. Discovery today means `list_data_assets`
returning every declared name and then one `describe_table` per candidate, so a
wide deployment spends its prompt budget reciting an inventory before it has
read a row. This table holds one searchable entry per piece of SEMANTICS, so a
question can retrieve the three schemas and two definitions it needs instead.

WHAT IT IS NOT. Nothing in here is a fact about the business. An entry says what
a column MEANS, never what it contains, and a retrieved entry may not support a
figure, a chart, a source or a sentence of narrative. Calculation stays with
Genie and the guarded SQL path, which run under the caller's own grants and
attribute what they read. `semantic_retrieval.py` enforces that boundary at the
tool edge; this module never emits a row that could be mistaken for a
measurement.

THE GRAIN IS ONE ENTRY PER THING THE AGENT MIGHT NEED TO FIND, and a `table`
entry carries the table's own description TOGETHER WITH its column
descriptions. Per-column rows were the obvious alternative and are worse: a
column retrieved without its table cannot be turned into SQL, and the agent's
next action after "which table holds refunds" is always "what are its columns".
One row per table keeps that a single retrieval. Hybrid search covers the loss,
because an exact column name is a keyword match inside the row of its table.

A WIDE TABLE IS SPLIT ACROSS ENTRIES, NEVER TRUNCATED. `describe_table` once
returned the first fifty columns of a wide table with nothing on the text to say
it was partial, and the model wrote SQL against the inventory it was handed. So
`table_entries` splits on a column boundary and every part says which part it is
and how many there are.

METADATA FILTERS ARE TOP-LEVEL COLUMNS, not a JSON blob. AI Search filters by
column, so a dimension that is not a column cannot be filtered on at query time,
and a filter applied after retrieval has already spent the top-k on rows the
caller may not see.

`authorized_scope` IS NOT AN ENFORCEMENT BOUNDARY and must never be described as
one. It is a projection of Unity Catalog grants taken when the table was built,
so it is stale by construction and an index row does not inherit the row filters
or column masks of the asset it describes. It narrows what discovery reveals; UC
decides what can be read. See `semantic_retrieval.py`.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

#: Bumped when the shape of an entry changes in a way a reader must notice: a
#: new `entry_kind`, a changed `content` rendering, a new filter column. It is
#: the "data or semantic contract version" the release identity carries, and it
#: is stamped on every row so a retrieval can be tied to the build that made it.
CONTRACT_VERSION = "1"

#: Schema-relative names. Derived in one place so the builder, the bundle
#: resource and the retrieval tool cannot disagree about which objects they mean.
SOURCE_TABLE = "semantic_layer_entries"
INDEX_NAME = "semantic_layer_index"


def source_table(catalog: str, schema: str) -> str:
    return f"{catalog}.{schema}.{SOURCE_TABLE}"


def index_name(catalog: str, schema: str) -> str:
    return f"{catalog}.{schema}.{INDEX_NAME}"


# ---------------------------------------------------------------------------
# Entry kinds
#
# Closed set. An entry whose kind nobody recognises is refused at build time
# rather than indexed, because the retrieval tool renders each kind differently
# and an unrecognised one would reach a stakeholder as an unlabelled paragraph.
# ---------------------------------------------------------------------------

#: A Unity Catalog table or view, with its columns.
KIND_TABLE = "table"
#: A metric definition: what it counts, over what grain, with which filters.
KIND_METRIC = "metric"
#: A business term. What the organisation means by a word.
KIND_TERM = "term"
#: An approved join between two assets, with the keys and the caveat.
KIND_JOIN = "join"
#: A question this deployment is known to answer well, with the assets it uses.
KIND_EXAMPLE_QUESTION = "example_question"
#: A data product: a named, owned grouping of assets.
KIND_DATA_PRODUCT = "data_product"

ENTRY_KINDS = (
    KIND_TABLE,
    KIND_METRIC,
    KIND_TERM,
    KIND_JOIN,
    KIND_EXAMPLE_QUESTION,
    KIND_DATA_PRODUCT,
)

# ---------------------------------------------------------------------------
# Certification
#
# DEFAULTS TO UNCERTIFIED, and the default is the point. An entry generated from
# a Unity Catalog comment has been through no review, and a build that guessed
# `certified` would let the agent present an off-hand comment as an approved
# definition. Only a curated source may claim certification.
# ---------------------------------------------------------------------------

CERTIFIED = "certified"
PROVISIONAL = "provisional"
UNCERTIFIED = "uncertified"

CERTIFICATIONS = (CERTIFIED, PROVISIONAL, UNCERTIFIED)

# ---------------------------------------------------------------------------
# Where an entry came from
#
# Carried per row rather than per build, because one build mixes all four and a
# reader deciding how much to trust an entry needs to know which it is looking
# at. `curated` is the only source allowed to assert `certified`.
# ---------------------------------------------------------------------------

SOURCE_UNITY_CATALOG = "unity_catalog"
SOURCE_MANIFEST = "manifest"
SOURCE_GENIE_SPACE = "genie_space"
SOURCE_CURATED = "curated"

SOURCES = (SOURCE_UNITY_CATALOG, SOURCE_MANIFEST, SOURCE_GENIE_SPACE, SOURCE_CURATED)

# ---------------------------------------------------------------------------
# Scope tokens
#
# A row is retrievable by a caller when the two token sets intersect. Tokens are
# spelled with a prefix so a group called `all-users` cannot be confused with the
# public token, and so a malformed value fails to match anything rather than
# matching everything.
#
# AN EMPTY `authorized_scope` MEANS NOBODY, never everybody. A build that could
# not read an asset's grants must not fall back to publishing its semantics.
# ---------------------------------------------------------------------------

#: Readable by every account user. Written only when the build OBSERVED a grant
#: to all account users, or when an operator declared the entries public.
PUBLIC_SCOPE = "scope:all-users"


def user_scope(user_name: str) -> str:
    """The token for one named principal.

    Lower-cased because the same human arrives as `x-forwarded-email`, as a SCIM
    `userName` and as a Unity Catalog grantee, and those three have been seen to
    differ in case for one account.
    """

    return f"user:{user_name.strip().lower()}"


def group_scope(group_name: str) -> str:
    """The token for one group.

    NOT lower-cased, unlike `user_scope`. Group names are free text and two
    groups differing only in case are two groups; folding them together would be
    a widening, and a widening here is an exposure.
    """

    return f"group:{group_name.strip()}"


# ---------------------------------------------------------------------------
# Freshness
#
# A REBUILD THAT STOPPED RUNNING AND A SCHEDULE THAT WAS PAUSED ARE THE SAME
# THING TO A REVOKED GRANT, and this is the only thing in the module that can
# tell either of them from a healthy layer. `authorized_scope` is a snapshot of
# who could read an asset when the build ran, so the cron is the upper bound on
# how long a revocation takes to reach retrieval — but only while the job
# SUCCEEDS. From 11 to 15 August 2026 it failed every night on the schedule,
# nothing was written, and every surface still reported the table and the index
# healthy, because a stale row is indistinguishable from a fresh one except by
# its `generated_at`.
#
# So the bound has to be checked against the clock rather than against the job's
# exit status or the index's `ready` flag, both of which were true throughout.
# ---------------------------------------------------------------------------

#: How long after a rebuild was due the layer is still treated as current. Wide
#: enough that a slow run or a retry is not an alarm, far short of the point
#: where a revoked grant has been honoured for a second day.
REBUILD_GRACE = timedelta(hours=6)

#: How often the rebuild is scheduled. Stated here as a timedelta so the check
#: does not have to parse Quartz; `test_semantic_index_resource.py` holds it in
#: step with the cron the bundle actually declares.
REBUILD_PERIOD = timedelta(days=1)


def rebuild_overdue(
    newest: datetime | None,
    *,
    now: datetime,
    period: timedelta = REBUILD_PERIOD,
    grace: timedelta = REBUILD_GRACE,
) -> str:
    """Why the layer is out of date, or `""` when it is current.

    `newest` is the largest `generated_at` in the built layer. A reason string
    rather than a bool because every caller wants to say what is wrong, and a
    bare False at the top of a log tells the next person nothing about which of
    the two failures they have: no layer at all, or one that stopped refreshing.

    NO LAYER IS OVERDUE, not fresh. An empty table and an unbuilt one both mean
    retrieval is serving nothing, which is the case a `ready` index flag reads
    as healthy.
    """

    if newest is None:
        return (
            "the semantic layer has no rows, so retrieval has nothing to serve and no "
            "build has been recorded"
        )
    age = now - newest
    allowed = period + grace
    if age <= allowed:
        return ""
    return (
        f"the newest entry was built {_hours(age)} ago, past the {_hours(allowed)} a "
        f"{_hours(period)} rebuild plus {_hours(grace)} of grace allows. Every entry's "
        "authorized_scope is that old too, so a grant revoked since then is still "
        "honoured by discovery."
    )


def _hours(span: timedelta) -> str:
    total = int(span.total_seconds() // 3600)
    if total >= 48:
        return f"{total // 24} days"
    return f"{total}h"


# ---------------------------------------------------------------------------
# The source table
# ---------------------------------------------------------------------------

#: Column -> (SQL type, what it is for). The single definition: the DDL below,
#: the builder's INSERT and the retrieval tool's projection are all derived from
#: it, so a column added in one place cannot go missing in another. The Delta
#: Sync index is not in that list because it names no columns at all: an unset
#: `columns_to_sync` syncs every column of the source table, so adding one here
#: reaches the index without anyone editing the resource. That field is also
#: immutable, and a list that had to be kept in step by hand would eventually
#: differ from the live index, which can only be reconciled by recreating it.
COLUMNS: tuple[tuple[str, str, str], ...] = (
    (
        "entry_id",
        "STRING NOT NULL",
        "Primary key. Derived from (entry_kind, asset, name) so a rebuild updates "
        "an entry in place instead of appending a second copy of it.",
    ),
    ("entry_kind", "STRING NOT NULL", f"One of: {', '.join(ENTRY_KINDS)}."),
    ("name", "STRING NOT NULL", "Short human name, shown to the agent with the entry."),
    (
        "asset",
        "STRING NOT NULL",
        "Fully-qualified catalog.schema.object this entry describes, or empty for an "
        "entry that describes no single asset. Checked against the declared manifest "
        "at retrieval time.",
    ),
    (
        "content",
        "STRING NOT NULL",
        "The text that is embedded and searched. Semantics only: never a value, a "
        "count, or any other measurement.",
    ),
    (
        "label",
        "STRING NOT NULL",
        "Organizational label owning the entry. Empty means unlabelled, which is not "
        "the same as belonging to every label.",
    ),
    (
        "title",
        "STRING NOT NULL",
        "Product or title the entry is specific to. Empty means it spans titles.",
    ),
    ("domain", "STRING NOT NULL", "Subject area, for narrowing a search."),
    (
        "certification",
        "STRING NOT NULL",
        f"One of: {', '.join(CERTIFICATIONS)}. Defaults to {UNCERTIFIED}: an entry "
        "generated from a comment has been reviewed by nobody.",
    ),
    (
        "authorized_scope",
        "ARRAY<STRING> NOT NULL",
        "Scope tokens permitted to retrieve this entry. Empty means nobody. A cached "
        "projection of Unity Catalog grants and NOT an enforcement boundary.",
    ),
    ("source", "STRING NOT NULL", f"Where the entry was derived from: {', '.join(SOURCES)}."),
    (
        "source_ref",
        "STRING NOT NULL",
        "The specific origin, such as a Genie space id, for tracing an entry back.",
    ),
    (
        "contract_version",
        "STRING NOT NULL",
        "Semantic contract version this row was built under.",
    ),
    (
        "content_digest",
        "STRING NOT NULL",
        "SHA-256 of content, so a stale index can be detected without reading it.",
    ),
    (
        "generated_at",
        "TIMESTAMP NOT NULL",
        "When the build ran. Retrieval discloses it, because a stale definition "
        "presented as current is the failure this whole table can cause.",
    ),
)

#: Every column name, in DDL order.
COLUMN_NAMES: tuple[str, ...] = tuple(name for name, _type, _comment in COLUMNS)

#: The primary key the Delta Sync index is built on.
PRIMARY_KEY = "entry_id"

#: The one column embedded. Managed embeddings take a single text column, which
#: is why the rendering in `render_*` puts everything worth matching on into it.
EMBEDDED_COLUMN = "content"

#: Columns a query may filter on. `authorized_scope` is deliberately absent: see
#: `semantic_retrieval.py` for why the scope test is not pushed down.
FILTER_COLUMNS = ("entry_kind", "label", "title", "domain", "certification")

#: What retrieval reads back. Everything except the embedded text's digest twin
#: would be wasteful, so this is explicit rather than "all": an index only
#: returns columns it was told to sync, and a column missing here reads as null
#: at the tool edge with nothing to say it was never asked for.
RETRIEVED_COLUMNS = (
    "entry_id",
    "entry_kind",
    "name",
    "asset",
    "content",
    "label",
    "title",
    "domain",
    "certification",
    "authorized_scope",
    "source",
    "source_ref",
    "contract_version",
    "generated_at",
)


def create_table_sql(table: str) -> str:
    """DDL for the source table, for the build job to run.

    CHANGE DATA FEED IS NOT OPTIONAL. A Delta Sync index reads the source table's
    feed to stay current, and creating the index against a table without it fails
    at index-creation time, long after the table looks correct.
    """

    body = ",\n".join(
        f"  {name} {sql_type} COMMENT {sql_string(comment)}" for name, sql_type, comment in COLUMNS
    )
    return (
        f"CREATE TABLE IF NOT EXISTS {table} (\n{body}\n)\n"
        "COMMENT 'Semantic layer indexed by AI Search: descriptions and definitions only, "
        "never measurements.'\n"
        "TBLPROPERTIES (delta.enableChangeDataFeed = true)"
    )


def sql_string(value: str) -> str:
    """A SQL string literal. Quotes doubled, backslashes escaped.

    Comments and descriptions come out of a customer's Unity Catalog and go into
    generated DDL and MERGE statements, so they are arbitrary text rather than
    anything this repo controls.
    """

    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# Entries
# ---------------------------------------------------------------------------

#: Where one entry's rendered content stops. Well inside the embedding model's
#: context, and small enough that a retrieved entry is a paragraph rather than a
#: second manifest. A table with more columns than fit is SPLIT, never trimmed.
MAX_CONTENT_CHARS = 6000


class SemanticLayerError(ValueError):
    """An entry could not be built, or was built wrong.

    Raised at build time rather than written, because a malformed row reaches a
    stakeholder as an unlabelled paragraph of somebody's schema.
    """


@dataclass(frozen=True)
class SemanticEntry:
    """One searchable piece of semantics.

    Frozen: an entry is derived from a source and stamped with a digest, so
    mutating one after construction would leave the digest describing something
    else.
    """

    entry_kind: str
    name: str
    content: str
    asset: str = ""
    label: str = ""
    title: str = ""
    domain: str = ""
    certification: str = UNCERTIFIED
    authorized_scope: tuple[str, ...] = ()
    source: str = SOURCE_UNITY_CATALOG
    source_ref: str = ""
    contract_version: str = CONTRACT_VERSION
    generated_at: datetime = field(
        default_factory=lambda: datetime.now(tz=UTC).replace(microsecond=0)
    )

    def __post_init__(self) -> None:
        if self.entry_kind not in ENTRY_KINDS:
            raise SemanticLayerError(
                f"entry_kind={self.entry_kind!r} is not one of {', '.join(ENTRY_KINDS)}. "
                "The retrieval tool renders each kind differently, so an unrecognised one "
                "would reach the model as an unlabelled paragraph."
            )
        if self.certification not in CERTIFICATIONS:
            raise SemanticLayerError(
                f"certification={self.certification!r} is not one of "
                f"{', '.join(CERTIFICATIONS)}."
            )
        if self.source not in SOURCES:
            raise SemanticLayerError(f"source={self.source!r} is not one of {', '.join(SOURCES)}.")
        if self.certification == CERTIFIED and self.source != SOURCE_CURATED:
            raise SemanticLayerError(
                f"an entry from {self.source!r} may not claim {CERTIFIED!r}. Certification is "
                "a review somebody performed, and a Unity Catalog comment has been through "
                "none, so a build that inferred it would let the agent present an off-hand "
                "sentence as an approved definition."
            )
        if not self.name.strip() or not self.content.strip():
            raise SemanticLayerError("an entry needs both a name and content.")
        if len(self.content) > MAX_CONTENT_CHARS:
            raise SemanticLayerError(
                f"content is {len(self.content)} characters, over the "
                f"{MAX_CONTENT_CHARS}-character entry limit. Split it across entries rather "
                "than trimming it: a truncated inventory that does not say it is truncated "
                "is the failure describe_table already shipped once."
            )

    @property
    def entry_id(self) -> str:
        """Stable across rebuilds, so a build MERGEs rather than accumulating.

        Derived from what identifies the entry rather than from its content: an
        edited description must update the row it belongs to, not create a
        second entry that competes with the first in every search.
        """

        return _digest("\x1f".join((self.entry_kind, self.asset, self.name)))

    @property
    def content_digest(self) -> str:
        return _digest(self.content)

    def as_row(self) -> dict[str, object]:
        """The row to write, keyed by column name.

        Every column in `COLUMNS` appears, so a column added there without a
        value here fails the test that compares the two rather than writing a
        null into a NOT NULL column at build time.
        """

        return {
            "entry_id": self.entry_id,
            "entry_kind": self.entry_kind,
            "name": self.name,
            "asset": self.asset,
            "content": self.content,
            "label": self.label,
            "title": self.title,
            "domain": self.domain,
            "certification": self.certification,
            "authorized_scope": list(self.authorized_scope),
            "source": self.source,
            "source_ref": self.source_ref,
            "contract_version": self.contract_version,
            "content_digest": self.content_digest,
            "generated_at": self.generated_at,
        }


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Rendering
#
# One place that decides what an entry's searchable text looks like. The
# embedding is computed from it and hybrid search matches keywords in it, so the
# rendering is the retrieval quality: a column name that does not appear here
# cannot be found by searching for it.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ColumnDescription:
    """One column of a table, as Unity Catalog describes it."""

    name: str
    type_text: str
    comment: str = ""

    def rendered(self) -> str:
        described = f"- {self.name} ({self.type_text})"
        return f"{described}: {self.comment.strip()}" if self.comment.strip() else described


def table_entries(
    asset: str,
    columns: Sequence[ColumnDescription],
    *,
    table_comment: str = "",
    label: str = "",
    title: str = "",
    domain: str = "",
    authorized_scope: Sequence[str] = (),
    source: str = SOURCE_UNITY_CATALOG,
    source_ref: str = "",
    certification: str = UNCERTIFIED,
    generated_at: datetime | None = None,
) -> list[SemanticEntry]:
    """Entries describing one table, split across as many as its columns need.

    A table whose columns do not fit one entry becomes several, each saying which
    part it is. Every part repeats the table's own description, because a part
    retrieved on its own has to be usable on its own.
    """

    if asset.count(".") != 2:
        raise SemanticLayerError(
            f"asset={asset!r} is not a fully-qualified catalog.schema.object. Retrieval "
            "checks the asset against the declared manifest, and a two-part name would "
            "resolve against whichever catalog the reader assumed."
        )
    if not columns:
        raise SemanticLayerError(
            f"{asset} was described with no columns. An entry naming a table and listing "
            "none of it tells the agent the table exists and nothing it could act on."
        )

    stamp = {} if generated_at is None else {"generated_at": generated_at}
    header = f"Table {asset}."
    if table_comment.strip():
        header += f" {table_comment.strip()}"

    groups = _split_columns(asset, header, columns)
    entries: list[SemanticEntry] = []
    for position, group in enumerate(groups, start=1):
        suffix = "" if len(groups) == 1 else f" (columns part {position} of {len(groups)})"
        part = f"{header} Columns part {position} of {len(groups)}."
        heading = header if len(groups) == 1 else part
        body = "\n".join(column.rendered() for column in group)
        entries.append(
            SemanticEntry(
                entry_kind=KIND_TABLE,
                name=f"{asset}{suffix}",
                asset=asset,
                content=f"{heading}\nColumns:\n{body}",
                label=label,
                title=title,
                domain=domain,
                certification=certification,
                authorized_scope=tuple(authorized_scope),
                source=source,
                source_ref=source_ref,
                **stamp,
            )
        )
    return entries


def _split_columns(
    asset: str, header: str, columns: Sequence[ColumnDescription]
) -> list[list[ColumnDescription]]:
    """Columns grouped so each group's rendered entry fits `MAX_CONTENT_CHARS`.

    The header is repeated in every group, so its cost is charged to each.
    """

    # Two newlines and the "Columns:" line, plus room for the part suffix the
    # caller adds once it knows how many groups there are.
    overhead = len(header) + len("\nColumns:\n") + 64
    groups: list[list[ColumnDescription]] = [[]]
    spent = overhead
    for column in columns:
        line = column.rendered()
        if len(line) + overhead + 1 > MAX_CONTENT_CHARS:
            raise SemanticLayerError(
                f"one column of {asset} ({column.name}) does not fit an entry on its own, "
                f"at {len(line)} characters against a {MAX_CONTENT_CHARS}-character limit. "
                "Its comment is longer than the whole entry budget, which is a data problem "
                "rather than a splitting one."
            )
        if groups[-1] and spent + len(line) + 1 > MAX_CONTENT_CHARS:
            groups.append([])
            spent = overhead
        groups[-1].append(column)
        spent += len(line) + 1
    return groups


def definition_entry(
    entry_kind: str,
    name: str,
    definition: str,
    *,
    asset: str = "",
    label: str = "",
    title: str = "",
    domain: str = "",
    authorized_scope: Sequence[str] = (),
    source: str = SOURCE_CURATED,
    source_ref: str = "",
    certification: str = UNCERTIFIED,
    generated_at: datetime | None = None,
) -> SemanticEntry:
    """One metric, term, join, example question or data product.

    The name is repeated into the content on purpose. Managed embeddings see only
    the embedded column, so a metric whose name appears nowhere in its definition
    cannot be found by searching for the metric's name.
    """

    if entry_kind == KIND_TABLE:
        raise SemanticLayerError(
            "use table_entries for a table, which splits wide column lists across entries."
        )
    stamp = {} if generated_at is None else {"generated_at": generated_at}
    scoped = f" Applies to {asset}." if asset else ""
    return SemanticEntry(
        entry_kind=entry_kind,
        name=name,
        asset=asset,
        content=f"{entry_kind.replace('_', ' ').title()}: {name}.{scoped} {definition.strip()}",
        label=label,
        title=title,
        domain=domain,
        certification=certification,
        authorized_scope=tuple(authorized_scope),
        source=source,
        source_ref=source_ref,
        **stamp,
    )
