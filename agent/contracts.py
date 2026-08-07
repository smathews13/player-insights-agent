from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Figure(BaseModel):
    label: str
    value: float
    display: str
    comparison: str = ""


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


class Source(BaseModel):
    name: str
    freshness: str


class TraceStage(BaseModel):
    """One step of a run, as the timeline reads it.

    `input` and `output` are the tool's real arguments and real result, uncapped
    here: the cap lives in `agent.py`, where the whole payload's size can be
    reasoned about at once.

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
    #: 0 for a top-level step, 1 for a tool call made inside one. Defaulted so a
    #: stage from a model version that predates nesting reads as top-level.
    depth: int = 0
    #: The `id` of the stage this one ran inside, or "" at the top level.
    parent_id: str = ""


class TraceSummary(BaseModel):
    """What one run did, as the app reads it back.

    `toolCalls` counts EXTERNAL CALLS THE RUN MADE: dictionary Genie, data Genie,
    the read-only SQL fallback, the synthesis model call, the plotting call. It is
    NOT the number of stages tagged `kind="tool"` and is normally larger, because
    `discover` and `synthesis` are tagged `"agent"` and the SQL fallback produces
    no stage of its own.

    The two are different quantities, reported separately: the app exposes the
    tagged stages as `toolStages`. Do not make one derivable from the other.
    """

    id: str
    totalMs: float
    toolCalls: int
    stages: list[TraceStage]


class PlanStep(BaseModel):
    id: str
    title: str
    description: str
    kind: Literal["context", "definitions", "data", "synthesis"]


class AnalysisPlan(BaseModel):
    id: str
    question: str
    summary: str
    steps: list[PlanStep]
    requires_approval: bool = True
    uses_conversation_context: bool = False
    uses_attachment_context: bool = False


class Clarification(BaseModel):
    """The run stopped to ask the user something, rather than guessing.

    The third outcome of a turn, alongside a plan and an answer. Used for a table
    named but not fully qualified, and for a question whose terms are undefined,
    where any interpretation produces a real number for a question nobody asked.

    Deliberately NOT an answer with a caveat: an answer invites the reader to use
    the figures, and there are none worth using here.
    """

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
    id: str
    takeaway: str
    narrative: str
    figures: list[Figure] = Field(default_factory=list)
    charts: list[Chart] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    sql: str = ""
    trace: TraceSummary
