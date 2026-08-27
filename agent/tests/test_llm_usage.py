"""Token usage recording on MLflow LLM spans."""

from __future__ import annotations

from types import SimpleNamespace

import mlflow

from llm_usage import TOKEN_USAGE_ATTR, record_llm_usage, usage_from_response
from tests.test_agent import CHART_QUESTION, Call, ScriptedLlm, ask, build


def test_usage_from_response_reads_openai_shaped_usage():
    response = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=11, completion_tokens=7, total_tokens=18)
    )

    assert usage_from_response(response) == {
        "prompt_tokens": 11,
        "completion_tokens": 7,
        "total_tokens": 18,
    }


def test_usage_from_response_fails_soft_when_absent():
    assert usage_from_response(SimpleNamespace()) is None
    assert usage_from_response(SimpleNamespace(usage=None)) is None
    assert usage_from_response({"choices": []}) is None


def test_record_llm_usage_sets_span_attribute_and_outputs():
    response = SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=20, completion_tokens=5, total_tokens=25)
    )

    with mlflow.start_span(name="test.llm", span_type="LLM") as span:
        span.set_outputs({"text": "hello"})
        recorded = record_llm_usage(span, response)

        assert recorded == {
            "prompt_tokens": 20,
            "completion_tokens": 5,
            "total_tokens": 25,
        }
        assert span.attributes[TOKEN_USAGE_ATTR] == {
            "input_tokens": 20,
            "output_tokens": 5,
            "total_tokens": 25,
        }
        assert span.outputs["text"] == "hello"
        assert span.outputs["prompt_tokens"] == 20
        assert span.outputs["completion_tokens"] == 5
        assert span.outputs["total_tokens"] == 25


def test_cache_counters_land_on_span_outputs_not_the_tokens_column():
    """prompt_tokens counts cached tokens too, so the Tokens column cannot tell."""

    response = SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=20,
            completion_tokens=5,
            total_tokens=25,
            cache_read_input_tokens=12,
            cache_creation_input_tokens=8,
        )
    )

    with mlflow.start_span(name="test.llm.cache", span_type="LLM") as span:
        span.set_outputs({"text": "hello"})
        recorded = record_llm_usage(span, response)

        assert recorded["cache_read_input_tokens"] == 12
        assert recorded["cache_creation_input_tokens"] == 8
        assert span.outputs["cache_read_input_tokens"] == 12
        assert span.outputs["cache_creation_input_tokens"] == 8
        assert span.attributes[TOKEN_USAGE_ATTR] == {
            "input_tokens": 20,
            "output_tokens": 5,
            "total_tokens": 25,
        }
        assert "cache_read_input_tokens" not in span.attributes[TOKEN_USAGE_ATTR]
        assert "cache_creation_input_tokens" not in span.attributes[TOKEN_USAGE_ATTR]


def test_record_llm_usage_noop_without_usage():
    with mlflow.start_span(name="test.llm.empty", span_type="LLM") as span:
        span.set_outputs({"text": "hello"})
        assert record_llm_usage(span, SimpleNamespace()) is None
        assert TOKEN_USAGE_ATTR not in span.attributes
        assert span.outputs == {"text": "hello"}


def test_answer_trace_aggregates_usage_from_fake_client():
    """Every successful model call that returns usage lands on answer.trace."""

    llm = ScriptedLlm(
        [Call("data_genie", {"question": "figures"})],
        "Done.",
        usage={"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
    )

    answer = ask(build(llm), question=CHART_QUESTION).custom_outputs["answer"]
    trace = answer["trace"]

    # Two loop turns (tool call, then closing prose) + synthesis + plot.
    # Plot only runs when the question asks for a chart; the default ask does not.
    assert len(llm.loop_calls) == 2
    assert trace["prompt_tokens"] == 40
    assert trace["completion_tokens"] == 16
    assert trace["total_tokens"] == 56
