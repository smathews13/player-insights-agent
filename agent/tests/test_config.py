"""How configuration reaches the running agent, and what happens when it does not.

The serving container inherits none of the PLAYER_INSIGHTS_* variables the
release shell exports, so two things need proving: a value set at log time
survives into the loaded model, and a value nobody set stops the process instead
of quietly becoming some other deployment's.
"""

from __future__ import annotations

import pytest
import yaml
from mlflow.models.model_config import _set_model_config

from config import (
    BAKED_AT_LOG_TIME,
    ENV_VARS,
    FROM_ARTIFACT,
    FROM_DEFAULT,
    FROM_ENVIRONMENT,
    FROM_PROFILE,
    MUTABILITY,
    MUTABILITY_TIERS,
    PROFILE_VAR,
    REQUIRED_KEYS,
    MissingConfiguration,
    Settings,
    baked_config,
)

CUSTOMER = {
    "PLAYER_INSIGHTS_CATALOG": "acme_catalog",
    "PLAYER_INSIGHTS_SCHEMA": "player_insights",
    "PLAYER_INSIGHTS_WAREHOUSE_ID": "wh-acme",
    "PLAYER_INSIGHTS_DATA_GENIE_ID": "space-data-acme",
    "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "space-dict-acme",
}

EXAMPLE_VALUES = (
    "<your_catalog>",
    "<your_schema>",
    "<sql-warehouse-id>",
    "<data-genie-space-id>",
    "<dictionary-genie-space-id>",
)


def assert_no_example(settings: Settings) -> None:
    """Nothing in these settings came from the demo environment."""

    resolved = (
        settings.catalog,
        settings.schema,
        settings.warehouse_id,
        settings.data_genie_space_id,
        settings.dictionary_genie_space_id,
    )
    leaked = sorted(set(resolved) & set(EXAMPLE_VALUES))
    assert not leaked, f"demo values reached a customer deployment: {leaked}"


# ---------------------------------------------------------------------------
# The environment, which is what log time has
# ---------------------------------------------------------------------------


def test_environment_supplies_every_required_value():
    settings = Settings.from_env(env=CUSTOMER, baked={})

    assert settings.namespace == "acme_catalog.player_insights"
    assert settings.warehouse_id == "wh-acme"
    assert settings.data_genie_space_id == "space-data-acme"
    assert settings.dictionary_genie_space_id == "space-dict-acme"
    assert_no_example(settings)


def test_values_that_are_not_environment_specific_still_default():
    """A foundation-model endpoint and a token ceiling are the same everywhere."""

    settings = Settings.from_env(env=CUSTOMER, baked={})

    assert settings.llm_endpoint == "databricks-claude-sonnet-4-6"
    assert settings.max_output_tokens == 2500
    # The SQL fallback's allowlist follows the catalog it was given, so it can
    # never be left pointing at the previous deployment's catalog.
    assert settings.catalog_allowlist == ("acme_catalog",)


# ---------------------------------------------------------------------------
# Missing configuration
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("key", REQUIRED_KEYS)
def test_one_missing_value_raises_instead_of_defaulting(key):
    from config import ENV_VARS

    partial = {name: value for name, value in CUSTOMER.items() if name != ENV_VARS[key]}

    with pytest.raises(MissingConfiguration) as raised:
        Settings.from_env(env=partial, baked={})

    message = str(raised.value)
    assert key in message
    assert ENV_VARS[key] in message, "the error has to name the variable that fixes it"


def test_an_empty_environment_names_everything_it_needs():
    with pytest.raises(MissingConfiguration) as raised:
        Settings.from_env(env={}, baked={})

    message = str(raised.value)
    for key in REQUIRED_KEYS:
        assert key in message


def test_the_demo_values_only_arrive_when_asked_for_by_name():
    with pytest.raises(MissingConfiguration):
        Settings.from_env(env={}, baked={})

    settings = Settings.from_env(env={PROFILE_VAR: "<your profile>"}, baked={})
    assert settings.catalog == "<your_catalog>"
    assert settings.warehouse_id == "<sql-warehouse-id>"


def test_an_unknown_profile_is_a_failure_that_says_so():
    with pytest.raises(MissingConfiguration) as raised:
        Settings.from_env(env={PROFILE_VAR: "acme"}, baked={})

    assert "not a known profile" in str(raised.value)


# ---------------------------------------------------------------------------
# The artifact, which is what serving has
# ---------------------------------------------------------------------------


def test_the_artifact_carries_configuration_into_a_bare_environment():
    """The serving case: no PLAYER_INSIGHTS_* variables anywhere."""

    logged = Settings.from_env(env=CUSTOMER, baked={}).as_model_config()

    served = Settings.from_env(env={}, baked=logged)

    assert served.namespace == "acme_catalog.player_insights"
    assert served.warehouse_id == "wh-acme"
    assert served.tables == Settings.from_env(env=CUSTOMER, baked={}).tables
    assert_no_example(served)


def test_the_artifact_wins_over_a_contradicting_environment():
    """The logged config named the resources auth passthrough grants.

    An endpoint-level override could point the agent at a warehouse the model
    has no permission for, so it does not get to.
    """

    logged = Settings.from_env(env=CUSTOMER, baked={}).as_model_config()

    served = Settings.from_env(
        env={"PLAYER_INSIGHTS_WAREHOUSE_ID": "<sql-warehouse-id>"}, baked=logged
    )

    assert served.warehouse_id == "wh-acme"


def test_a_variable_left_over_from_the_retired_checks_changes_nothing():
    """The one setting a served endpoint could still be talked out of, retired.

    `preflight_table_source` chose what the dependency checks enumerated, and it
    was deliberately NOT baked so it could be changed without re-logging: the
    single field whose value a model version did not fix. The checks are gone, so
    a shell that still exports the variable from an earlier release must be inert
    rather than resolving into anything.
    """

    logged = Settings.from_env(env=CUSTOMER, baked={}).as_model_config()
    assert "preflight_table_source" not in logged

    served = Settings.from_env(
        env={"PLAYER_INSIGHTS_PREFLIGHT_TABLE_SOURCE": "namespace"}, baked=logged
    )

    assert not hasattr(served, "preflight_table_source")
    assert served == Settings.from_env(env={}, baked=logged)


def test_the_baked_config_survives_mlflows_yaml_round_trip(tmp_path):
    """MLflow writes model_config to YAML in the artifact and hands back a path.

    Tuples do not survive that, so this asserts against the real reader rather
    than against the dict we happened to pass in.
    """

    logged = Settings.from_env(env=CUSTOMER, baked={}).as_model_config()
    config_file = tmp_path / "model_config.yaml"
    config_file.write_text(yaml.safe_dump(logged))

    _set_model_config(str(config_file))
    try:
        served = Settings.from_env(env={})
    finally:
        _set_model_config(None)

    assert served.warehouse_id == "wh-acme"
    assert served.catalog_allowlist == ("acme_catalog",)
    assert served.tables == Settings.from_env(env=CUSTOMER, baked={}).tables
    assert_no_example(served)


def test_no_model_config_is_not_an_error_by_itself():
    """Log time, the preflight CLI, and tests all run outside a model load."""

    _set_model_config(None)
    assert baked_config() == {}


# ---------------------------------------------------------------------------
# Provenance, which is the half a deployer cannot see any other way
#
# A resolved value looks identical whichever route it took, and the route is the
# question: the same Genie space id is correct out of the artifact and wrong out
# of a shell. These prove the recorded provenance matches the precedence.
# ---------------------------------------------------------------------------


def entry(settings: Settings, key: str) -> dict:
    return next(item for item in settings.configuration_report() if item["key"] == key)


def test_provenance_names_the_artifact_when_serving_read_the_artifact():
    logged = Settings.from_env(env=CUSTOMER, baked={}).as_model_config()

    served = Settings.from_env(env={}, baked=logged)

    assert entry(served, "data_genie_space_id")["source"] == FROM_ARTIFACT
    assert entry(served, "catalog")["source"] == FROM_ARTIFACT


def test_provenance_names_the_environment_when_a_shell_supplied_it():
    """What log time looks like, and what a serving endpoint must never look like.

    An endpoint reporting `environment` for one of these has no record in its
    model version of where its data came from, which is the state config.py's
    docstring exists to make impossible.
    """

    settings = Settings.from_env(env=CUSTOMER, baked={})

    assert entry(settings, "warehouse_id")["source"] == FROM_ENVIRONMENT
    assert entry(settings, "schema")["source"] == FROM_ENVIRONMENT


def test_provenance_distinguishes_a_named_profile_from_a_compiled_default():
    settings = Settings.from_env(env={PROFILE_VAR: "<your profile>"}, baked={})

    assert entry(settings, "catalog")["source"] == FROM_PROFILE
    # No profile carries the model endpoint, so it fell to the class default.
    assert entry(settings, "llm_endpoint")["source"] == FROM_DEFAULT


def test_provenance_is_not_baked_so_the_laptops_answer_cannot_become_the_endpoints():
    """`sources` describes how THIS process found its configuration.

    Baking it would preserve "environment" from the shell that logged the model
    and re-report it from inside serving, which would turn the one field that
    exists to expose the defect into a witness for it.
    """

    logged = Settings.from_env(env=CUSTOMER, baked={}).as_model_config()

    assert "sources" not in logged


def test_an_unresolved_settings_object_reports_its_provenance_as_unknown():
    """Built by hand rather than resolved: tests, and `dataclasses.replace`.

    Empty rather than `artifact`, so a reader cannot mistake "nobody recorded
    this" for "the model version vouches for it".
    """

    built = Settings(
        llm_endpoint="e",
        warehouse_id="w",
        data_genie_space_id="d",
        dictionary_genie_space_id="x",
        catalog="c",
        schema="s",
        catalog_allowlist=("c",),
        max_output_tokens=10,
    )

    assert {item["source"] for item in built.configuration_report()} == {""}


def test_every_setting_says_what_it_would_take_to_change_it():
    """A field added without deciding this would be reported as unchangeable.

    Which is why the map is asserted against ENV_VARS rather than sampled: the
    settings pane renders `mutability` as the instruction for how to change a
    value, and a missing entry there is a blank instruction.
    """

    assert set(MUTABILITY) == set(ENV_VARS)
    # Subset, not equality: this module names the tiers for the whole deployment,
    # and three of them belong to the app's own settings, which are not resolved
    # here. The app's registry asserts it uses no tier absent from this list.
    assert set(MUTABILITY.values()) <= set(MUTABILITY_TIERS)

    report = Settings.from_env(env=CUSTOMER, baked={}).configuration_report()
    assert {item["key"] for item in report} == set(ENV_VARS)
    assert all(item["mutability"] in MUTABILITY_TIERS for item in report)


def test_every_agent_setting_is_now_fixed_by_the_model_version():
    """Everything that names a workspace's data is baked, and so is unforgeable.

    Stated as a test because the settings pane and the first-run wizard both
    read `mutability` to decide whether to offer an edit box. One key wrongly
    marked adjustable is a form that appears to change a Genie space id and does
    not.

    The set was `{"preflight_table_source"}` until the dependency checks it
    configured were removed, and it is empty rather than gone: a new field
    defaulting to anything other than baked has to change this line, which is
    where somebody notices they have made a served endpoint reconfigurable from
    whatever shell it happens to inherit.
    """

    adjustable = {key for key, tier in MUTABILITY.items() if tier != BAKED_AT_LOG_TIME}

    assert adjustable == set()
    assert all(MUTABILITY[key] == BAKED_AT_LOG_TIME for key in REQUIRED_KEYS)


# ---------------------------------------------------------------------------
# Whether this deployment's data is synthetic
#
# The one setting whose SAFE value is the absence of a claim. It gates a sentence
# that used to be appended to every answer unconditionally: true of our demo, and
# on a customer estate an assertion that their own production figures were
# fabricated. So the default is false, and false has to survive every route a
# value can take to reach the agent, the empty one included.
# ---------------------------------------------------------------------------


def test_a_deployment_that_declares_nothing_makes_no_claim_about_its_data():
    """No flag, no claim. Not "assume it is a demo", which is where this started."""

    assert Settings.from_env(env=CUSTOMER, baked={}).synthetic_data is False
    # Not even via a named profile: asking for a known environment by name
    # supplies its ids, and the nature of its data is a separate declaration.
    assert Settings.from_env(env={PROFILE_VAR: "<your profile>"}, baked={}).synthetic_data is False


def test_a_version_logged_before_the_flag_existed_lands_on_the_same_silence():
    """An artifact carrying no such key is the ordinary case for a live endpoint.

    It has to resolve to silence rather than failing the model load, and to
    silence rather than to a disclosure, for the same reason a fresh deployment
    does.
    """

    logged = Settings.from_env(env=CUSTOMER, baked={}).as_model_config()
    del logged["synthetic_data"]

    assert Settings.from_env(env={}, baked=logged).synthetic_data is False


def test_a_declared_false_is_a_real_answer_and_arrives_as_one():
    """Distinct from unset in the bundle, even though both resolve the same way.

    The customer target states it rather than leaving it out, so that reading the
    target answers the question. Nothing downstream may collapse that into the
    absent case and then treat absence as unconfigured.
    """

    logged = Settings.from_env(
        env={**CUSTOMER, "PLAYER_INSIGHTS_SYNTHETIC_DATA": "false"}, baked={}
    ).as_model_config()

    assert logged["synthetic_data"] is False
    assert Settings.from_env(env={}, baked=logged).synthetic_data is False


def test_our_demos_declaration_survives_the_yaml_round_trip_into_serving(tmp_path):
    """The artifact is the only route into the container, so it is the route tested."""

    logged = Settings.from_env(
        env={**CUSTOMER, "PLAYER_INSIGHTS_SYNTHETIC_DATA": "true"}, baked={}
    ).as_model_config()
    assert logged["synthetic_data"] is True

    config_file = tmp_path / "model_config.yaml"
    config_file.write_text(yaml.safe_dump(logged))
    _set_model_config(str(config_file))
    try:
        served = Settings.from_env(env={})
    finally:
        _set_model_config(None)

    assert served.synthetic_data is True
    assert entry(served, "synthetic_data")["source"] == FROM_ARTIFACT
    assert entry(served, "synthetic_data")["baked"] is True


def test_a_value_nobody_recognises_fails_the_load_rather_than_picking_a_side():
    """Failing closed would be wrong here, and so would failing open.

    A typo resolving quietly to false deletes a disclosure our demo owes its
    audience, and the deletion looks exactly like a correct customer deployment.
    Resolving quietly to true is the original defect. So it raises, and the
    message names the values that work.
    """

    with pytest.raises(MissingConfiguration) as raised:
        Settings.from_env(env={**CUSTOMER, "PLAYER_INSIGHTS_SYNTHETIC_DATA": "yes"}, baked={})

    message = str(raised.value)
    assert "PLAYER_INSIGHTS_SYNTHETIC_DATA" in message
    assert "'true'" in message and "'false'" in message
