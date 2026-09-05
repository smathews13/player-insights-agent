from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("brand_contract", HERE / "brand-contract.py")
assert SPEC and SPEC.loader
brand_contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(brand_contract)


class BrandContractTest(unittest.TestCase):
    def test_repository_source_and_generated_surfaces_are_canonical(self) -> None:
        root = HERE.parent
        self.assertEqual(brand_contract.scan(root, include_generated=True), [])

    def test_retired_brand_is_rejected_from_a_bundle_surface(self) -> None:
        root = HERE.parent
        with tempfile.TemporaryDirectory(prefix="player-insights-agent-brand-") as work:
            fixture = Path(work)
            for relative in (
                *brand_contract.SOURCE_SURFACES,
                *brand_contract.resource_surfaces(root),
                *brand_contract.GENERATED_SURFACES,
            ):
                source = root / relative
                target = fixture / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read_bytes())
            readme = fixture / "mirror/public-README.md"
            readme.write_text(
                readme.read_text(encoding="utf-8") + "\nDeploy Astrolabe.\n",
                encoding="utf-8",
            )
            findings = brand_contract.scan(fixture, include_generated=True)
            self.assertTrue(
                any("retired display or package name" in finding for finding in findings),
                findings,
            )


if __name__ == "__main__":
    unittest.main()
