#!/usr/bin/env python3
"""Find credentials committed to this repository.

Scans every tracked file, or with --history every commit's added lines, for
credential formats: Databricks tokens and OAuth secrets, private keys, cloud
and SaaS tokens, and secret-looking assignments.

A finding prints its file, line, kind and a fingerprint, never the value. A
deliberate test value is accepted by listing its fingerprint, with a reason, in
secret-scan-allow.txt; a live value is rotated and removed instead.

Credentials only. Customer identifiers are internal by design and are checked
on the derived public tree by the mirror canary, not here.

Exit codes: 0 clean, 1 findings, 2 could not scan.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALLOW_FILE = Path(__file__).resolve().parent / "secret-scan-allow.txt"

PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Databricks personal access token", re.compile(r"\bdapi[0-9a-f]{32}(?:-\d)?\b")),
    ("Databricks OAuth secret", re.compile(r"\bdose[0-9a-f]{32}\b")),
    (
        "private key",
        re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"),
    ),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Azure storage key", re.compile(r"AccountKey=[A-Za-z0-9+/]{80,}={0,2}")),
    (
        "secret assignment",
        re.compile(
            r"""(?ix)
            \b(?:client_secret|api_key|access_token|password|secret_value)\b
            ["']?\s*[:=]\s*["']
            (?!\$\{|<|\{\{|example|placeholder|redacted|changeme|xxx|test|dummy|fake)
            [A-Za-z0-9+/=_.-]{20,}["']
            """
        ),
    ),
)

SKIP_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2", ".pdf")
SKIP_FILES = {"bundle/secret_scan.py", "bundle/secret_scan_test.py"}


@dataclass(frozen=True)
class Finding:
    where: str
    kind: str
    fingerprint: str


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def allowed_fingerprints(path: Path = ALLOW_FILE) -> set[str]:
    if not path.exists():
        return set()
    allowed = set()
    for line in path.read_text().splitlines():
        entry = line.split("#", 1)[0].strip()
        if entry:
            allowed.add(entry.split()[0])
    return allowed


def scan_text(where: str, text: str, allowed: set[str]) -> list[Finding]:
    findings = []
    for number, line in enumerate(text.splitlines(), start=1):
        for kind, pattern in PATTERNS:
            for match in pattern.finditer(line):
                mark = fingerprint(match.group(0))
                if mark not in allowed:
                    findings.append(Finding(f"{where}:{number}", kind, mark))
    return findings


def _git(*args: str) -> str:
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout


def scan_tree(allowed: set[str]) -> list[Finding]:
    findings = []
    for name in _git("ls-files", "-z").split("\0"):
        if not name or name in SKIP_FILES or name.lower().endswith(SKIP_SUFFIXES):
            continue
        path = ROOT / name
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        findings.extend(scan_text(name, text, allowed))
    return findings


def scan_history(allowed: set[str]) -> list[Finding]:
    """Every line any commit added, so a secret deleted later still counts."""

    findings: list[Finding] = []
    commit, name = "", ""
    log = _git("log", "--all", "-p", "--no-color", "--unified=0", "--format=commit %H")
    for line in log.splitlines():
        if line.startswith("commit "):
            commit = line.split()[1][:12]
        elif line.startswith("+++ b/"):
            name = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            if name in SKIP_FILES or name.lower().endswith(SKIP_SUFFIXES):
                continue
            for finding in scan_text(f"{commit}:{name}", line[1:], allowed):
                findings.append(
                    Finding(finding.where.rsplit(":", 1)[0], finding.kind, finding.fingerprint)
                )
    unique = {(f.kind, f.fingerprint): f for f in findings}
    return sorted(unique.values(), key=lambda f: f.where)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--history", action="store_true", help="scan every commit, not the tree")
    args = parser.parse_args(argv)
    allowed = allowed_fingerprints()
    try:
        findings = scan_history(allowed) if args.history else scan_tree(allowed)
    except RuntimeError as error:
        print(f"secret scan could not run: {error}", file=sys.stderr)
        return 2
    scope = "history" if args.history else "tracked files"
    if not findings:
        print(f"secret scan: no credentials found in {scope}")
        return 0
    print(f"secret scan: {len(findings)} possible credential(s) in {scope}")
    for finding in findings:
        print(f"  {finding.where}  {finding.kind}  fingerprint {finding.fingerprint}")
    print(
        "Rotate any live value and remove it. A deliberate test value may be accepted by "
        "adding its fingerprint and a reason to bundle/secret-scan-allow.txt."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
