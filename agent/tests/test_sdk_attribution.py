"""Product and query attribution sent through the Databricks Python SDK."""

from types import SimpleNamespace

import pytest
from databricks.sdk import useragent

import correlation
import sdk_attribution

REQUEST_ONE = "req-7f3c1a20-1111-1111-1111-111111111111"
RUN_ONE = "req-00000000-2222-2222-2222-222222222222"
REQUEST_TWO = "req-33333333-3333-3333-3333-333333333333"


@pytest.fixture(autouse=True)
def clear_query_context():
    correlation.clear_query_ids()
    yield
    correlation.clear_query_ids()


def as_dict(tags) -> dict[str, str]:
    return {tag.key: tag.value for tag in tags}


def test_sdk_product_registration_uses_astrolabe_and_valid_semver():
    useragent._reset_product()

    sdk_attribution.register_sdk_product()

    assert useragent.product() == ("Astrolabe", "0.1.0")
    assert useragent.to_string().startswith("Astrolabe/0.1.0 ")


def test_query_tags_include_only_fixed_attribution_and_validated_scoped_ids():
    correlation.activate_query_ids(SimpleNamespace(request_id=REQUEST_ONE, run_id=RUN_ONE))

    tags = as_dict(sdk_attribution.query_tags("ask", "run_sql"))

    assert tags == {
        "application": "Astrolabe",
        "surface": "ask",
        "tool": "run_sql",
        "correlation_id": REQUEST_ONE,
        "run_id": RUN_ONE,
    }
    serialized = repr(tags)
    assert "SELECT " not in serialized
    assert "question" not in serialized
    assert "@example.com" not in serialized


def test_query_context_is_cleared_and_replaced_between_turns():
    correlation.activate_query_ids(SimpleNamespace(request_id=REQUEST_ONE, run_id=RUN_ONE))
    assert as_dict(sdk_attribution.query_tags("ask", "run_sql"))["run_id"] == RUN_ONE

    correlation.clear_query_ids()
    assert as_dict(sdk_attribution.query_tags("ask", "run_sql")) == {
        "application": "Astrolabe",
        "surface": "ask",
        "tool": "run_sql",
    }

    correlation.activate_query_ids(SimpleNamespace(request_id=REQUEST_TWO, run_id="invalid"))
    tags = as_dict(sdk_attribution.query_tags("ask", "describe_table"))
    assert tags["correlation_id"] == REQUEST_TWO
    assert "run_id" not in tags
    assert REQUEST_ONE not in repr(tags)
    assert RUN_ONE not in repr(tags)
