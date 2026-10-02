from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("tag_resources", ROOT / "bundle" / "tag-resources.py")
assert SPEC and SPEC.loader
tag_resources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tag_resources)


class Wait:
    def __init__(self) -> None:
        self.finished = False

    def result(self) -> None:
        self.finished = True

    def wait(self) -> None:
        self.finished = True


class API:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        self.wait = Wait()

    def get_project(self, name: str) -> Any:
        return SimpleNamespace(
            spec=SimpleNamespace(
                custom_tags=[tag_resources.ProjectCustomTag(key="owner", value="team")]
            )
        )

    def update_project(self, *args: Any) -> Wait:
        self.calls.append(args)
        return self.wait

    def get(self, warehouse_id: str) -> Any:
        return SimpleNamespace(
            tags=tag_resources.EndpointTags(
                custom_tags=[tag_resources.EndpointTagPair(key="owner", value="team")]
            )
        )

    def edit(self, *args: Any, **kwargs: Any) -> Wait:
        self.calls.append((*args, kwargs))
        return self.wait

    def patch(self, *args: Any, **kwargs: Any) -> None:
        self.calls.append((*args, kwargs))

    def get_endpoint(self, endpoint_name: str) -> Any:
        return SimpleNamespace(custom_tags=[tag_resources.CustomTag(key="owner", value="team")])

    def update_endpoint_custom_tags(self, *args: Any) -> None:
        self.calls.append(args)


def workspace() -> Any:
    return SimpleNamespace(
        postgres=API(),
        warehouses=API(),
        serving_endpoints=API(),
        vector_search_endpoints=API(),
    )


def pairs(tags: list[Any]) -> dict[str, str]:
    return {tag.key: tag.value for tag in tags}


def test_lakebase_tag_preserves_existing_tags() -> None:
    client = workspace()
    tag_resources.tag_lakebase(client, "project-one")
    _, project, mask = client.postgres.calls[0]
    assert mask.paths == ["spec.custom_tags"]
    assert pairs(project.spec.custom_tags) == {
        "owner": "team",
        "system_billing": "player-insights-agent",
    }
    assert client.postgres.wait.finished


def test_warehouse_tag_preserves_existing_tags_and_waits() -> None:
    client = workspace()
    tag_resources.tag_warehouse(client, "warehouse-one")
    _, kwargs = client.warehouses.calls[0]
    assert pairs(kwargs["tags"].custom_tags) == {
        "owner": "team",
        "system_billing": "player-insights-agent",
    }
    assert client.warehouses.wait.finished


def test_serving_endpoint_adds_player_insights_agent_tag() -> None:
    client = workspace()
    tag_resources.tag_serving_endpoint(client, "endpoint-one")
    _, kwargs = client.serving_endpoints.calls[0]
    assert pairs(kwargs["add_tags"]) == {"system_billing": "player-insights-agent"}
    assert kwargs["delete_tags"] == ["astrolabe"]


def test_vector_endpoint_tag_preserves_existing_tags() -> None:
    client = workspace()
    tag_resources.tag_vector_endpoint(client, "vector-one")
    _, tags = client.vector_search_endpoints.calls[0]
    assert pairs(tags) == {
        "owner": "team",
        "system_billing": "player_insights_agent",
    }


def test_vector_endpoint_tag_skips_unsupported_api(capsys: Any) -> None:
    client = workspace()

    def unsupported(*_args: Any) -> None:
        raise tag_resources.NotFound("Custom tags are not supported in AI Search")

    client.vector_search_endpoints.update_endpoint_custom_tags = unsupported
    tag_resources.tag_vector_endpoint(client, "vector-one")

    assert "does not support custom tags; skipped" in capsys.readouterr().out


def test_agent_release_tags_model_and_endpoint() -> None:
    deploy = (ROOT / "agent" / "deploy_agent.py").read_text()
    log = (ROOT / "agent" / "log_model.py").read_text()
    release = (ROOT / "bundle" / "agent-release.sh").read_text()
    assert '"system_billing": "player-insights-agent"' in deploy
    assert '"system_billing", "player-insights-agent"' in log
    assert '--registered-model "$MODEL_NAME"' in release
    assert '--serving-endpoint "$ENDPOINT"' in release
    assert 'default=os.getenv("PLAYER_INSIGHTS_ENDPOINT", "player-insights-agent")' not in deploy
    assert "--endpoint-name or PLAYER_INSIGHTS_ENDPOINT is required" in deploy
    assert "splitlines()[-1]" not in release
    assert "read-log-summary.py" in release
    assert "LOG_STATUS" in release
    log = (ROOT / "agent" / "log_model.py").read_text()
    assert log.index('"model_version": version') < log.index("set_registered_model_alias")


def test_serving_scale_to_zero_is_wired_end_to_end() -> None:
    """The bundle variable reaches agents.deploy(), or the endpoint never scales.

    The endpoint is always-on unless deploy_agent passes scale_to_zero, and
    deploy_agent only learns the choice from the variable the release exports.
    A break anywhere on that path (variable, export, deploy kwarg) silently
    reverts to always-on and the standing bill this reduces comes back with no
    error to say so, so each link is asserted rather than the ends alone.
    """

    deploy = (ROOT / "agent" / "deploy_agent.py").read_text()
    release = (ROOT / "bundle" / "agent-release.sh").read_text()
    bundle_text = (ROOT / "databricks.yml").read_text()
    bundle = yaml.safe_load(bundle_text)

    # The variable exists with a demo-safe default, and production opts back out.
    assert bundle["variables"]["serving_scale_to_zero"]["default"] == "true"
    assert bundle["targets"]["dev"]["variables"]["serving_scale_to_zero"] == "true"
    assert bundle["targets"]["prod"]["variables"]["serving_scale_to_zero"] == "false"

    # The release reads the variable and exports it for the deploy step.
    assert 'SCALE_TO_ZERO="$(bundle_var serving_scale_to_zero)"' in release
    assert 'export PLAYER_INSIGHTS_SCALE_TO_ZERO="$SCALE_TO_ZERO"' in release

    # deploy_agent reads that export and passes it to agents.deploy().
    assert 'os.getenv("PLAYER_INSIGHTS_SCALE_TO_ZERO"' in deploy
    assert "scale_to_zero=scale_to_zero" in deploy


def test_dev_and_prod_use_distinct_apps_endpoints_and_state_schemas() -> None:
    bundle = yaml.safe_load((ROOT / "databricks.yml").read_text())
    targets = bundle["targets"]

    assert targets["dev"]["variables"]["app_name"] == "player-insights-agent-dev"
    assert targets["prod"]["variables"]["app_name"] == "player-insights-agent-prod"
    assert targets["dev"]["variables"]["serving_endpoint_name"] == "player-insights-agent-dev"
    assert targets["prod"]["variables"]["serving_endpoint_name"] == "player-insights-agent-prod"
    assert targets["dev"]["variables"]["lakebase_app_schema"] == "pia_dev"
    assert targets["prod"]["variables"]["lakebase_app_schema"] == "pia_prod"
    assert targets["dev"]["variables"]["lakebase_database_id"] == "pia-dev"
    assert targets["prod"]["variables"]["lakebase_database_id"] == "pia-prod"

    # Dev owns the shared UC containers. Prod points at the same registered
    # model/schema but cannot become a second independent owner of those objects.
    assert "app_schema_resources" not in targets["dev"]["variables"]
    assert "app_experiment_resources" not in targets["dev"]["variables"]
    assert set(targets["prod"]["variables"]["app_schema_resources"]) == {
        "player_insights_telemetry_schema"
    }
    assert "player_insights_schema" not in targets["prod"]["variables"]["app_schema_resources"]
    assert targets["prod"]["variables"]["app_volume_resources"] == {}
    assert targets["prod"]["variables"]["app_experiment_resources"] == {}


def test_volume_waits_for_its_declared_schema() -> None:
    volume_resource = yaml.safe_load(
        (ROOT / "resources" / "player_insights_assets.volume.yml").read_text()
    )
    volume = volume_resource["variables"]["app_volume_resources"]["default"][
        "player_insights_volume"
    ]
    assert volume["schema_name"] == "${resources.schemas.player_insights_schema.name}"


def _load_deploy_agent() -> Any:
    spec = importlib.util.spec_from_file_location(
        "deploy_agent", ROOT / "agent" / "deploy_agent.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_scale_to_zero_only_true_for_an_explicit_affirmative() -> None:
    """Turning scale-to-zero ON is explicit; a blank or typo stays always-on.

    The parser guards a production endpoint's always-on guarantee: only a
    recognised true-ish token enables scale-to-zero, so an unexported (empty)
    or misspelled value can never flip a production endpoint to scale-to-zero
    by accident.
    """

    deploy_agent = _load_deploy_agent()
    for affirmative in ("true", "True", "TRUE", " yes ", "1", "on"):
        assert deploy_agent._scale_to_zero(affirmative) is True
    for keep_on in ("", "false", "False", "no", "0", "off", "ture", "maybe"):
        assert deploy_agent._scale_to_zero(keep_on) is False


def test_existing_served_version_environment_is_repaired_in_place(monkeypatch) -> None:
    deploy_agent = _load_deploy_agent()
    entity = SimpleNamespace(
        name="catalog_schema_model_12",
        entity_name="catalog.schema.model",
        entity_version="12",
        environment_vars={"MLFLOW_EXPERIMENT_ID": "old"},
        scale_to_zero_enabled=True,
    )
    config = SimpleNamespace(
        served_entities=[entity],
        traffic_config=SimpleNamespace(routes=[]),
        auto_capture_config=None,
    )
    updates: list[dict[str, Any]] = []
    serving = SimpleNamespace(
        get=lambda _name: SimpleNamespace(config=config),
        update_config=lambda **kwargs: updates.append(kwargs),
    )
    monkeypatch.setattr(
        deploy_agent,
        "WorkspaceClient",
        lambda: SimpleNamespace(serving_endpoints=serving),
    )

    assert deploy_agent._refresh_existing_version(
        "pia-prod", "catalog.schema.model", "12", "new", False
    )
    assert entity.environment_vars["MLFLOW_EXPERIMENT_ID"] == "new"
    assert entity.scale_to_zero_enabled is False
    assert len(updates) == 1
    assert updates[0]["name"] == "pia-prod"
    assert updates[0]["served_entities"] == [entity]
    assert updates[0]["auto_capture_config"] is None
    routes = updates[0]["traffic_config"].routes
    assert len(routes) == 1
    assert routes[0].served_entity_name == entity.name
    assert routes[0].traffic_percentage == 100


def test_existing_version_repair_matches_model_and_version(monkeypatch) -> None:
    deploy_agent = _load_deploy_agent()
    wrong_model = SimpleNamespace(
        name="other_model_12",
        entity_name="catalog.schema.other",
        entity_version="12",
        environment_vars={"MLFLOW_EXPERIMENT_ID": "old"},
        scale_to_zero_enabled=True,
    )
    config = SimpleNamespace(
        served_entities=[wrong_model],
        traffic_config=SimpleNamespace(routes=[]),
        auto_capture_config=None,
    )
    updates: list[dict[str, Any]] = []
    serving = SimpleNamespace(
        get=lambda _name: SimpleNamespace(config=config),
        update_config=lambda **kwargs: updates.append(kwargs),
    )
    monkeypatch.setattr(
        deploy_agent,
        "WorkspaceClient",
        lambda: SimpleNamespace(serving_endpoints=serving),
    )

    assert not deploy_agent._refresh_existing_version(
        "pia-prod", "catalog.schema.model", "12", "new", False
    )
    assert updates == []


def test_deploy_summary_names_the_requested_endpoint(monkeypatch, capsys) -> None:
    deploy_agent = _load_deploy_agent()
    monkeypatch.setenv("DATABRICKS_HOST", "https://example.cloud.databricks.com")
    args = SimpleNamespace(
        endpoint_name="player-insights-agent-prod",
        model_name="catalog.schema.model",
        model_version="12",
    )

    deploy_agent._print_summary(args, False, repaired=False)
    output = capsys.readouterr().out
    assert '"endpoint_name": "player-insights-agent-prod"' in output
    assert "/ml/endpoints/player-insights-agent-prod/" in output


def test_endpoint_deploy_refuses_to_create_a_replacement_experiment() -> None:
    source = (ROOT / "agent" / "deploy_agent.py").read_text()
    assert "mlflow.get_experiment_by_name(experiment_path)" in source
    assert "endpoint deployment must not create a replacement experiment" in source
    assert "mlflow.set_experiment(experiment_id=experiment.experiment_id)" in source
