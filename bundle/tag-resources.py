#!/usr/bin/env python3
"""Apply the deployment's stable billing/discovery tag without erasing others."""

from __future__ import annotations

import argparse
from collections.abc import Iterable
from typing import Any

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.postgres import FieldMask, Project, ProjectCustomTag, ProjectSpec
from databricks.sdk.service.serving import EndpointTag
from databricks.sdk.service.sql import EndpointTagPair, EndpointTags
from databricks.sdk.service.vectorsearch import CustomTag
from mlflow.tracking import MlflowClient

TAG_KEY = "astrolabe"
TAG_VALUE = "true"


def _merge(tags: Iterable[Any] | None, factory: Any) -> list[Any]:
    values = {
        str(tag.key): str(tag.value or "")
        for tag in (tags or [])
        if getattr(tag, "key", None)
    }
    values[TAG_KEY] = TAG_VALUE
    return [factory(key=key, value=value) for key, value in sorted(values.items())]


def tag_lakebase(workspace: WorkspaceClient, project_name: str) -> None:
    name = project_name if project_name.startswith("projects/") else f"projects/{project_name}"
    project = workspace.postgres.get_project(name)
    current = project.spec.custom_tags if project.spec else []
    tags = _merge(current, ProjectCustomTag)
    workspace.postgres.update_project(
        name,
        Project(name=name, spec=ProjectSpec(custom_tags=tags)),
        FieldMask(["spec.custom_tags"]),
    ).wait()
    print(f"tagged Lakebase project {name}")


def tag_warehouse(workspace: WorkspaceClient, warehouse_id: str) -> None:
    warehouse = workspace.warehouses.get(warehouse_id)
    current = warehouse.tags.custom_tags if warehouse.tags else []
    tags = EndpointTags(custom_tags=_merge(current, EndpointTagPair))
    workspace.warehouses.edit(warehouse_id, tags=tags).result()
    print(f"tagged SQL warehouse {warehouse_id}")


def tag_serving_endpoint(workspace: WorkspaceClient, endpoint_name: str) -> None:
    workspace.serving_endpoints.patch(
        endpoint_name,
        add_tags=[EndpointTag(key=TAG_KEY, value=TAG_VALUE)],
    )
    print(f"tagged serving endpoint {endpoint_name}")


def tag_vector_endpoint(workspace: WorkspaceClient, endpoint_name: str) -> None:
    endpoint = workspace.vector_search_endpoints.get_endpoint(endpoint_name)
    tags = _merge(endpoint.custom_tags, CustomTag)
    workspace.vector_search_endpoints.update_endpoint_custom_tags(endpoint_name, tags)
    print(f"tagged AI Search endpoint {endpoint_name}")


def tag_registered_model(model_name: str) -> None:
    MlflowClient(registry_uri="databricks-uc").set_registered_model_tag(
        model_name, TAG_KEY, TAG_VALUE
    )
    print(f"tagged registered model {model_name}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lakebase-project")
    parser.add_argument("--warehouse-id")
    parser.add_argument("--serving-endpoint")
    parser.add_argument("--vector-endpoint")
    parser.add_argument("--registered-model")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workspace = WorkspaceClient()
    if args.lakebase_project:
        tag_lakebase(workspace, args.lakebase_project)
    if args.warehouse_id:
        tag_warehouse(workspace, args.warehouse_id)
    if args.serving_endpoint:
        tag_serving_endpoint(workspace, args.serving_endpoint)
    if args.vector_endpoint:
        tag_vector_endpoint(workspace, args.vector_endpoint)
    if args.registered_model:
        tag_registered_model(args.registered_model)


if __name__ == "__main__":
    main()
