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


if __name__ == "__main__":
    unittest.main()
