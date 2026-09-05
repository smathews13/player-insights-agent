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
    return parser.parse_args()


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
    deployment = agents.deploy(
        model_name=args.model_name,
        model_version=str(args.model_version),
        endpoint_name=args.endpoint_name,
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
            }
        )
    )


if __name__ == "__main__":
    main()
