#!/usr/bin/env python3
"""Offline cases for bundle/ai_gateway_policy.py."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import ai_gateway_policy as policy  # noqa: E402

LIVE = {
    "inference_table_config": {
        "enabled": True,
        "catalog_name": "example_catalog",
        "schema_name": "demo",
        "table_name_prefix": "existing",
    },
    "guardrails": {"input": {"safety": True}},
    "rate_limits": [{"calls": 5, "key": "service_principal", "renewal_period": "minute"}],
}


class PolicyTest(unittest.TestCase):
    def test_sets_usage_tracking_and_both_limits(self):
        target = policy.desired({}, 60, 2000)
        self.assertEqual(target["usage_tracking_config"], {"enabled": True})
        self.assertEqual(
            target["rate_limits"],
            [
                {"calls": 60, "key": "user", "renewal_period": "minute"},
                {"calls": 2000, "key": "endpoint", "renewal_period": "minute"},
            ],
        )

    def test_turns_the_request_log_off(self):
        self.assertEqual(
            policy.desired(LIVE, 60, 2000)["inference_table_config"], {"enabled": False}
        )
        self.assertEqual(policy.desired({}, 60, 2000)["inference_table_config"], {"enabled": False})

    def test_keeps_every_field_it_does_not_own(self):
        target = policy.desired(LIVE, 60, 2000)
        self.assertEqual(target["guardrails"], LIVE["guardrails"])
        self.assertIn(
            {"calls": 5, "key": "service_principal", "renewal_period": "minute"},
            target["rate_limits"],
        )
        self.assertTrue(LIVE["inference_table_config"]["enabled"], "the input is not mutated")

    def test_replaces_rather_than_duplicates_an_existing_user_limit(self):
        current = {"rate_limits": [{"calls": 10, "key": "user", "renewal_period": "minute"}]}
        limits = policy.desired(current, 60, 2000)["rate_limits"]
        self.assertEqual([limit["key"] for limit in limits], ["user", "endpoint"])

    def test_refuses_a_non_positive_limit(self):
        for user, endpoint in ((0, 2000), (60, -1)):
            with self.assertRaises(ValueError):
                policy.desired({}, user, endpoint)

    def test_an_applied_policy_compares_equal_to_its_target(self):
        target = policy.desired(LIVE, 60, 2000)
        self.assertEqual(
            policy.comparable(target), policy.comparable(policy.desired(target, 60, 2000))
        )
        self.assertNotEqual(policy.comparable(LIVE), policy.comparable(target))
        self.assertFalse(policy.comparable(target)["request_log"])


UNSUPPORTED = "is not currently supported for this endpoint type in this workspace."


class UnsupportedFeatureTest(unittest.TestCase):
    """A workspace that refuses usage tracking and rate limits on a custom-model endpoint."""

    REFUSALS = {
        "usage_tracking_config": f"Error: Usage tracking {UNSUPPORTED}",
        "rate_limits": f"Error: Rate limits {UNSUPPORTED}",
    }

    def run_against(self, current: dict, refuse: set[str]):
        state = {"ai_gateway": current}
        puts: list[dict] = []

        def fake_cli(_profile, method, _path, body=None):
            if method == "get":
                return {"ai_gateway": state["ai_gateway"]}
            puts.append(body)
            for key in refuse:
                wanted = body.get(key)
                if wanted and wanted != current.get(key) and wanted != {"enabled": False}:
                    raise RuntimeError(self.REFUSALS[key])
            state["ai_gateway"] = body
            return body

        original = policy.cli
        policy.cli = fake_cli
        try:
            code = policy.main(["--endpoint", "agent", "--apply"])
        finally:
            policy.cli = original
        return code, state["ai_gateway"], puts

    def test_names_only_a_refusal_it_can_step_around(self):
        self.assertEqual(policy.refused_feature(self.REFUSALS["rate_limits"]), "rate limits")
        self.assertEqual(
            policy.refused_feature(self.REFUSALS["usage_tracking_config"]), "usage tracking"
        )
        self.assertIsNone(policy.refused_feature("Error: PERMISSION_DENIED"))
        self.assertIsNone(policy.refused_feature("Guardrails is not currently supported"))

    def test_still_turns_the_request_log_off_when_both_are_refused(self):
        code, applied, puts = self.run_against(
            {
                "inference_table_config": {"enabled": True},
                "usage_tracking_config": {"enabled": False},
            },
            {"usage_tracking_config", "rate_limits"},
        )
        self.assertEqual(code, 0)
        self.assertEqual(len(puts), 3)
        self.assertFalse(applied["inference_table_config"]["enabled"])
        self.assertEqual(applied["usage_tracking_config"], {"enabled": False})
        self.assertNotIn("rate_limits", applied)

    def test_keeps_what_the_workspace_does_support(self):
        code, applied, _ = self.run_against(
            {"inference_table_config": {"enabled": True}}, {"usage_tracking_config"}
        )
        self.assertEqual(code, 0)
        self.assertNotIn("usage_tracking_config", applied)
        self.assertEqual([limit["key"] for limit in applied["rate_limits"]], ["user", "endpoint"])

    def test_any_other_refusal_still_fails(self):
        def refusing(_profile, method, _path, body=None):
            if method == "get":
                return {"ai_gateway": {}}
            raise RuntimeError("Error: PERMISSION_DENIED")

        original = policy.cli
        policy.cli = refusing
        try:
            self.assertEqual(policy.main(["--endpoint", "agent", "--apply"]), 2)
        finally:
            policy.cli = original


if __name__ == "__main__":
    unittest.main()
