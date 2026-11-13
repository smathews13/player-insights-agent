"""Tests for secret_scan. Token-shaped values are built at runtime, never written out."""

from __future__ import annotations

import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import secret_scan  # noqa: E402

PAT = "dapi" + "0123456789abcdef" * 2
OAUTH = "dose" + "fedcba9876543210" * 2
PEM = "-----BEGIN " + "PRIVATE KEY-----"
AWS = "AKIA" + "ABCDEFGHIJKLMNOP"


class ScanText(unittest.TestCase):
    def kinds(self, text: str, allowed: set[str] | None = None) -> list[str]:
        return [f.kind for f in secret_scan.scan_text("f.py", text, allowed or set())]

    def test_finds_each_credential_format(self) -> None:
        self.assertEqual(self.kinds(f"token = '{PAT}'"), ["Databricks personal access token"])
        self.assertEqual(self.kinds(OAUTH), ["Databricks OAuth secret"])
        self.assertEqual(self.kinds(PEM), ["private key"])
        self.assertEqual(self.kinds(AWS), ["AWS access key"])
        self.assertEqual(self.kinds("client_secret = '" + "Zx9" * 8 + "'"), ["secret assignment"])

    def test_ignores_placeholders_references_and_public_keys(self) -> None:
        self.assertEqual(self.kinds("client_secret: '${secrets.client_secret_value}'"), [])
        self.assertEqual(self.kinds("password = '<your-password-goes-here>'"), [])
        self.assertEqual(self.kinds("-----BEGIN PUBLIC KEY-----"), [])
        self.assertEqual(self.kinds("dapi_token_name = 'dapi'"), [])

    def test_reports_the_line_and_a_fingerprint_not_the_value(self) -> None:
        [finding] = secret_scan.scan_text("f.py", f"a\nb = '{PAT}'\n", set())
        self.assertEqual(finding.where, "f.py:2")
        self.assertNotIn(PAT, repr(finding))
        self.assertEqual(finding.fingerprint, secret_scan.fingerprint(PAT))

    def test_an_allowed_fingerprint_is_accepted(self) -> None:
        self.assertEqual(self.kinds(PAT, {secret_scan.fingerprint(PAT)}), [])

    def test_allow_file_reads_fingerprints_and_ignores_comments(self) -> None:
        path = Path(self.id().replace(".", "_") + ".txt")
        try:
            path.write_text("# header\nabc123  # reason\n\n")
            self.assertEqual(secret_scan.allowed_fingerprints(path), {"abc123"})
        finally:
            path.unlink(missing_ok=True)

    def test_main_prints_no_value_and_exits_one_on_findings(self) -> None:
        finding = secret_scan.Finding("f.py:1", "private key", "0" * 16)
        out = StringIO()
        with (
            mock.patch.object(secret_scan, "scan_tree", return_value=[finding]),
            redirect_stdout(out),
        ):
            self.assertEqual(secret_scan.main([]), 1)
        self.assertIn("f.py:1  private key", out.getvalue())

    def test_main_exits_two_when_git_cannot_run(self) -> None:
        with mock.patch.object(secret_scan, "scan_tree", side_effect=RuntimeError("no repo")):
            with redirect_stdout(StringIO()), mock.patch("sys.stderr", StringIO()):
                self.assertEqual(secret_scan.main([]), 2)


if __name__ == "__main__":
    unittest.main()
