"""That the same definition is looked up once a run, not once a question.

WHAT THIS IS ABOUT. The dictionary space is the slowest thing a run touches and
the model asks it one field at a time. In recorded runs that shows up as batches:
one step made eight back-to-back `dictionary_genie` calls totalling 84 seconds,
and another asked in step 3 for a column it had already looked up in step 2.
Genie is 48% of a run's wall time, so eight round trips where one would do is not
a rounding error -- and it is WORK, not waiting, so overlapping it would still
cost Genie eight questions and still bill for eight.

The fix removes the calls instead: several definition questions in one step become
one question, and a question this run has already answered is answered from the
run's own memo. Both are asserted here on the MECHANISM -- how many times the tool
surface was reached, how many replies the model got, how many copies of an answer
reach the evidence package -- because a wall-clock assertion over the handful of
runs that share the current span schema would prove nothing either way.

Four properties matter beyond the saving, and each has cost something before:

1. Every call still gets its own reply. A `tool_call_id` with no reply is a
   transcript some providers reject outright.
2. Nothing is invented. What a shared call reports is what the space said, with
   one line saying it was asked alongside the others.
3. One event is recorded once. A failed shared call is ONE outage, not eight, or
   the answer's caveats describe a surface that collapsed.
4. The repeat brake keeps its precondition. It is keyed on the tool name and has
   to see the first failure before a second call to that tool is issued; there
   is no longer a second call to see, which is stronger than serialising them.
"""

from __future__ import annotations

from test_agent import ACTIVITY, Call, FakeTools, ScriptedLlm, ask, build, stages

from tools import ToolResult, combine_dictionary_questions, normalise_dictionary_question

FIELDS = (
    "net_bookings_usd",
    "recurrent_consumer_spending_usd",
    "completed_purchases",
    "list_price_usd",
    "gross_bookings_usd",
    "refunds_usd",
    "session_count",
    "days_active",
)

DEFINITION_TEXT = "Every one of those columns is defined in the governed dictionary."


def definition_calls(llm, tools):
    return tools.named("dictionary_genie")


def tool_stages(response):
    return [
        stage
        for stage in stages(response)
        if stage.get("kind") in {"tool", "genie", "sql", "discovery", "plot", "knowledge"}
    ]


def tool_replies(llm):
    return [message for message in llm.transcript if message.get("role") == "tool"]


def synthesis_prompt(llm) -> str:
    """The user half of the closing synthesis call, which is where evidence lands."""

    from test_agent import PLANNER_PREFIX

    closing = [
        call
        for call in llm.calls
        if not call.get("tools")
        and not str(call["messages"][0].get("content") or "").startswith(PLANNER_PREFIX)
    ]
    assert closing, "the run never reached the synthesis call"
    return str(closing[-1]["messages"][-1]["content"])


def plot_calls(llm) -> list[dict]:
    return [
        call
        for call in llm.calls
        if [tool["function"]["name"] for tool in call.get("tools") or []] == ["new_plot"]
    ]


# ---------------------------------------------------------------------------
# Building the one question
# ---------------------------------------------------------------------------


def test_the_combined_question_carries_every_question_verbatim():
    """No rewriting. A question the model did not ask must not get answered."""

    combined = combine_dictionary_questions(
        ["What does net_bookings_usd mean?", "What does list_price_usd mean?"]
    )

    assert "What does net_bookings_usd mean?" in combined
    assert "What does list_price_usd mean?" in combined
    assert "(1)" in combined and "(2)" in combined


def test_one_question_is_left_exactly_as_it_was():
    """A lone lookup must not grow a preamble it did not need."""

    assert combine_dictionary_questions(["What does list_price_usd mean?"]) == (
        "What does list_price_usd mean?"
    )


def test_the_same_question_twice_is_one_question():
    combined = combine_dictionary_questions(
        ["What does list_price_usd mean?", "what does list_price_usd mean"]
    )

    assert combined == "What does list_price_usd mean?"


def test_the_key_normalises_case_and_punctuation_and_nothing_else():
    """Two spellings of one question share a key; two questions never do."""

    assert normalise_dictionary_question("What does spend_usd mean?") == (
        normalise_dictionary_question("  what does spend_usd MEAN  ")
    )
    assert normalise_dictionary_question("What does spend mean?") != (
        normalise_dictionary_question("What does spend_usd mean?")
    )


# ---------------------------------------------------------------------------
# One step, several questions
# ---------------------------------------------------------------------------


def test_eight_definition_questions_in_one_step_become_one_call():
    """The headline: eight calls became one, and all eight were still answered."""

    tools = FakeTools(dictionary_genie=ToolResult(text=DEFINITION_TEXT))
    llm = ScriptedLlm(
        [
            Call("dictionary_genie", {"question": f"What does {field} mean?"}, call_id=field)
            for field in FIELDS
        ]
    )

    response = ask(build(llm, tools))

    asked = definition_calls(llm, tools)
    assert len(asked) == 1, f"the step made {len(asked)} calls to the dictionary space, not one"
    for field in FIELDS:
        assert field in asked[0]["question"], f"{field} was dropped from the combined question"
    assert len(tool_replies(llm)) == len(FIELDS), (
        "the model was not given one reply per tool call, which some providers reject"
    )
    assert len(tool_stages(response)) == len(FIELDS), (
        "the rail lost a call, so a reader cannot account for the step"
    )


def test_the_calls_that_did_not_run_say_so_and_carry_the_real_answer():
    """Honest about the mechanism, and not a paraphrase of the answer."""

    tools = FakeTools(dictionary_genie=ToolResult(text=DEFINITION_TEXT))
    llm = ScriptedLlm(
        [
            Call("dictionary_genie", {"question": "What does net_bookings_usd mean?"}, call_id="a"),
            Call("dictionary_genie", {"question": "What does list_price_usd mean?"}, call_id="b"),
        ]
    )

    response = ask(build(llm, tools))
    shared = tool_stages(response)[1]
    model_reply = tool_replies(llm)[1]["content"]

    assert shared["status"] == "complete"
    assert DEFINITION_TEXT in shared["output"], "the shared reply lost the space's answer"
    assert "in one call" in model_reply, "the model was not told that the call had been shared"
    assert "in one call" not in shared["output"], (
        "model-only call guidance reached the reader trace"
    )
    assert "list_price_usd" in str(shared["input"]), (
        "the rail shows the combined question rather than what the model asked"
    )


def test_the_shared_answer_reaches_the_evidence_package_once():
    """The prompt-size half, which is what makes synthesis and charting erratic.

    Every completed tool result is appended to the evidence package, and that
    package is re-sent with the synthesis prompt and again with the plotting
    prompt. Recorded runs sit at 26,000-54,000 prompt tokens, so eight copies of
    one dictionary answer is paid for repeatedly, in the two steps whose duration
    varies most.
    """

    tools = FakeTools(dictionary_genie=ToolResult(text=DEFINITION_TEXT))
    llm = ScriptedLlm(
        [
            Call("dictionary_genie", {"question": f"What does {field} mean?"}, call_id=field)
            for field in FIELDS
        ]
    )

    ask(build(llm, tools))

    assert synthesis_prompt(llm).count(DEFINITION_TEXT) == 1, (
        "the same definition was charged to the synthesis prompt more than once"
    )


def test_a_shared_call_that_fails_is_one_failure_reported_to_every_caller():
    """One outage, not eight, and no reply is lost to it."""

    tools = FakeTools(dictionary_genie=RuntimeError("the dictionary space timed out"))
    llm = ScriptedLlm(
        [
            Call("dictionary_genie", {"question": "What does net_bookings_usd mean?"}, call_id="a"),
            Call("dictionary_genie", {"question": "What does list_price_usd mean?"}, call_id="b"),
            Call("dictionary_genie", {"question": "What does refunds_usd mean?"}, call_id="c"),
        ]
    )

    response = ask(build(llm, tools))
    drawn = tool_stages(response)

    assert len(tools.named("dictionary_genie")) == 1
    assert [stage["status"] for stage in drawn[:3]] == ["failed", "failed", "failed"]
    for stage in drawn[1:3]:
        assert "the dictionary space timed out" in stage["output"], (
            "a shared caller was told something other than what actually happened"
        )
    assert len(tool_replies(llm)) == 3


def test_a_data_question_beside_the_definitions_is_untouched():
    """Only the dictionary space is coalesced. Two data questions are two answers.

    Asserted because sharing a `data_genie` result between two questions would
    attribute a figure to a question that did not produce it, which is an accuracy
    failure rather than a slow one.
    """

    tools = FakeTools()
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "how many active players"}, call_id="one"),
            Call("data_genie", {"question": "how many sessions"}, call_id="two"),
            Call("dictionary_genie", {"question": "What does label mean?"}, call_id="three"),
        ]
    )

    ask(build(llm, tools))

    assert len(tools.named("data_genie")) == 2, "two data questions were answered from one call"


# ---------------------------------------------------------------------------
# Across steps
# ---------------------------------------------------------------------------


def test_a_definition_asked_again_in_a_later_step_costs_no_call():
    """The run's own memo. Same run, same caller, same answer."""

    tools = FakeTools(dictionary_genie=ToolResult(text=DEFINITION_TEXT))
    llm = ScriptedLlm(
        [
            Call(
                "dictionary_genie",
                {"question": "What does completed_purchases mean?"},
                call_id="a",
            )
        ],
        [
            Call(
                "dictionary_genie",
                {"question": "what does completed_purchases MEAN"},
                call_id="b",
            )
        ],
    )

    response = ask(build(llm, tools))
    drawn = tool_stages(response)
    model_reply = tool_replies(llm)[1]["content"]

    assert len(tools.named("dictionary_genie")) == 1, (
        "the second step asked the dictionary space something it had already answered"
    )
    assert DEFINITION_TEXT in drawn[1]["output"]
    assert "no new call was made" in model_reply
    assert "no new call was made" not in drawn[1]["output"]
    assert drawn[1]["status"] == "complete"


def test_a_different_definition_in_a_later_step_is_still_asked():
    """The memo must not answer one question with another's definition."""

    tools = FakeTools(dictionary_genie=ToolResult(text=DEFINITION_TEXT))
    llm = ScriptedLlm(
        [Call("dictionary_genie", {"question": "What does completed_purchases mean?"})],
        [Call("dictionary_genie", {"question": "What does refunds_usd mean?"})],
    )

    ask(build(llm, tools))

    assert len(tools.named("dictionary_genie")) == 2


# ---------------------------------------------------------------------------
# The charting step
# ---------------------------------------------------------------------------


def test_a_definitions_only_run_does_not_spend_a_model_call_on_charting():
    """Nothing was read that could go on an axis, so nothing asks for a chart.

    A recorded metadata-only run spent 13.1s in `orchestrator.new_plot` to be
    told there was nothing to draw. The decision is available before the call:
    definitions, column lists and asset names hold no series.
    """

    tools = FakeTools(dictionary_genie=ToolResult(text=DEFINITION_TEXT))
    llm = ScriptedLlm(
        [
            Call("dictionary_genie", {"question": "What does net_bookings_usd mean?"}, call_id="a"),
            Call("dictionary_genie", {"question": "What does list_price_usd mean?"}, call_id="b"),
        ]
    )

    response = ask(build(llm, tools))

    assert plot_calls(llm) == [], "a run holding no rows still asked the model to plot them"
    assert [stage for stage in stages(response) if stage.get("id") == "plot"] == [], (
        "a charting stage was drawn for a step that never ran"
    )


def test_a_run_that_read_rows_still_goes_to_the_charting_step():
    """The guard against an over-eager skip: one data result is enough."""

    tools = FakeTools()
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "how many active players"}),
            Call("dictionary_genie", {"question": "What does label mean?"}),
        ]
    )

    response = ask(build(llm, tools), "How many active players? Chart the result.")

    assert len(plot_calls(llm)) == 1, "a run that returned rows was denied a chart"
    assert [stage for stage in stages(response) if stage.get("id") == "plot"], (
        "the charting stage went missing from a run that had data to plot"
    )


def test_sql_results_count_as_something_to_plot():
    """`run_sql` returns rows, so a SQL-only run keeps its chart."""

    tools = FakeTools(
        run_sql=ToolResult(
            text="profile_label | players\nnorthwind | 8,413",
            sql=f"SELECT profile_label, count(*) FROM {ACTIVITY} GROUP BY profile_label",
            sources=[ACTIVITY],
        )
    )
    llm = ScriptedLlm(
        [Call("run_sql", {"sql": f"SELECT profile_label, count(*) FROM {ACTIVITY} GROUP BY 1"})]
    )

    ask(build(llm, tools), "Count players by label and chart the result.")

    assert len(plot_calls(llm)) == 1
