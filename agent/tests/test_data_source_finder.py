"""The notebook's finder is a boundary, not an orchestrator prompt section."""

from __future__ import annotations

from data_source_finder import FINDER_SYSTEM_PROMPT, DiscoveryRequest
from tests.test_agent import Call, FakeTools, ScriptedLlm, app_request, build


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
