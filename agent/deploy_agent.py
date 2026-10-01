from __future__ import annotations

import argparse
import contextlib
import io
import json
import os

import mlflow
from databricks import agents
from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import ResourceDoesNotExist


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    # No default model name. A defaulted one is a three-level Unity Catalog name
    # pointing at a specific account, so a customer running this without it set
    # would deploy our demo's model to their endpoint.
    parser.add_argument("--model-name", default=os.getenv("PLAYER_INSIGHTS_MODEL_NAME"))
    parser.add_argument("--model-version", default=os.getenv("PLAYER_INSIGHTS_MODEL_VERSION"))
    parser.add_argument(
        "--endpoint-name",
        default=os.getenv("PLAYER_INSIGHTS_ENDPOINT"),
    )
    parser.add_argument(
        "--environment",
        default=os.getenv("PLAYER_INSIGHTS_TARGET"),
        help="Bundle target this deploy belongs to; tags the endpoint.",
    )
    # Whether the serving endpoint is allowed to scale to zero when idle.
    # `agents.deploy()` defaults this to False (always-on), which bills a Small
    # CPU endpoint around the clock whether or not a question is asked. The
    # bundle sets `serving_scale_to_zero` per target (see databricks.yml): "true"
    # for demo/eval targets that sit idle, "false" for a production target that
    # must answer the first request without a cold start. Read as a string so an
    # unset or malformed value cannot silently flip an always-on production
    # endpoint to scale-to-zero: only an explicit true-ish value turns it on.
    parser.add_argument(
        "--scale-to-zero",
        default=os.getenv("PLAYER_INSIGHTS_SCALE_TO_ZERO", ""),
        help='Serving endpoint scale-to-zero: "true" to enable, anything else keeps it always-on.',
    )
    return parser.parse_args()


def _scale_to_zero(value: str) -> bool:
    """True only for an explicit affirmative; every other value stays always-on.

    Anything but a recognised true-ish token -- including the empty string an
    unexported variable resolves to -- returns False, so a missing or mistyped
    setting can never turn a production endpoint's always-on guarantee off by
    accident. Turning scale-to-zero ON has to be said out loud.
    """

    return str(value).strip().lower() in {"true", "1", "yes", "on"}


def _refresh_existing_version(
    endpoint_name: str,
    model_version: str,
    experiment_id: str,
    scale_to_zero: bool,
) -> bool:
    """Repair one already-served version without adding a colliding entity."""
    workspace = WorkspaceClient()
    try:
        endpoint = workspace.serving_endpoints.get(endpoint_name)
    except ResourceDoesNotExist:
        return False
    config = endpoint.config
    if config is None:
        return False
    entities = list(config.served_entities or [])
    matching = [
        entity
        for entity in entities
        if str(getattr(entity, "entity_version", "") or "") == str(model_version)
    ]
    if not matching:
        return False
    for entity in matching:
        environment = dict(getattr(entity, "environment_vars", None) or {})
        environment["MLFLOW_EXPERIMENT_ID"] = experiment_id
        entity.environment_vars = environment
        if hasattr(entity, "scale_to_zero_enabled"):
            entity.scale_to_zero_enabled = scale_to_zero
    workspace.serving_endpoints.update_config(
        name=endpoint_name,
        served_entities=entities,
        traffic_config=config.traffic_config,
        auto_capture_config=getattr(config, "auto_capture_config", None),
    )
    return True


def _print_summary(args: argparse.Namespace, scale_to_zero: bool, repaired: bool) -> None:
    host = (os.getenv("DATABRICKS_HOST") or "").rstrip("/")
    status_url = f"{host}/ml/endpoints/{args.endpoint_name}/" if host else ""
    print(
        json.dumps(
            {
                "endpoint_name": args.endpoint_name,
                "query_endpoint": f"{host}/serving-endpoints/{args.endpoint_name}/invocations"
                if host
                else "",
                "status_url": status_url,
                "model_name": args.model_name,
                "model_version": str(args.model_version),
                "scale_to_zero": scale_to_zero,
                "repaired_existing_version": repaired,
            }
        )
    )
    if status_url:
        print(f"View status: {status_url}")


def main() -> None:
    args = parse_args()
    if not args.model_name:
        raise ValueError("--model-name or PLAYER_INSIGHTS_MODEL_NAME is required")
    if not args.model_version:
        raise ValueError("--model-version or PLAYER_INSIGHTS_MODEL_VERSION is required")
    if not args.endpoint_name:
        raise ValueError("--endpoint-name or PLAYER_INSIGHTS_ENDPOINT is required")
    mlflow.set_tracking_uri("databricks")
    mlflow.set_registry_uri("databricks-uc")
    experiment_path = os.getenv("PLAYER_INSIGHTS_EXPERIMENT", "/Shared/player-insights-agent")
    experiment = mlflow.get_experiment_by_name(experiment_path)
    if experiment is None:
        raise ValueError(
            f"Existing MLflow experiment {experiment_path!r} was not found; "
            "endpoint deployment must not create a replacement experiment."
        )
    mlflow.set_experiment(experiment_id=experiment.experiment_id)
    scale_to_zero = _scale_to_zero(args.scale_to_zero)
    experiment_id = str(experiment.experiment_id)
    if _refresh_existing_version(
        args.endpoint_name, str(args.model_version), experiment_id, scale_to_zero
    ):
        _print_summary(args, scale_to_zero, repaired=True)
        return
    # MLflow 3.14 can return metadata for the first endpoint already serving a
    # model version even when this call created a different endpoint. Suppress
    # those misleading links and print the requested endpoint below.
    with contextlib.redirect_stdout(io.StringIO()):
        agents.deploy(
            model_name=args.model_name,
            model_version=str(args.model_version),
            endpoint_name=args.endpoint_name,
            scale_to_zero=scale_to_zero,
            tags={
                "system_billing": "player-insights-agent",
                "project": "player-insights-agent",
                "environment": args.environment or "unspecified",
            },
        )
    _print_summary(args, scale_to_zero, repaired=False)


if __name__ == "__main__":
    main()
