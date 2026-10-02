"""Find the few schemas and definitions a question needs. Nothing else.

THIS TOOL PRODUCES NO EVIDENCE, and that is the property to preserve when
changing it. A retrieved entry is somebody's description of a column, not a
reading of one, so it may not support a figure, a chart, a source, a freshness
claim, or a sentence of narrative that asserts anything about the business.
`RetrievalOutcome.as_tool_result` therefore returns a `ToolResult` with no
`sources` and no `sql`, unconditionally and even when the entries name assets:
the evidence gateway admits candidates on the strength of a parsed statement and
the assets it read, and this tool has neither to offer. `PRODUCES_EVIDENCE` is
False here so that a reader looking for the boundary finds it named.

What it is for is the opposite of that: deciding WHERE to look before anything is
read. Today the model calls `list_data_assets`, gets every declared table, and
calls `describe_table` down the list, which is a manifest recited into the prompt
one table at a time. One retrieval replaces that with the three tables and two
definitions the question is about, and the reads that follow still go through
Genie or the guarded SQL path, under the caller's own grants.

# What the scope filter is, and what it is not

`authorized_scope` on an entry is a cached projection of Unity Catalog grants,
taken when the semantic layer was built. This module intersects it with tokens
derived from the caller. That narrows what DISCOVERY reveals. It decides nothing
about what can be READ, and it cannot:

  An AI Search index does not inherit the row filters or column masks of the
  table it was built from. Its rows were materialised by the sync pipeline, and
  a filter that would have hidden rows from this caller in the source table does
  not apply here.

  The projection is stale from the moment it is written. A grant revoked after
  the last build is still in the index.

  A grantee the build could not map to a token a caller presents, such as a
  service principal's application id, produces no token, so the entry is hidden
  from everyone rather than shown to anyone. That direction is deliberate.

The enforced boundary is elsewhere and stays there: Unity Catalog decides SELECT
on the index itself, and Genie, the warehouse and Unity Catalog decide every read
the agent performs afterwards, as the signed-in user. A caller who retrieves the
description of a table they cannot read learns that the table exists and gets an
access failure the moment they ask anything of it.

# Why the scope test is not pushed into the index

Every scalar filter is pushed down as a query filter AND re-applied here. The
scope test is applied ONLY here. Pushdown is an optimisation that decides which
rows the top-k is spent on; this module decides what is returned. Array-filter
semantics on an AI Search index cannot be exercised without provisioning an
endpoint, and a filter believed to be enforced remotely that quietly matches
everything is exactly the silent widening this whole workstream exists to
prevent. Over-fetching covers the recall the missing pushdown costs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import semantic_layer as sl
from config import Settings
from tools import ToolResult

#: The tool the model sees.
TOOL_NAME = "search_semantics"

#: Read by anything deciding whether a tool's output may back a factual claim.
#: False, permanently. A description of a column is not a reading of one.
PRODUCES_EVIDENCE = False

# ---------------------------------------------------------------------------
# Whether this release has a semantic layer at all
#
# OFF UNLESS A RELEASE SAYS OTHERWISE, because an AI Search endpoint is an hourly
# charge somebody has to agree to and no deployment gets one by upgrading. With
# the flag unset the tool is not offered at all: offering one that answers
# "unavailable" every time would spend a tool step and a paragraph of prompt on
# telling the model to use the tools it already had.
#
# Resolved at LOG time and baked, for the reason every other release decision is:
# the serving container inherits no environment, and a version whose prompt
# offers a tool its configuration does not have is not a state worth being able
# to reach.
# ---------------------------------------------------------------------------

#: Read at log time only. `true` derives the index name from the catalog and
#: schema, matching the index the bundle declares for the deployment. A
#: three-level name adopts an index built somewhere else.
SEMANTIC_INDEX_ENV = "PLAYER_INSIGHTS_SEMANTIC_INDEX"

#: The key `log_model.py` writes into `model_config` and this module reads back.
MODEL_CONFIG_KEY = "semantic_index"

#: Retired for now. The tool, the Vector Search endpoint, and the index stay
#: out of the served model and out of the bundle until this is flipped and the
#: example overlay fills the resource maps again.
SEMANTIC_RETRIEVAL_ENABLED = False

#: What the flag accepts as "derive the name from the deployment".
DERIVE = "true"


class SemanticIndexMisconfigured(ValueError):
    """The flag named something that is neither off, `true`, nor an index."""


def resolve_index(settings: Settings, raw: Any = None) -> str:
    """The index this release searches, or `""` when it has none.

    Fails on anything unrecognised rather than falling back to off. A typo
    resolving quietly to off is a release that silently lost its semantic layer
    and looks exactly like one that never had it.
    """

    value = str(raw if raw is not None else "").strip()
    if not value or value.lower() == "false":
        return ""
    if value.lower() == DERIVE:
        return sl.index_name(settings.catalog, settings.schema)
    if value.count(".") == 2:
        return value
    raise SemanticIndexMisconfigured(
        f"{SEMANTIC_INDEX_ENV}={value!r} is neither empty, {DERIVE!r}, nor a "
        "catalog.schema.index name. Leave it unset for a deployment with no AI Search "
        f"index, set it to {DERIVE!r} to use the one the bundle declares, or name an "
        "index to adopt one built elsewhere."
    )


def configuration_entry(
    settings: Settings, baked: Any = None, env: Any = None
) -> dict[str, Any]:
    """The semantic index, in the shape the rest of the configuration is reported in.

    THE APP COULD NOT SEE THIS AT ALL BEFORE, and the gap was invisible from both
    ends. Whether a deployment has an index is decided here, at log time, and
    baked into the artifact; it is not one of `config.ENV_VARS`, so
    `Settings.configuration_report` never listed it; and the app container is
    never given the variable. So a release WITH a semantic layer and one WITHOUT
    looked identical to every surface that reads what this endpoint is configured
    with -- including the architecture diagram, which had to say in words that it
    could not tell.

    A component silently missing from a diagram and one that was never drawn look
    the same, so the honest report is the empty string rather than no entry:
    `value: ''` means this release has no index and is a fact, where an absent
    entry means nobody asked.

    Reported rather than added to `ENV_VARS`, deliberately. That tuple defines the
    `Settings` fields, what `from_env` reads and what `as_model_config` bakes, and
    every key in it is required to have a mutability tier and a place in the
    profiles. This value is resolved somewhere else and is not a `Settings` field;
    making it one to get it onto this list would be the tail wagging the dog.

    The tier is honest: `model-version`, because changing it means logging a new
    model. Nothing an operator edits in the app can move it.
    """

    import os

    from config import BAKED_AT_LOG_TIME, FROM_ARTIFACT, FROM_ENVIRONMENT

    environment = os.environ if env is None else env
    artifact = baked if baked is not None else {}
    # PRESENCE OF THE KEY, not truth of the value, and the difference matters more
    # here than anywhere else in the configuration. `log_model.py` always writes
    # this key, empty when the release has no index, so an artifact carrying it
    # empty is the deployment SAYING it searches nothing -- which is a fact about a
    # healthy release. An empty source means no version said anything, and the app
    # draws those two differently: "None" against "Not reported". Testing the value
    # instead would collapse them and report every index-free release as unknown.
    if MODEL_CONFIG_KEY in artifact:
        source = FROM_ARTIFACT
    elif str(environment.get(SEMANTIC_INDEX_ENV, "") or "").strip():
        source = FROM_ENVIRONMENT
    else:
        source = ""
    return {
        "key": MODEL_CONFIG_KEY,
        "env_var": SEMANTIC_INDEX_ENV,
        "value": configured_index(settings, baked, env),
        "source": source,
        "mutability": BAKED_AT_LOG_TIME,
        "baked": True,
        # A deployment without a semantic layer is a supported deployment, so an
        # empty value here is not a misconfiguration and must not be flagged as
        # one.
        "required": False,
    }


def configured_index(settings: Settings, baked: Any = None, env: Any = None) -> str:
    """The index name from the artifact, then the environment, then nothing.

    Artifact first, for the reason `config.Settings` resolves that way: the
    release that named the resources decided this, and an environment override
    inside a serving container would point the agent at an index the model
    version was never granted.
    """

    import os

    if not SEMANTIC_RETRIEVAL_ENABLED:
        return ""
    artifact = (baked if baked is not None else {}).get(MODEL_CONFIG_KEY)
    if artifact not in (None, ""):
        return resolve_index(settings, artifact)
    environment = os.environ if env is None else env
    return resolve_index(settings, environment.get(SEMANTIC_INDEX_ENV, ""))


#: Codes from the shared taxonomy in `agent/failures.py`. Spelled as literals
#: rather than imported so this module keeps working against a model version
#: logged before that module existed; `tests/test_semantic_retrieval.py` asserts
#: the two agree wherever both are present.
DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE"

#: Entries returned to the model by default. Small on purpose: the point of this
#: tool is to stop reciting an inventory, and twenty entries is another one.
DEFAULT_LIMIT = 6

#: Hard ceiling, whatever the model asks for.
MAX_LIMIT = 12

#: How many rows to ask the index for per row returned. The scope test runs after
#: retrieval, so a caller entitled to a minority of the corpus would otherwise
#: see a top-k spent entirely on rows that are then dropped.
OVERFETCH = 5

#: Ceiling on the over-fetch, so a large limit cannot turn one discovery call
#: into a scan.
MAX_FETCH = 60

#: Where the rendered result stops. A retrieval that returned more text than
#: `list_data_assets` would have has replaced one prompt-budget problem with
#: another wearing a better name.
MAX_RESULT_CHARS = 12_000

#: Prefixed to every rendered result. The model is told what this is before it
#: reads any of it, because the entries themselves read like authoritative
#: statements about the business and are not.
NOT_EVIDENCE_NOTICE = (
    "SEMANTIC SEARCH RESULTS. These are descriptions and definitions, not data. "
    "Nothing here is a measurement and none of it may be reported as a figure, a "
    "source, or a fact about the business. Use it to choose which tables and terms "
    "to ask about, then get the numbers from data_genie, dictionary_genie or SQL."
)

#: Appended to every non-empty result, on every run, whatever the caller's scope.
#:
#: The reason it is unconditional is that the scope filter is a projection of
#: Unity Catalog grants taken when the layer was BUILT, so it is out of date by
#: construction and there is no state in which it is the authority. A model that
#: reads an entry and concludes it may read the table will report an access
#: failure as a data problem; a model that finds nothing and concludes the table
#: is absent will tell a reader their own data does not exist. Both mistakes are
#: cheap to prevent here and expensive to notice in an answer.
DISCOVERY_NOT_PERMISSION_NOTICE = (
    "What appears above was filtered by a cached snapshot of grants from when this "
    "semantic layer was built. It is neither permission to read nor proof a table is "
    "missing: every read that follows is decided by Unity Catalog at query time, as "
    "the signed-in user. If a read is refused, report the refusal rather than "
    "concluding the data is absent or the description was wrong."
)


@dataclass(frozen=True)
class CallerScopes:
    """Which scope tokens the caller presents, and whether they were verified.

    `verified` is False when the run executes as a shared principal rather than
    as a person, or when the identity could not be read. Both collapse to the
    public token: semantics narrowed to a label must not be handed to a principal
    that stands in for everybody.
    """

    tokens: frozenset[str]
    identity: str = ""
    verified: bool = False


def caller_scopes(workspace: Any, *, user_authorized: bool) -> CallerScopes:
    """The tokens this caller may match entries with.

    Under user authorization the client carries the invoker's downscoped token,
    so `current_user.me()` is the caller. Without it the client is the model
    version's passthrough principal, which is one identity shared by every
    stakeholder, and scoping to it would mean scoping to nobody in particular.
    """

    if not user_authorized:
        return CallerScopes(tokens=frozenset({sl.PUBLIC_SCOPE}))
    try:
        me = workspace.current_user.me()
    except Exception:  # noqa: BLE001 - an unreadable identity narrows, never widens
        return CallerScopes(tokens=frozenset({sl.PUBLIC_SCOPE}))

    user_name = str(getattr(me, "user_name", "") or "").strip()
    tokens = {sl.PUBLIC_SCOPE}
    if user_name:
        tokens.add(sl.user_scope(user_name))
    for group in getattr(me, "groups", None) or []:
        display = str(getattr(group, "display", "") or "").strip()
        if display:
            tokens.add(sl.group_scope(display))
    return CallerScopes(tokens=frozenset(tokens), identity=user_name, verified=bool(user_name))


@dataclass(frozen=True)
class RetrievedEntry:
    """One row of the index, after every local check has passed."""

    entry_kind: str
    name: str
    asset: str
    content: str
    label: str
    title: str
    domain: str
    certification: str
    source: str
    source_ref: str
    contract_version: str
    generated_at: str

    def rendered(self) -> str:
        tags = [self.certification]
        for value in (self.label, self.title, self.domain):
            if value:
                tags.append(value)
        heading = f"[{self.entry_kind}] {self.name} ({', '.join(tags)})"
        return f"{heading}\n{self.content}"


@dataclass
class RetrievalOutcome:
    """What one search produced, and what it could not.

    `withheld` is counted but deliberately NOT rendered. A message saying three
    entries were hidden tells a caller how much exists behind a boundary they
    were refused at, which is a disclosure the boundary was put there to prevent.
    It is here so a trace can carry it to an operator.
    """

    entries: list[RetrievedEntry] = field(default_factory=list)
    #: Rows dropped by the scope test or the manifest check. Operators only.
    withheld: int = 0
    #: Set when the search could not run. One of the shared taxonomy's codes.
    failure_code: str = ""
    failure_detail: str = ""
    scopes: CallerScopes = field(default_factory=lambda: CallerScopes(frozenset()))

    def as_tool_result(self) -> ToolResult:
        """The tool's output, with no evidence in it by construction.

        `sources` and `sql` are empty unconditionally, including when the entries
        name assets. An entry naming a table is a description of that table, not
        a read of it, and a source list built from descriptions would put a table
        in an answer's provenance that the run never queried.
        """

        return ToolResult(text=self.rendered(), sql="", sources=[])

    def rendered(self) -> str:
        if self.failure_code:
            return (
                f"SEMANTIC SEARCH UNAVAILABLE ({self.failure_code}): {self.failure_detail} "
                "This is discovery, not data, so the question can still be answered: use "
                "list_data_assets and describe_table to find the tables, or ask "
                "dictionary_genie for a definition."
            )
        if not self.entries:
            return (
                f"{NOT_EVIDENCE_NOTICE}\n\nNo semantic entries matched. Fall back to "
                "list_data_assets and describe_table, or ask dictionary_genie what the "
                "terms in the question mean."
            )

        lines = [NOT_EVIDENCE_NOTICE, ""]
        spent = sum(len(line) + 1 for line in lines)
        shown = 0
        for entry in self.entries:
            block = entry.rendered()
            if shown and spent + len(block) + 2 > MAX_RESULT_CHARS:
                break
            lines.append(block)
            lines.append("")
            spent += len(block) + 2
            shown += 1
        if shown < len(self.entries):
            lines.append(
                f"{len(self.entries) - shown} further entr(y/ies) matched and were left out "
                "to stay inside the result budget. Search again with a narrower question or "
                "a kind filter if none of the above is the right one."
            )
        if not self.scopes.verified:
            # Said out loud because the same empty-ish result has two very
            # different causes, and a reader who cannot tell them apart concludes
            # the semantic layer is thin rather than that it was not scoped.
            lines.append(
                "This search ran without a verified signed-in identity, so it returned only "
                "entries marked readable by everyone. A user-authorized run sees more."
            )
        lines.append(DISCOVERY_NOT_PERMISSION_NOTICE)
        return "\n".join(lines).rstrip()


class SemanticRetrieval:
    """Search the semantic layer, then enforce what the index cannot."""

    def __init__(
        self,
        settings: Settings,
        workspace: Any,
        *,
        user_authorized: bool = False,
        index: str = "",
    ):
        self.settings = settings
        self.workspace = workspace
        self.user_authorized = user_authorized
        self.index = index or sl.index_name(settings.catalog, settings.schema)
        # Lower-cased once. The manifest is written by a release and an entry's
        # asset by a build, and Unity Catalog names are case-insensitive, so
        # comparing them raw drops entries for a reason nobody could see.
        self._declared = {name.lower() for name in settings.readable_tables}

    def retrieve(
        self,
        question: str,
        *,
        kind: str = "",
        label: str = "",
        title: str = "",
        domain: str = "",
        certification: str = "",
        limit: int = DEFAULT_LIMIT,
    ) -> RetrievalOutcome:
        scopes = caller_scopes(self.workspace, user_authorized=self.user_authorized)
        wanted = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
        filters = _filters(kind=kind, label=label, title=title, domain=domain,
                           certification=certification)

        try:
            response = self.workspace.vector_search_indexes.query_index(
                index_name=self.index,
                columns=list(sl.RETRIEVED_COLUMNS),
                query_text=question,
                # Semantic and keyword together. A question naming a column
                # exactly should find that column, and nearest-neighbour scoring
                # alone ranks it below entries that merely read like it.
                query_type="HYBRID",
                num_results=min(wanted * OVERFETCH, MAX_FETCH),
                filters_json=json.dumps(filters) if filters else None,
            )
        except Exception as error:  # noqa: BLE001 - discovery failing is not the run failing
            return RetrievalOutcome(
                failure_code=DEPENDENCY_UNAVAILABLE,
                failure_detail=_clean(error),
                scopes=scopes,
            )

        outcome = RetrievalOutcome(scopes=scopes)
        for row in _rows(response):
            if not self._permitted(row, scopes):
                outcome.withheld += 1
                continue
            # Re-applied rather than trusted. The pushdown decided which rows the
            # top-k was spent on; whether a row is returned is decided here, so a
            # filter the index ignored cannot widen the result.
            if not _matches(row, filters):
                outcome.withheld += 1
                continue
            outcome.entries.append(_entry(row))
            if len(outcome.entries) >= wanted:
                break
        return outcome

    def _permitted(self, row: dict[str, Any], scopes: CallerScopes) -> bool:
        """Whether this caller may see this entry at all.

        Two independent tests, both of which must pass. The manifest check is the
        stronger of the two because it is local and current: it is the same list
        `validate_sql` refuses statements against, so an entry outside it
        describes something no read could reach anyway.
        """

        asset = str(row.get("asset") or "").strip()
        if asset and asset.lower() not in self._declared:
            return False
        granted = _scope_tokens(row.get("authorized_scope"))
        return bool(granted & scopes.tokens)


def _scope_tokens(value: Any) -> frozenset[str]:
    """Scope tokens off one row, however the transport shaped them.

    An index returns an array column as a list, and has been observed to return
    it as a JSON string. A value that is neither yields NO tokens, so the entry
    matches nobody: the alternative to failing closed here is a parsing quirk
    that quietly publishes the whole corpus.
    """

    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return frozenset()
    if not isinstance(value, (list, tuple)):
        return frozenset()
    return frozenset(str(item) for item in value if str(item).strip())


def _filters(**named: str) -> dict[str, str]:
    """The scalar filters, keyed by the column each one applies to.

    Only `sl.FILTER_COLUMNS`. A caller-supplied dimension that is not a column
    cannot be filtered by the index and must not be silently dropped either, so
    the tool schema offers exactly these and nothing else.
    """

    columns = {"kind": "entry_kind"}
    chosen: dict[str, str] = {}
    for key, value in named.items():
        column = columns.get(key, key)
        cleaned = str(value or "").strip()
        if cleaned and column in sl.FILTER_COLUMNS:
            chosen[column] = cleaned
    return chosen


def _matches(row: dict[str, Any], filters: dict[str, str]) -> bool:
    return all(str(row.get(column) or "") == value for column, value in filters.items())


def _rows(response: Any) -> list[dict[str, Any]]:
    """The response as dicts, keyed by the column names it reports.

    BY NAME, NEVER BY POSITION. The response appends a score column that is not
    in the projection, and a positional read shifts every field by one the moment
    anything else is appended beside it.
    """

    manifest = getattr(response, "manifest", None)
    names = [
        str(getattr(column, "name", "") or "")
        for column in (getattr(manifest, "columns", None) or [])
    ]
    result = getattr(response, "result", None)
    rows: list[dict[str, Any]] = []
    for values in getattr(result, "data_array", None) or []:
        # Not strict: the response carries a score column the projection did not
        # ask for, so the two sequences are expected to differ in length.
        paired = zip(names, values, strict=False)
        rows.append({name: value for name, value in paired if name})
    return rows


def _entry(row: dict[str, Any]) -> RetrievedEntry:
    def text(key: str) -> str:
        return str(row.get(key) or "")

    return RetrievedEntry(
        entry_kind=text("entry_kind"),
        name=text("name"),
        asset=text("asset"),
        content=text("content"),
        label=text("label"),
        title=text("title"),
        domain=text("domain"),
        certification=text("certification") or sl.UNCERTIFIED,
        source=text("source"),
        source_ref=text("source_ref"),
        contract_version=text("contract_version"),
        generated_at=text("generated_at"),
    )


def _clean(error: Exception) -> str:
    detail = str(error).strip().splitlines()
    return detail[0][:300] if detail else error.__class__.__name__


#: The tool as the model sees it. The description says what the results may NOT
#: be used for, because the entries read like authoritative statements and a
#: model told only what a tool is for will use its output for whatever fits.
SEARCH_SEMANTICS_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "Search this deployment's semantic layer for the tables, columns, metric "
            "definitions, business terms, approved joins and example questions relevant to a "
            "question. Use it FIRST, instead of listing every declared table and describing "
            "them one at a time. It returns descriptions only: no figures, no rows, and "
            "nothing that may be reported as a fact, a source or a number. Once it has told "
            "you which tables and terms matter, get the actual answer from data_genie, "
            "dictionary_genie or SQL. What it finds is not what you may read: this searches a "
            "cached catalog of descriptions, and every read afterwards is authorized "
            "separately by Unity Catalog as the signed-in user."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": (
                        "What you are trying to find, in the user's own words where "
                        "possible. Exact column, metric and table names are matched as "
                        "keywords, so include them when the user used them."
                    ),
                },
                "kind": {
                    "type": "string",
                    "enum": list(sl.ENTRY_KINDS),
                    "description": "Narrow to one kind of entry. Omit to search all of them.",
                },
                "domain": {
                    "type": "string",
                    "description": "Narrow to one subject area, exactly as the entries spell it.",
                },
                "title": {
                    "type": "string",
                    "description": "Narrow to one product or title.",
                },
                "label": {
                    "type": "string",
                    "description": "Narrow to one organizational label.",
                },
                "certification": {
                    "type": "string",
                    "enum": list(sl.CERTIFICATIONS),
                    "description": (
                        "Narrow to entries at one certification level. 'certified' means a "
                        "human approved the definition; most entries are generated from "
                        "Unity Catalog comments and are not."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": f"How many entries to return, at most {MAX_LIMIT}.",
                },
            },
            "required": ["question"],
        },
    },
}
