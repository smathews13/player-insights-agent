"""The notebook's finder is a boundary, not an orchestrator prompt section."""

from __future__ import annotations

from data_source_finder import (
    FINDER_SYSTEM_PROMPT,
    MAX_FINDER_PACKAGE_CHARS,
    DiscoveryRequest,
    compact_finder_package,
)
from evidence import EvidenceGateway
from tests.test_agent import (
    MANIFEST,
    TITLE_DAILY,
    Call,
    FakeTools,
    ScriptedLlm,
    app_request,
    build,
)
from tools import ToolResult


def execute(
    runtime,
    question: str,
    history: list[dict] | None = None,
    custom_inputs: dict | None = None,
):
    return runtime.predict(
        app_request(
            input=[*(history or []), {"role": "user", "content": question}],
            custom_inputs={"execute_plan": True, **(custom_inputs or {})},
        )
    )


def test_discovery_request_is_one_self_contained_message_not_chat_history():
    request = DiscoveryRequest(
        intent="Compare retained players for the approved 30-day window.",
        established_context=(
            {"role": "user", "content": "Use the governed retention definition."},
            {"role": "assistant", "content": "I will use the approved aggregate."},
        ),
        attachment_context="window_days=30",
    )

    rendered = request.render()

    assert rendered.startswith("Discovery intent:")
    assert "Established visible context supplied by the orchestrator" in rendered
    assert "window_days=30" in rendered
    assert "none are available" in rendered


def test_finder_invocation_gets_no_role_bearing_conversation_history():
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "retained players for the complete intent"})],
        "## DATA PACKAGE\n- **Findings / data:** 10 retained players.",
    )
    runtime = build(llm, FakeTools())

    execute(
        runtime,
        "Compare retained players.",
        history=[
            {"role": "user", "content": "Use a 30-day window."},
            {"role": "assistant", "content": "Understood."},
        ],
    )

    first_finder_call = llm.loop_calls[0]
    messages = first_finder_call["messages"]
    assert messages[0]["role"] == "system"
    assert messages[0]["content"].startswith("# Role\nYou are the Data Source Finder")
    # The finder has one user request. Earlier turns are inert JSON inside that
    # request, never messages the model can treat as its own conversation.
    user_messages = [message for message in messages if message["role"] == "user"]
    assert len(user_messages) == 1
    assert "Discovery intent:\nCompare retained players." in user_messages[0]["content"]
    assert '"content": "Use a 30-day window."' in user_messages[0]["content"]


def test_each_finder_invocation_builds_a_fresh_message_list():
    llm = ScriptedLlm(
        "## DATA OVERVIEW\n- First invocation.",
        "## DATA OVERVIEW\n- Second invocation.",
        charts=False,
    )
    runtime = build(llm, FakeTools())

    execute(runtime, "What data can answer retention?")
    execute(runtime, "What data can answer spend?")

    first, second = llm.loop_calls
    assert first["messages"] is not second["messages"]
    assert "retention" in first["messages"][1]["content"]
    assert "spend" not in first["messages"][1]["content"]
    assert "spend" in second["messages"][1]["content"]
    assert "retention" not in second["messages"][1]["content"]


def test_finder_owns_notebook_workflow_and_assessed_package_contract():
    assert "Identify candidate governed sources" in FINDER_SYSTEM_PROMPT
    assert "Bind every SQL column" in FINDER_SYSTEM_PROMPT
    assert "null ratio" in FINDER_SYSTEM_PROMPT
    assert "real Markdown table" in FINDER_SYSTEM_PROMPT
    assert "bullet-only summary" in FINDER_SYSTEM_PROMPT
    assert "## DATA PACKAGE" in FINDER_SYSTEM_PROMPT
    assert "- **Provenance:**" in FINDER_SYSTEM_PROMPT
    assert "- **Quality assessment:**" in FINDER_SYSTEM_PROMPT
    assert "- **Gaps:**" in FINDER_SYSTEM_PROMPT
    assert "Today's date" in FINDER_SYSTEM_PROMPT or "relative window" in FINDER_SYSTEM_PROMPT
    assert "invoking signed-in user's Unity Catalog grants" in " ".join(
        FINDER_SYSTEM_PROMPT.split()
    )
    assert "gold/approved aggregates first" in FINDER_SYSTEM_PROMPT
    assert "STOP calling tools" in FINDER_SYSTEM_PROMPT
    assert "do not make the" in FINDER_SYSTEM_PROMPT
    assert "package partial" in FINDER_SYSTEM_PROMPT


def test_finder_carries_the_notebook_geography_contract():
    for rule in (
        "explicit ISO 3166-1 alpha-2 country codes",
        "ask the user to verify the membership",
        "Use `country_code` for cross-market comparisons",
        "Germany-specific rule",
        "for GB and DE",
        "DE is country-level, not a German state or",
        "explicit `Unknown` chart",
        "owning label",
        "governed conversion table",
        "suppression threshold",
    ):
        assert rule in FINDER_SYSTEM_PROMPT


def test_finder_system_prompt_receives_todays_date():
    llm = ScriptedLlm("## DATA PACKAGE\n- **Findings / data:** none.", charts=False)
    execute(build(llm, FakeTools()), "Active players in the last 30 days.")

    system = llm.loop_calls[0]["messages"][0]["content"]
    assert "Today's date is " in system
    assert "last 30 days" in system


def test_finder_system_prompt_uses_the_request_timezone():
    llm = ScriptedLlm("## DATA PACKAGE\n- **Findings / data:** none.", charts=False)
    execute(
        build(llm, FakeTools()),
        "Active players yesterday.",
        custom_inputs={
            "runtime_settings": {"behavior": {"timezone": "America/Los_Angeles"}}
        },
    )

    system = llm.loop_calls[0]["messages"][0]["content"]
    assert "America/Los_Angeles" in system


def test_a_simple_data_question_still_invokes_the_finder():
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "active players"})],
        "## DATA PACKAGE\n- **Findings / data:** 10 active players.",
        charts=False,
    )

    response = execute(build(llm, FakeTools()), "How many active players are there?")

    trace = response.custom_outputs["answer"]["trace"]["stages"]
    assert trace[0]["id"] == "orchestrator"
    assert trace[0]["name"] == "Orchestrator"
    assert trace[1]["id"] == "data_source_finder"
    assert trace[1]["parent_id"] == "orchestrator"
    assert llm.loop_calls[0]["messages"][0]["content"].startswith(
        "# Role\nYou are the Data Source Finder"
    )


def test_orchestrator_delegates_discovery_tools_only_through_finder():
    from agent import DATA_SOURCE_FINDER_TOOLS, LOOP_TOOLS, ORCHESTRATOR_TOOLS

    names = [tool["function"]["name"] for tool in DATA_SOURCE_FINDER_TOOLS]
    assert names == [tool["function"]["name"] for tool in LOOP_TOOLS]
    assert ORCHESTRATOR_TOOLS == ()
    assert "data_genie" in names
    assert "dictionary_genie" in names
    assert "run_sql" in names
    assert "ask_data_source_finder" not in names  # in-process boundary, not a second endpoint tool


def test_gold_query_stays_succeeded_when_optional_silver_is_left_unsampled():
    sql = f"SELECT title_name, active_players FROM {TITLE_DAILY}"
    verdict = EvidenceGateway(MANIFEST).admit_genie_query("data_genie", sql)
    tools = FakeTools(
        data_genie=ToolResult(
            text="VLH Online has 8,413 active players in the requested window.",
            sql=sql,
            sources=[TITLE_DAILY],
            verdicts=(verdict,),
        )
    )
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "query the approved title aggregate"}, "gold"),
            Call("data_genie", {"question": "also sample optional silver activity"}, "silver"),
        ],
        charts=False,
    )

    response = execute(
        build(llm, tools),
        "Compare active players by title over the last 30 days.",
        custom_inputs={
            "runtime_settings": {
                "loop": {"maxSteps": 12, "maxToolCalls": 1, "maxRunSeconds": 90}
            }
        },
    )

    trace = response.custom_outputs["answer"]["trace"]["stages"]
    finder = next(stage for stage in trace if stage["id"] == "data_source_finder")
    cap = next(stage for stage in trace if stage["id"] == "cap")

    assert finder["status"] == "complete"
    assert cap["status"] == "complete"
    assert cap["name"] == "Completed from assessed sources"
    assert tools.named("data_genie") == [{"question": "query the approved title aggregate"}]
    assert not any(
        "stopped early" in caveat.lower()
        for caveat in response.custom_outputs["answer"]["caveats"]
    )


def test_empty_catalog_hit_by_budget_remains_partial():
    tools = FakeTools(
        list_data_assets=ToolResult(
            text="No declared tables are available.",
            sources=[],
        )
    )
    llm = ScriptedLlm(
        [
            Call("list_data_assets", {}, "first-list"),
            Call("list_data_assets", {}, "second-list"),
        ],
        charts=False,
    )

    response = execute(
        build(llm, tools),
        "What engagement data is available?",
        custom_inputs={
            "runtime_settings": {
                "loop": {"maxSteps": 12, "maxToolCalls": 1, "maxRunSeconds": 90}
            }
        },
    )

    trace = response.custom_outputs["answer"]["trace"]["stages"]
    finder = next(stage for stage in trace if stage["id"] == "data_source_finder")
    cap = next(stage for stage in trace if stage["id"] == "cap")

    assert finder["status"] == "partial"
    assert cap["status"] == "partial"
    assert any(
        "stopped early" in caveat.lower()
        for caveat in response.custom_outputs["answer"]["caveats"]
    )


def test_long_data_package_is_compacted_by_more_than_half():
    long_package = "## DATA PACKAGE\n" + "\n".join(
        f"- column {index}: quality assessment and repeated provenance detail {'x' * 90}"
        for index in range(78)
    )

    compact = compact_finder_package(long_package)

    assert len(long_package) > 6_288
    assert len(compact) <= MAX_FINDER_PACKAGE_CHARS
    assert len(compact) < len(long_package) / 2
    assert "Optional detail was clipped" in compact


def test_simple_inventory_uses_only_the_manifest_listing():
    llm = ScriptedLlm(charts=False)
    tools = FakeTools()

    response = execute(build(llm, tools), "what data do you have access to")

    assert response.custom_outputs["type"] == "answer"
    assert len(tools.named("list_data_assets")) == 1
    assert tools.named("search_tagged_assets") == []
    assert tools.named("search_semantics") == []
    assert llm.loop_calls == []


def test_finder_tool_budget_does_not_inherit_an_enclosing_trace_count():
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "active players"})],
        "## DATA PACKAGE\n- **Findings / data:** 10 active players.",
        charts=False,
    )
    tools = FakeTools()
    runtime = build(llm, tools)
    original = runtime._orchestrate

    def orchestrate(question, history, attachment, log, **kwargs):
        log.tool_calls = 99  # work attributed to an enclosing envelope
        return original(question, history, attachment, log, **kwargs)

    runtime.data_source_finder._run = orchestrate
    execute(runtime, "How many active players are there?")

    assert tools.named("data_genie") == [{"question": "active players"}]


def test_deadline_stop_does_not_replay_the_package_in_the_cap_step():
    result = "metric,value\nsessions,402\nactive_players,371"
    sql = f"SELECT sessions, active_players FROM {TITLE_DAILY}"
    verdict = EvidenceGateway(MANIFEST).admit_genie_query("data_genie", sql)
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "launch spike"})],
        charts=False,
    )
    tools = FakeTools(
        data_genie=ToolResult(
            text=result,
            sql=sql,
            sources=[TITLE_DAILY],
            verdicts=(verdict,),
        )
    )
    runtime = build(llm, tools)
    original = runtime._orchestrate

    def orchestrate(question, history, attachment, log, **kwargs):
        generated = original(question, history, attachment, log, **kwargs)
        while True:
            try:
                event = next(generated)
            except StopIteration as stopped:
                return stopped.value
            yield event
            if getattr(event, "id", "") == "step-1-1-data_genie":
                log.started -= 100

    runtime.data_source_finder._run = orchestrate
    response = execute(runtime, "Show the launch spike.")
    trace = response.custom_outputs["answer"]["trace"]["stages"]
    cap = next(stage for stage in trace if stage["id"] == "cap")

    assert cap["status"] == "complete"
    assert result not in cap["output"]
    assert "without another model call" in cap["output"]
