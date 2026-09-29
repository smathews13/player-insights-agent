"""Register a logged model as a Unity Catalog version without creating a new model.

`mlflow.pyfunc.log_model(registered_model_name=...)` always calls
`create_registered_model` first. On a metastore already at the 5,000-model cap
that call is QUOTA_EXCEEDED even when the named model already exists and we
only needed a new version. Check first; create the registered model only when
it is missing.
"""

from __future__ import annotations

from typing import Any

from mlflow.exceptions import MlflowException
from mlflow.protos.databricks_pb2 import RESOURCE_DOES_NOT_EXIST, ErrorCode


def register_logged_model_as_version(
    client: Any,
    *,
    name: str,
    model_info: Any,
) -> str:
    try:
        client.get_registered_model(name)
    except MlflowException as exc:
        if exc.error_code != ErrorCode.Name(RESOURCE_DOES_NOT_EXIST):
            raise
        client.create_registered_model(name)

    model_id = getattr(model_info, "model_id", None)
    if not model_id:
        raise RuntimeError(
            f"log_model returned no model_id for {name}; refusing to guess a source URI"
        )
    created = client.create_model_version(
        name=name,
        source=f"models:/{model_id}",
        run_id=getattr(model_info, "run_id", None),
        model_id=model_id,
    )
    version = getattr(created, "version", None)
    if version is None:
        raise RuntimeError(f"create_model_version did not return a version for {name}")
    return str(version)
