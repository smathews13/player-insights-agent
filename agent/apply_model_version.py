"""Execute one app-approved model release from a Databricks notebook.

The app owns approval and audit state. This helper owns execution under the
notebook user's Databricks credentials; it creates no Job and stores no bearer
capability in Lakebase.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

Transport = Callable[[str, str, Mapping[str, str], Mapping[str, Any] | None], tuple[int, Any]]


def _sdk_auth_headers() -> dict[str, str]:
    """Resolve notebook-native OAuth through the supported Databricks SDK chain."""
    from databricks.sdk import WorkspaceClient

    headers = WorkspaceClient().config.authenticate()
    authorization = str(headers.get("Authorization") or "")
    if not authorization:
        raise RuntimeError("Databricks SDK credentials did not produce an Authorization header.")
    return {"Authorization": authorization}


def _http_transport(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: Mapping[str, Any] | None,
) -> tuple[int, Any]:
    encoded = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        url,
        data=encoded,
        method=method,
        headers={**headers, **({"Content-Type": "application/json"} if body is not None else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"detail": raw[:1000]}
        return error.code, parsed


def _request(
    transport: Transport,
    headers: Mapping[str, str],
    method: str,
    app_url: str,
    path: str,
    body: Mapping[str, Any] | None = None,
) -> Any:
    status, payload = transport(method, f"{app_url.rstrip('/')}{path}", headers, body)
    if status < 200 or status >= 300:
        detail = payload.get("detail") if isinstance(payload, Mapping) else ""
        summary = str(detail or "request refused")[:1000]
        raise RuntimeError(f"App API returned HTTP {status}: {summary}")
    return payload


def _revision(document: Mapping[str, Any]) -> str:
    import hashlib

    settings = document.get("settings")
    if not isinstance(settings, Mapping):
        raise ValueError("The approved declaration has no settings object.")
    canonical = json.dumps(
        dict(sorted(settings.items())), separators=(",", ":"), ensure_ascii=False
    )
    digest = hashlib.sha256(f"connections-apply\n{canonical}".encode()).hexdigest()
    return f"sha256:{digest}"


def _preflight(
    repo_root: Path, env: Mapping[str, str]
) -> tuple[dict[str, Any], subprocess.CompletedProcess[str]]:
    completed = subprocess.run(
        ["bash", str(repo_root / "bundle" / "preflight.sh"), "--live"],
        cwd=repo_root,
        env=dict(env),
        text=True,
        capture_output=True,
        check=False,
    )
    output = f"{completed.stdout}\n{completed.stderr}"
    ok = len(re.findall(r"(?m)^\s*ok\s+", output))
    failed = len(re.findall(r"(?m)^\s*FAIL\s+", output))
    warned = len(re.findall(r"(?m)^\s*WARN\s+", output))
    if completed.returncode and not failed:
        failed = 1
    status = "failed" if failed else ("warning" if warned else "ok")
    detail = "; ".join(
        line.strip() for line in output.splitlines() if re.match(r"^\s*(FAIL|WARN)\s+", line)
    )[:1000]
    return (
        {
            "status": status,
            "checkedAt": datetime.now(UTC).isoformat(),
            "ok": ok,
            "failed": failed,
            "unverified": warned,
            **({"detail": detail} if detail else {}),
        },
        completed,
    )


def _safe_error(error: BaseException) -> str:
    line = " ".join(str(error).split())
    line = re.sub(r"(?i)bearer\s+\S+", "Bearer [redacted]", line)
    line = re.sub(r"(?i)(token|secret|password)=\S+", r"\1=[redacted]", line)
    return line[:1000] or error.__class__.__name__


def apply_model_version(
    request_id: str,
    app_url: str,
    target: str | None = None,
    repo_root: str = "/path/to/player-insights-agent",
    *,
    token: str | None = None,
    _transport: Transport | None = None,
    _auth_headers: Callable[[], Mapping[str, str]] | None = None,
) -> dict[str, Any]:
    """Claim, execute, preflight, and close one approved release request.

    ``WorkspaceClient()`` notebook-native OAuth is the default. ``token`` is an
    explicit fallback for a user token supplied at runtime; it is never persisted
    or passed to the release subprocess.
    """
    if not request_id.strip():
        raise ValueError("request_id is required")
    root = Path(repo_root).expanduser().resolve()
    script = root / "bundle" / "apply-declaration.sh"
    if not script.is_file():
        raise FileNotFoundError(f"Release entrypoint not found: {script}")

    headers = (
        {"Authorization": f"Bearer {token}"}
        if token
        else dict((_auth_headers or _sdk_auth_headers)())
    )
    transport = _transport or _http_transport
    execution_id = str(uuid.uuid4())
    base_path = f"/api/admin/model-releases/{request_id}"

    fetched = _request(transport, headers, "GET", app_url, base_path)
    release = fetched["release"]
    declaration = release["declaration"]
    if declaration.get("revision") != release.get("declarationRevision"):
        raise RuntimeError("The stored declaration revision does not match its audit column.")
    if _revision(declaration) != declaration.get("revision"):
        raise RuntimeError("The approved declaration payload does not match its revision.")

    claimed = _request(
        transport,
        headers,
        "POST",
        app_url,
        f"{base_path}/claim",
        {"executionId": execution_id},
    )["release"]
    result_payload: dict[str, Any] | None = None
    preflight: dict[str, Any] | None = None
    try:
        approved_target = str(claimed.get("target") or "").strip()
        if target and target.strip() != approved_target:
            raise RuntimeError("The requested target differs from the approved release target.")
        release_target = approved_target
        if not release_target or release_target.startswith("<"):
            raise RuntimeError("The release request does not name a bundle target.")
        with tempfile.TemporaryDirectory(prefix="player-insights-release-") as temp:
            declaration_path = Path(temp) / "declaration.json"
            result_path = Path(temp) / "release-result.json"
            declaration_path.write_text(
                json.dumps(declaration, separators=(",", ":"), ensure_ascii=False),
                encoding="utf-8",
            )
            env = {**os.environ, "TARGET": release_target}
            command = [
                "bash",
                str(script),
                "--apply",
                "--i-am-deploying",
                "--declaration-json",
                str(declaration_path),
                "--result-json",
                str(result_path),
            ]
            subprocess.run(command, cwd=root, env=env, text=True, check=True)
            if not result_path.is_file():
                raise RuntimeError(
                    "The release completed without writing its machine-readable result."
                )
            result_payload = json.loads(result_path.read_text(encoding="utf-8"))
            version = str(result_payload.get("model_version") or "")
            if not version:
                raise RuntimeError("The release result did not identify the new model version.")

            preflight, preflight_run = _preflight(root, env)
            if preflight_run.returncode or preflight["failed"]:
                raise RuntimeError("Post-release preflight reported a failure.")

        completion = {
            "executionId": execution_id,
            "status": "succeeded",
            "vTo": version,
            "preflight": preflight,
        }
        closed = _request(transport, headers, "POST", app_url, f"{base_path}/status", completion)
        return {
            "request_id": request_id,
            "status": closed["release"]["status"],
            "v_from": closed["release"].get("vFrom"),
            "v_to": version,
            "preflight": preflight,
        }
    except BaseException as error:
        failure = {
            "executionId": execution_id,
            "status": "failed",
            "vTo": str((result_payload or {}).get("model_version") or "") or None,
            "preflight": preflight,
            "errorSummary": _safe_error(error),
        }
        try:
            _request(transport, headers, "POST", app_url, f"{base_path}/status", failure)
        except Exception:
            pass
        raise
