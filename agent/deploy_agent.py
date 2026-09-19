from __future__ import annotations

import argparse
import json
import os

import mlflow
from databricks import agents


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
    mlflow.set_experiment(os.getenv("PLAYER_INSIGHTS_EXPERIMENT", "/Shared/player-insights-agent"))
    scale_to_zero = _scale_to_zero(args.scale_to_zero)
    deployment = agents.deploy(
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
    print(
        json.dumps(
            {
                "endpoint_name": deployment.endpoint_name,
                "query_endpoint": deployment.query_endpoint,
                "model_name": args.model_name,
                "model_version": str(args.model_version),
                "scale_to_zero": scale_to_zero,
            }
        )
    )


if __name__ == "__main__":
    main()
