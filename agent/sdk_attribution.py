"""Databricks SDK attribution shared by every agent-side client and SQL path."""

from __future__ import annotations

from typing import TYPE_CHECKING

import correlation

if TYPE_CHECKING:
    from databricks.sdk.service.sql import QueryTag

PRODUCT_NAME = "Astrolabe"
PRODUCT_VERSION = "0.1.0"
QUERY_TAG_LIMIT = 128


def register_sdk_product() -> None:
    """Identify this product before any ``WorkspaceClient`` is constructed."""

    from databricks.sdk import useragent

    useragent.with_product(PRODUCT_NAME, PRODUCT_VERSION)


def query_tags(surface: str, tool: str) -> list[QueryTag]:
    """Safe statement-level attribution, with scoped request ids when present."""

    from databricks.sdk.service.sql import QueryTag

    values = {
        "application": PRODUCT_NAME,
        "surface": surface,
        "tool": tool,
        **correlation.current_query_ids(),
    }
    return [
        QueryTag(key=key, value=value[:QUERY_TAG_LIMIT]) for key, value in values.items() if value
    ]
