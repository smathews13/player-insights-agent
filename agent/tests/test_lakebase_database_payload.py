from databricks.sdk.service.postgres import DatabaseDatabaseSpec


def test_database_create_payload_matches_installed_api_model():
    spec = DatabaseDatabaseSpec(
        postgres_database="pia_dev",
        role="projects/project/branches/production/roles/owner",
    )

    assert spec.as_dict() == {
        "postgres_database": "pia_dev",
        "role": "projects/project/branches/production/roles/owner",
    }
