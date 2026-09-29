from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import RESOURCE_DOES_NOT_EXIST

from register_uc_model_version import register_logged_model_as_version


def test_existing_model_does_not_call_create_registered_model() -> None:
    client = MagicMock()
    client.get_registered_model.return_value = object()
    client.create_model_version.return_value = SimpleNamespace(version="51")
    info = SimpleNamespace(model_id="m-abc", run_id="run-1")

    version = register_logged_model_as_version(client, name="catalog.schema.agent", model_info=info)

    assert version == "51"
    client.create_registered_model.assert_not_called()
    client.create_model_version.assert_called_once_with(
        name="catalog.schema.agent",
        source="models:/m-abc",
        run_id="run-1",
        model_id="m-abc",
    )


def test_missing_model_creates_registered_model_then_version() -> None:
    client = MagicMock()
    client.get_registered_model.side_effect = MlflowException(
        "gone", error_code=RESOURCE_DOES_NOT_EXIST
    )
    client.create_model_version.return_value = SimpleNamespace(version="1")
    info = SimpleNamespace(model_id="m-new", run_id="run-2")

    version = register_logged_model_as_version(client, name="catalog.schema.agent", model_info=info)

    assert version == "1"
    client.create_registered_model.assert_called_once_with("catalog.schema.agent")
