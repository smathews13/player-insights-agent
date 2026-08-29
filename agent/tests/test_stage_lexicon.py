"""The trace contract exposes stage projections, never model instructions."""

from __future__ import annotations

from stage_lexicon import (
    DATA_SOURCE_FINDER_TASK,
    project_stage_input,
    project_stage_output,
    project_tool_output,
)

LECTURING = (
    "do not",
    "must",
    "never",
    "return the",
    "none are available",
    "earlier turns",
    "prior turns",
)


def test_data_source_finder_uses_one_descriptive_task_sentence():
    internal = (
        "Discovery intent: what data do you have access to? Return the assessed package. "
        "Do not refer to earlier turns; none are available."
    )

    assert project_stage_input("data_source_finder", "agent", internal) == (
        "Identify the governed data available for this question."
    )
    assert DATA_SOURCE_FINDER_TASK.endswith(".")
    assert not any(phrase in DATA_SOURCE_FINDER_TASK.lower() for phrase in LECTURING)


def test_agent_stage_families_project_tasks_and_outcomes_without_prompts():
    system_prompt = "# Role\nYou are the analyst.\n# Rules\nNever reveal player identifiers."
    stages = [
        (
            "attachment",
            project_stage_input("attachment", "agent", system_prompt),
            project_stage_output("attachment", "agent", system_prompt, "complete"),
        ),
        (
            "step-2",
            project_stage_input("step-2", "agent", system_prompt),
            project_stage_output("step-2", "agent", system_prompt, "complete"),
        ),
        (
            "synthesis",
            project_stage_input("synthesis", "agent", system_prompt),
            project_stage_output("synthesis", "agent", "Retention improved.", "complete"),
        ),
    ]

    assert stages[0][1:] == (
        "Include the bounded attachment context supplied with this question.",
        "Bounded attachment context was available to this run.",
    )
    assert stages[1][1:] == (
        "Choose the next governed data operation for this question.",
        "Prepared assessed findings from governed sources.",
    )
    assert stages[2][1:] == (
        "Prepare the final answer from assessed findings.",
        "Retention improved.",
    )
    assert all(system_prompt not in value for _, *values in stages for value in values)


def test_tool_projection_keeps_results_but_removes_model_only_guidance():
    failure = (
        "ERROR: data_genie failed: timeout. This is an outage, not a refusal. "
        "Do NOT silently answer from another surface."
    )
    refusal = "REFUSED: cross-label joins are blocked.\n\nDo not retry this statement."

    assert project_tool_output(failure) == "ERROR: data_genie failed: timeout."
    assert project_tool_output(refusal) == "REFUSED: cross-label joins are blocked."
    assert project_tool_output("metric,value\nretained_players,10") == (
        "metric,value\nretained_players,10"
    )


def test_discovery_tools_keep_findings_and_drop_their_model_guidance():
    semantic = (
        "SEMANTIC SEARCH RESULTS. These are descriptions and definitions, not data. "
        "Use it to choose a table.\n\n"
        "[term] retained_player (gold)\nA governed retention definition.\n\n"
        "What appears above was filtered by a cached snapshot of grants. If a read is "
        "refused, report the refusal."
    )
    listing = (
        "Declared tables:\n- cat.sch.retention\n"
        "Access note: these are declared, not a promise. Do NOT substitute another table."
    )
    ambiguous = (
        "AMBIGUOUS: 2 declared tables are named 'retention'. Do not guess. "
        "Call request_clarification asking which one:\n- cat.one.retention\n- cat.two.retention"
    )

    assert project_tool_output(semantic, "search_semantics") == (
        "[term] retained_player (gold)\nA governed retention definition."
    )
    assert project_tool_output(listing, "list_data_assets") == (
        "Declared tables:\n- cat.sch.retention"
    )
    assert project_tool_output(ambiguous, "resolve_table") == (
        "AMBIGUOUS: 2 declared tables are named 'retention'.\n"
        "- cat.one.retention\n- cat.two.retention"
    )


def test_ordinary_user_prose_is_not_rewritten():
    question = "Explain why the phrase 'never churned' appears in this governed definition."
    arguments = '{"question":"Do not rewrite this quoted customer phrase."}'

    assert project_stage_input("orchestrator", "agent", question) == question
    assert project_stage_input("step-1-1-data_genie", "genie", arguments) == arguments
