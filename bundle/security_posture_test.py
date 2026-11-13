#!/usr/bin/env python3
"""Offline cases for bundle/security_posture.py, against a fake workspace."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import security_posture as posture  # noqa: E402

ENGINEER, ADMIN, MANAGER = "Example_PIA_Engineer", "Example_PIA_Admin", "Example_PIA_Platform"
APP_SP = "00000000-0000-0000-0000-00000000a99a"


def grant(kind: str, name: str, level: str, inherited: bool = False) -> dict:
    return {kind: name, "all_permissions": [{"permission_level": level, "inherited": inherited}]}


def group(name: str, level: str, inherited: bool = False) -> dict:
    return grant("group_name", name, level, inherited)


CONFIG = {
    "app": "pia",
    "endpoint": "pia-endpoint",
    "warehouse_id": "wh1",
    "experiment_path": "/Shared/pia",
    "genie_spaces": ["space1"],
    "groups": [ENGINEER, ADMIN],
    "manager_group": MANAGER,
    "super_admin_group": "Example_PIA_Super",
}


def hardened() -> dict:
    return {
        "/api/2.0/apps/pia": {"service_principal_client_id": APP_SP},
        "/api/2.0/permissions/apps/pia": {
            "access_control_list": [
                group(ENGINEER, "CAN_USE"),
                group(ADMIN, "CAN_USE"),
                group(MANAGER, "CAN_MANAGE"),
                group("admins", "CAN_MANAGE", inherited=True),
                grant("service_principal_name", APP_SP, "CAN_MANAGE"),
            ]
        },
        "/api/2.0/serving-endpoints/pia-endpoint": {
            "id": "ep1",
            "ai_gateway": {
                "inference_table_config": {"enabled": False},
                "usage_tracking_config": {"enabled": True},
                "rate_limits": [
                    {"calls": 60, "key": "user", "renewal_period": "minute"},
                    {"calls": 2000, "key": "endpoint", "renewal_period": "minute"},
                ],
            },
        },
        "/api/2.0/permissions/serving-endpoints/ep1": {
            "access_control_list": [group(ENGINEER, "CAN_QUERY"), group(ADMIN, "CAN_QUERY")]
        },
        "/api/2.0/permissions/warehouses/wh1": {
            "access_control_list": [group(ENGINEER, "CAN_USE"), group(ADMIN, "CAN_USE")]
        },
        "/api/2.0/permissions/genie/space1": {
            "access_control_list": [
                group(ENGINEER, "CAN_RUN"),
                group(ADMIN, "CAN_RUN"),
                group(MANAGER, "CAN_MANAGE"),
            ]
        },
        "/api/2.0/mlflow/experiments/get-by-name?experiment_name=%2FShared%2Fpia": {
            "experiment": {"experiment_id": "7"}
        },
        "/api/2.0/permissions/experiments/7": {
            "access_control_list": [group(MANAGER, "CAN_MANAGE")]
        },
    }


def super_members(responses: dict, count: int) -> None:
    key = (
        "/api/2.0/preview/scim/v2/Groups?filter=displayName+eq+%22Example_PIA_Super%22"
        "&attributes=displayName%2Cmembers"
    )
    responses[key] = {
        "Resources": [
            {
                "displayName": "Example_PIA_Super",
                "members": [{"value": str(i)} for i in range(count)],
            }
        ]
    }


def groups_api(responses: dict, kinds: dict[str, str]) -> None:
    for name, kind in kinds.items():
        key = (
            "/api/2.0/preview/scim/v2/Groups?filter=displayName+eq+%22"
            + name
            + "%22&attributes=displayName%2Cmeta"
        )
        responses[key] = {"Resources": [{"displayName": name, "meta": {"resourceType": kind}}]}


class FakeWorkspace:
    def __init__(self, responses: dict):
        self.responses = responses

    def __call__(self, path: str):
        if path not in self.responses:
            raise posture.Unreadable(f"no fixture for {path}")
        return self.responses[path]


def failures(report) -> list[str]:
    return [message for status, _, message in report.results if status != "PASS"]


class PostureTest(unittest.TestCase):
    def setUp(self):
        self.responses = hardened()
        groups_api(
            self.responses,
            {ENGINEER: "Group", ADMIN: "Group", MANAGER: "Group", "Example_PIA_Super": "Group"},
        )
        super_members(self.responses, 2)

    def run_posture(self):
        return posture.run(CONFIG, FakeWorkspace(self.responses))

    def test_hardened_deployment_passes(self):
        report = self.run_posture()
        self.assertEqual(failures(report), [])
        self.assertEqual(report.exit_code, 0)

    def test_workspace_local_group_fails(self):
        groups_api(self.responses, {ADMIN: "WorkspaceGroup"})
        self.assertIn(
            f"{ADMIN} is a workspace-local group; use the account-level group from Entra.",
            failures(self.run_posture()),
        )

    def test_account_users_on_the_app_fails(self):
        self.responses["/api/2.0/permissions/apps/pia"]["access_control_list"].append(
            group("account users", "CAN_USE")
        )
        self.assertTrue(
            any(
                "Everyone in the workspace can reach app pia" in f
                for f in failures(self.run_posture())
            )
        )

    def test_individual_grant_on_the_app_fails(self):
        self.responses["/api/2.0/permissions/apps/pia"]["access_control_list"].append(
            grant("user_name", "person@example.com", "CAN_MANAGE")
        )
        self.assertIn(
            "app pia grants CAN_MANAGE directly to person@example.com; grant groups only.",
            failures(self.run_posture()),
        )

    def test_access_group_with_manage_fails(self):
        self.responses["/api/2.0/permissions/apps/pia"]["access_control_list"][0] = group(
            ENGINEER, "CAN_MANAGE"
        )
        self.assertIn(
            f"app pia grants CAN_MANAGE directly to {ENGINEER}; grant groups only.",
            failures(self.run_posture()),
        )

    def test_missing_gate_three_grant_fails(self):
        self.responses["/api/2.0/permissions/genie/space1"]["access_control_list"].pop(0)
        self.assertIn(
            f"{ENGINEER} does not hold CAN_RUN on Genie space space1.", failures(self.run_posture())
        )

    def test_somebody_else_editing_genie_fails(self):
        self.responses["/api/2.0/permissions/genie/space1"]["access_control_list"].append(
            grant("user_name", "person@example.com", "CAN_EDIT")
        )
        self.assertIn(
            "person@example.com can change Genie space space1; only the manager group should.",
            failures(self.run_posture()),
        )

    def test_an_endpoint_without_a_per_user_limit_fails(self):
        gateway = self.responses["/api/2.0/serving-endpoints/pia-endpoint"]["ai_gateway"]
        gateway["rate_limits"] = [{"calls": 2000, "key": "endpoint", "renewal_period": "minute"}]
        self.assertTrue(
            any("has no per-user rate limit" in f for f in failures(self.run_posture()))
        )

    def test_an_endpoint_without_usage_tracking_fails(self):
        gateway = self.responses["/api/2.0/serving-endpoints/pia-endpoint"]["ai_gateway"]
        gateway["usage_tracking_config"] = {"enabled": False}
        self.assertTrue(any("does not track usage" in f for f in failures(self.run_posture())))

    def test_an_endpoint_request_log_fails_wherever_it_is(self):
        self.responses["/api/2.0/serving-endpoints/pia-endpoint"]["ai_gateway"][
            "inference_table_config"
        ] = {"enabled": True, "catalog_name": "main", "schema_name": "ops"}
        self.assertTrue(any("Lakebase only" in f for f in failures(self.run_posture())))

    def test_inherited_broad_experiment_grant_fails(self):
        self.responses["/api/2.0/permissions/experiments/7"]["access_control_list"].append(
            group("users", "CAN_MANAGE", inherited=True)
        )
        self.assertIn(
            "Everyone in the workspace can reach traces in /Shared/pia: users (CAN_MANAGE).",
            failures(self.run_posture()),
        )

    def test_unreadable_acl_is_an_error_not_a_pass(self):
        del self.responses["/api/2.0/permissions/warehouses/wh1"]
        report = self.run_posture()
        self.assertEqual(report.exit_code, 2)
        self.assertTrue(
            any(status == "ERROR" and area == "warehouse" for status, area, _ in report.results)
        )

    def test_one_super_admin_fails(self):
        super_members(self.responses, 1)
        self.assertIn(
            "Example_PIA_Super has 1 direct member; a Super admin group needs at least two.",
            failures(self.run_posture()),
        )

    def test_no_groups_configured_fails(self):
        report = posture.run(
            {**CONFIG, "groups": [], "manager_group": ""}, FakeWorkspace(self.responses)
        )
        self.assertIn(
            "No PIA groups are configured, so access is not granted by group.", failures(report)
        )


if __name__ == "__main__":
    unittest.main()
