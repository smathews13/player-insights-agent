from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_serializer, model_validator

ANSWER_SCHEMA_VERSION = "pia.answer/1"
PLAN_SCHEMA_VERSION = "pia.plan/1"
CLARIFICATION_SCHEMA_VERSION = "pia.clarification/1"


class Figure(BaseModel):
    label: str
    value: float
    display: str
    comparison: str = ""


class ChartView(BaseModel):
    """One alternative of a switchable chart: a whole Plotly figure with its own label."""

    id: str
    label: str
    data: list[dict[str, Any]]
    layout: dict[str, Any] = Field(default_factory=dict)


class Chart(BaseModel):
    """One Plotly panel, as produced by `charts.new_plot`.

    `data` and `layout` are Plotly's own free-form shapes, carried opaquely to the
    browser. Only the envelope is a contract, and `kind` is derived from the
    traces rather than supplied, so it cannot disagree with `data`.
    """

    id: str
    title: str
    kind: str
    data: list[dict[str, Any]]
    layout: dict[str, Any] = Field(default_factory=dict)
    #: 2-6 alternatives over ONE dimension (metric, segment, time grain). `data` and
    #: `layout` above are always a copy of view one, so an app that ignores views still
    #: draws a correct chart.
    views: list[ChartView] = Field(default_factory=list)
    view_dimension: str = ""

    @model_serializer(mode="wrap")
    def _static_chart_keeps_five_keys(self, handler: Any) -> dict[str, Any]:
        payload = handler(self)
        if not payload.get("views"):
            payload.pop("views", None)
            payload.pop("view_dimension", None)
        return payload


class EvidenceBlock(BaseModel):
    """One completed tool call, structured. Exactly nine keys."""

    turn_id: str = ""
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    result: str = ""
    sources: list[Any] = Field(default_factory=list)
    truncated: bool = False
    total_rows: int | None = None
    compressed: bool = False
    version: str = ""


class Source(BaseModel):
    """One table the run read, and what it read it for.

    `role` is the distinction the run already draws internally and used not to
    publish. A table queried for values is `reading`; a table read to look up
    what a term means, or to see what columns it has, is `reference`. Both are
    sources of the answer and only the first is a source of its numbers, so a
    flat list presented the dictionary the agent consulted as though the figures
    had come out of it.

    Empty means unstated, which is what an answer stored before this field
    existed carries. Readers must say so rather than assuming either role: the
    app has no way to tell from a name, and guessing is how the dictionary came
    to be labelled as the source of the numbers in the first place.
    """

    name: str
    freshness: str
    role: str = ""


class DocumentSnippet(BaseModel):
    """A short, verbatim footnote from an attached document used in the answer."""

    filename: str
    quote: str
    supports: str


class Derivation(BaseModel):
    """What one statement measured, over what, from where.

    Four labelled facts, each derived from the parse of the statement that ran
    (`provenance.py`), never from what the model wrote. Together they answer the
    question a table name and a figure cannot: "8,413 active players" means one
    thing over thirty days and another over a year, and something different again
    with one title filtered out.

    EVERY FIELD MAY BE EMPTY, and empty means the statement did not say. A query
    with no WHERE clause covers everything and has no window, which is a fact
    about it; a Genie statement whose tables could not be resolved has no source.
    A reader must render an empty field as nothing rather than as "unknown" or as
    "all time" -- the second is a claim about the population that nothing here
    checked.

    `filter` never carries the VALUE of a column that identifies a person; the
    column is named and the literal is withheld. See `provenance.py`, which does
    the withholding, for why the column name itself is published.
    """

    #: The fully-qualified table the statement read, or the first of several.
    source: str = ""
    #: What it measured, named as the query named it: the projection's alias where
    #: it had one, otherwise the aggregate itself.
    metric: str = ""
    #: The time range its predicates covered, as a range or a bound.
    window: str = ""
    #: Which rows it kept, beyond the window.
    filter: str = ""


class TraceStage(BaseModel):
    """One step of a run, as the timeline reads it.

    `input` and `output` are the allowlisted reader projection. Tool stages keep
    their arguments and concrete result, with agent-only retry and safety
    guidance removed. Agent stages keep only a compact task and outcome, never
    their model prompt or internal handoff. The size cap lives in `agent.py`.

    `depth` and `parent_id` express nesting. A tool-calling loop is a tree, and a
    flat list of siblings misrepresents it as a sequence of equals.
    """

    id: str
    name: str
    kind: str
    start: float
    duration: float
    status: Literal["complete", "running", "partial", "failed"]
    calls: int = 1
    input: str = ""
    output: str = ""
    #: Fully-qualified table names this discovery step enumerated.
    #:
    #: Separate from ``output`` on purpose. This small structured projection lets
    #: live/replayed clients render an honest table inventory without parsing
    #: prose.
    tables: list[str] = Field(default_factory=list)
    #: 0 for a top-level step, 1 for a tool call made inside one. Defaulted so a
    #: stage from a model version that predates nesting reads as top-level.
    depth: int = 0
    #: The `id` of the stage this one ran inside, or "" at the top level.
    parent_id: str = ""


class GenieSpace(BaseModel):
    """A Genie space this run put a question to.

    Recorded per run because the space is chosen at request time from settings
    baked into the model artifact, so it is a fact only the run itself knows: the
    app cannot read the orchestrator's configuration, and a deployment can be
    re-logged against different spaces without the app noticing. Without this,
    nothing anywhere records which space answered a given question.

    Both halves, because they answer different questions. `id` is what an admin
    needs to open the space or match it against the bundle; `title` is what a
    reader should be shown, since a 32-character hex id names infrastructure and
    tells a person nothing. `title` is empty when no title was baked at log time,
    and a reader with an empty title has to fall back rather than print a blank.
    """

    id: str
    title: str = ""


class ResourceCall(BaseModel):
    """Calls this run dispatched to one configured external resource.

    This is deliberately identifier-only telemetry. It carries no prompt,
    result, query text, or token contents. `calls` is incremented on dispatch,
    including a request that later fails, because the external service was
    still asked and may still have billed it.
    """

    kind: Literal["genie-space", "vector-index"]
    id: str
    tool: Literal["data_genie", "genie_mcp", "dictionary_genie", "search_semantics"]
    calls: int = 1


class TraceSummary(BaseModel):
    """What one run did, as the app reads it back.

    `toolCalls` counts EXTERNAL CALLS THE RUN MADE: dictionary Genie, data Genie,
    the read-only SQL fallback, the synthesis model call, the plotting call. It is
    NOT the number of stages tagged `kind="tool"` and is normally larger, because
    `discover` and `synthesis` are tagged `"agent"` and the SQL fallback produces
    no stage of its own.

    The two are different quantities, reported separately: the app exposes the
    tagged stages as `toolStages`. Do not make one derivable from the other.

    `prompt_tokens` / `completion_tokens` / `total_tokens` are the sum of every
    chat-completions `usage` block recorded this turn. Zero when the endpoint
    did not return usage, not when the run made no model calls: the two are not
    distinguishable from the totals alone, and a missing meter must not look
    like a free run.

    `genie_spaces` are the spaces this run actually called, in the order it first
    reached each, and it is empty for a run that asked Genie nothing. Recorded on
    dispatch rather than on a successful reply, so a run refused by a space it was
    never shared with still says which space refused it -- which is the run whose
    routing someone most needs to see.
    """

    id: str
    totalMs: float
    toolCalls: int
    stages: list[TraceStage]
    genie_spaces: list[GenieSpace] = Field(default_factory=list)
    resource_calls: list[ResourceCall] = Field(default_factory=list)
    genie_transport: Literal["direct", "mcp"] = "direct"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class PlanStep(BaseModel):
    id: str
    title: str
    description: str
    kind: Literal["context", "definitions", "data", "synthesis"]


class PlanCandidate(BaseModel):
    table: str
    field: str
    definition: str
    why: str
    recommended: bool = False


class AnalysisPlan(BaseModel):
    schema_version: Literal["pia.plan/1"] = PLAN_SCHEMA_VERSION
    id: str
    question: str
    summary: str
    steps: list[PlanStep]
    candidates: list[PlanCandidate] = Field(default_factory=list, max_length=3)
    requires_approval: bool = True
    uses_conversation_context: bool = False
    uses_attachment_context: bool = False

    @model_validator(mode="after")
    def candidates_match_steps(self) -> AnalysisPlan:
        if not self.candidates:
            return self
        # A grouped data step can require several governed tables together.
        # In that shape every candidate is in scope, so there is no single
        # primary source for the approval UI to select.
        if len(self.steps) == 1 and all(candidate.recommended for candidate in self.candidates):
            return self
        if len(self.candidates) != len(self.steps):
            raise ValueError("plan candidates must be index-aligned with steps")
        if sum(candidate.recommended for candidate in self.candidates) != 1:
            raise ValueError("exactly one plan candidate must be recommended")
        return self


class Clarification(BaseModel):
    """The run stopped to ask the user something, rather than guessing.

    The third outcome of a turn, alongside a plan and an answer. Used for a table
    named but not fully qualified, and for a question whose terms are undefined,
    where any interpretation produces a real number for a question nobody asked.

    Deliberately NOT an answer with a caveat: an answer invites the reader to use
    the figures, and there are none worth using here.
    """

    schema_version: Literal["pia.clarification/1"] = CLARIFICATION_SCHEMA_VERSION
    id: str
    #: One short, specific question. What the user has to supply, not an apology.
    question: str
    #: Why the question cannot be answered as asked, in a sentence.
    reason: str = ""
    #: Concrete choices when there are any: candidate full table names, or the
    #: country sets a region might mean. Empty rather than fabricated.
    options: list[str] = Field(default_factory=list)
    #: What was attempted before stopping, so "why is it asking me this" is
    #: answerable from the steps.
    trace: TraceSummary


class AnswerContract(BaseModel):
    schema_version: Literal["pia.answer/1"] = ANSWER_SCHEMA_VERSION
    id: str
    takeaway: str
    narrative: str
    #: Concrete findings returned by the run, kept separate from interpretation.
    content: str = ""
    figures: list[Figure] = Field(default_factory=list)
    charts: list[Chart] = Field(default_factory=list)
    #: The result text of each completed row-returning call, in run order, so "plot
    #: that" next turn draws from the rows the query returned, not from a markdown
    #: table in the answer text.
    chart_evidence: list[str] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    document_snippets: list[DocumentSnippet] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    #: Per-statement provenance, in the order the run ran them.
    #:
    #: NOT called `provenance` on purpose, and this is a wire-compatibility point
    #: rather than a preference. The app already sends the browser a field by that
    #: name, meaning which PARTS of an answer came from a live run
    #: (`shared/answer-provenance.ts`), and the ask route builds its reply by
    #: spreading the agent's answer and then setting its own. A field called
    #: `provenance` here would be silently overwritten by that, which is the worst
    #: of the three outcomes: it would read as an agent that stopped reporting.
    derivation: list[Derivation] = Field(default_factory=list)
    sql: str = ""
    trace: TraceSummary
    #: Every completed tool call as a structured block, so a later turn can reuse it.
    evidence_blocks: list[EvidenceBlock] = Field(default_factory=list)

    @field_validator("takeaway", "narrative", "content", "sql", mode="before")
    @classmethod
    def _null_string_is_empty(cls, value: Any) -> Any:
        """An explicit JSON null means 'nothing here', not a validation failure."""

        return "" if value is None else value

    @field_validator(
        "figures",
        "charts",
        "sources",
        "document_snippets",
        "caveats",
        "derivation",
        "chart_evidence",
        "evidence_blocks",
        mode="before",
    )
    @classmethod
    def _null_list_is_empty(cls, value: Any) -> Any:
        """A null section is none of that section, not a failed answer object."""

        return [] if value is None else value


class Dashboard(BaseModel):
    """One self-contained HTML page, rendered by the app in a sandboxed iframe."""

    schema_version: Literal["pia.dashboard/1"] = "pia.dashboard/1"
    title: str
    html: str
    generated_at: str = ""
    truncated: bool = False
    caveats: list[str] = Field(default_factory=list)


class DashboardDraft(BaseModel):
    """What the model returns: the title and the whole document, nothing else."""

    title: str
    html: str


class ReportFigure(BaseModel):
    label: str
    #: Already formatted for the reader ("62%", "1.4M").
    value: str
    caption: str = ""


class ReportTable(BaseModel):
    id: str = ""
    title: str = ""
    columns: list[str] = Field(default_factory=list)
    align: list[Literal["left", "right", "center"]] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)


class ReportChartPanel(BaseModel):
    id: str
    title: str
    kind: str
    plotly: dict[str, Any]


class ReportSection(BaseModel):
    id: str = ""
    heading: str = ""
    body: str = ""
    figures: list[ReportFigure] = Field(default_factory=list)
    table: ReportTable | None = None
    charts: list[ReportChartPanel] = Field(default_factory=list)
    note: str = ""


class ReportSource(BaseModel):
    name: str
    freshness: str = ""


class Report(BaseModel):
    """A multi-section document. Reader-facing only: no trace, SQL or internal ids."""

    schema_version: Literal["pia.report/1"] = "pia.report/1"
    title: str
    subtitle: str = ""
    theme: Literal["page", "presentation"] = "page"
    summary: str = ""
    sections: list[ReportSection] = Field(default_factory=list)
    sources: list[ReportSource] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    generated_at: str = ""
    provenance: Any = None


class ReportDraftSection(BaseModel):
    """A section as the model writes it: at most one table, held in a list so the strict
    schema needs no optional (anyOf) member."""

    id: str = ""
    heading: str = ""
    body: str = ""
    figures: list[ReportFigure] = Field(default_factory=list)
    tables: list[ReportTable] = Field(default_factory=list)
    note: str = ""


class ReportDraft(BaseModel):
    """What the model fills in. No charts key: charts are drawn by the plot step."""

    title: str
    subtitle: str = ""
    theme: Literal["page", "presentation"] = "page"
    summary: str = ""
    sections: list[ReportDraftSection] = Field(default_factory=list)
