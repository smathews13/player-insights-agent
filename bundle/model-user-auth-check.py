#!/usr/bin/env python3
"""Does the version now serving actually carry a user auth policy?

THE INCIDENT THIS EXISTS FOR. A customer's deployment failed on the FIRST
question a person asked, with an HTTP 400 whose whole body was the SDK's
`model_serving_user_credentials auth: Unable to authenticate using
user_credentials in Databricks Model Serving Environment`. Nothing in the app,
the data, the grants or Lakebase was wrong. The endpoint had been stood up
without on-behalf-of-user credential forwarding, so Model Serving had no user
token to hand the container, and the agent -- which reads Genie and SQL as the
invoker or not at all -- could do nothing but fail.

`extensions/sample-neutral/agent/log_model.py` writes the user auth policy and
the baked "run as user" flag together, so a version logged through
`bundle/agent-release.sh` is internally consistent. That is exactly why this
check is worth having: it means
a missing policy is evidence that something OTHER than the release wrote the
version, and it is the half of the wiring a release can still see afterwards.
Read at deploy time it costs one MLmodel download; read by a customer it costs
their first question.

WHAT IT VERIFIES, on the registered version itself:

  the model version has an auth_policy at all      MLmodel `auth_policy`
  it has a user_auth_policy under it               MLmodel `auth_policy.user_auth_policy`
  whose api_scopes is not empty                    the downscoped token's whole reach
  and covers the expected scopes                   release summary, or the pinned artifact
  and a system_auth_policy sits beside it          a bare WorkspaceClient needs one

For a version logged by this release, the expected list is the exact
`api_scopes` emitted by `log_model.py`. For an externally logged pinned version,
`--adopt-registered-scopes` makes the registered artifact authoritative. That is
the no-re-log boundary: a capability added to newer source must not become a
retroactive scope requirement on an older model this repository did not log.

WHAT IT CANNOT VERIFY, printed on every run rather than left to be assumed:

  * whether the SERVING ENDPOINT was created with on-behalf-of-user forwarding
    turned on. That is endpoint-side configuration and does not appear in the
    model version's auth policy, so a version that passes here can still meet a
    caller with no credential to downscope.
  * whether the calling application forwards the signed-in user's token on
    `/invocations`. Without it the "user" is the app's own service principal,
    which authenticates fine and is the wrong principal.
  * whether the scope strings are ones the platform recognises. MLflow does not
    validate them: a scope that does not exist registers cleanly and fails at
    serve time.

A pass here is therefore "the model half of the wiring is present", not "the
customer's first question will work". Saying so is the point; a check that
implied the latter would be read as one and believed.

THREE WAYS IN, ONE JUDGEMENT. `--registered` and `--mlmodel` read the policy with
MLflow's own reader, which is the only thing in this file that needs MLflow --
lazily, so the third way needs nothing but the standard library. That matters:
`bundle/run-checks.sh` runs every `bundle/*.test.sh` on a CI runner with no pip
install at all, on the stated ground that a dependency is a way for a gate to
stop running for reasons unrelated to what it checks. So the suite beside this
file proves every finding through `--auth-policy-json`, which takes the same
mapping MLflow hands back, and the two MLflow doors are a thin call onto the same
judgement rather than a second copy of it.

    bundle/model-user-auth-check.py --logged summary.json --registered
    bundle/model-user-auth-check.py --logged summary.json --mlmodel path/to/MLmodel
    bundle/model-user-auth-check.py --logged summary.json --auth-policy-json fragment.json

    0  the version carries the policy this release asked for
    1  a finding: it does not
    2  the check could not run, which is NOT a pass
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
_SAMPLE_AGENT = REPO / "extensions" / "sample-neutral" / "agent"
AGENT = _SAMPLE_AGENT if _SAMPLE_AGENT.is_dir() else REPO / "agent"

EXIT_OK, EXIT_FINDING, EXIT_COULD_NOT_RUN = 0, 1, 2
SYNTHETIC_USER_TOKEN = "identity-readiness-synthetic-token"
OBO_NOT_WIRED = (
    "OBO not wired: x-forwarded-access-token is not reaching the serving endpoint."
)

#: The environment variable `bundle/agent-release.sh` exports to say whether this
#: release asked for user authorization. Read as a DEFAULT for --user-authorization
#: rather than instead of it, so the check is runnable by hand.
USER_AUTH_ENV = "PLAYER_INSIGHTS_USER_AUTHORIZATION"


class Unreadable(Exception):
    """A source could not be read. Never 'asks for nothing'."""


def load(name: str, path: Path):
    """A module imported by path, for files that are not on `sys.path`.

    REGISTERED IN ``sys.modules`` BEFORE IT IS EXECUTED, which is not optional
    here: ``@dataclass`` resolves its own module out of ``sys.modules`` while the
    class body runs, and a module that is not there yet fails with an
    ``AttributeError`` about ``NoneType`` that says nothing about the real cause.
    The target of this call declares two frozen dataclasses.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise Unreadable(f"{path.name} could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    sibling_path = str(path.parent)
    added_sibling_path = sibling_path not in sys.path
    if added_sibling_path:
        # A module loaded by filename does not gain its own directory on
        # sys.path. Runtime modules import sibling files (for example SDK
        # attribution), so the release check must load them the same way Python
        # loads agent.py inside the packaged model.
        sys.path.insert(0, sibling_path)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 - reported as 'could not run'
        del sys.modules[name]
        raise Unreadable(f"{path} could not be imported: {exc}") from exc
    finally:
        if added_sibling_path:
            sys.path.remove(sibling_path)
    return module


def read_summary(path: Path) -> dict[str, Any]:
    """The release summary `log_model.py` prints as its last stdout line.

    The SAME file `bundle/agent-release.sh` already writes for the scope gate, so
    there is one way to learn what a release baked rather than two.
    """
    try:
        summary = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Unreadable(f"the release summary at {path} is not readable JSON: {exc}") from exc
    if not isinstance(summary, dict):
        raise Unreadable(f"the release summary at {path} is not a JSON object")
    if "api_scopes" not in summary:
        # The distinction the scope gate already draws, drawn the same way: a
        # summary that lists no scopes and one that was never produced look
        # identical unless the KEY is what is tested for.
        raise Unreadable(
            f"the summary at {path} carries no api_scopes key, so it is not the JSON "
            "log_model.py prints. A release that baked no scopes and a file that is "
            "not a release summary would otherwise look the same."
        )
    return summary


def as_policy(policy: Any, where: str) -> dict[str, Any] | None:
    """Hold whatever a source handed back to the one shape the findings read.

    `None` is a version with no auth policy, which is a FINDING. Anything that is
    neither that nor a mapping is 'could not run', because a policy this file
    cannot read is not a policy it has established the absence of.
    """
    if policy is None:
        return None
    if not isinstance(policy, dict):
        raise Unreadable(
            f"{where} carries an auth_policy this check cannot read "
            f"({type(policy).__name__}). Treat the version's policy as unknown."
        )
    return policy


def read_auth_policy_json(path: Path) -> dict[str, Any] | None:
    """The MLmodel's `auth_policy` mapping, out of a JSON fragment.

    Standard library only, and the door the suite beside this file uses, so every
    finding below is proved on a runner with nothing installed. The fragment is
    the MLmodel document: `{"auth_policy": {...}}`, and `{}` is a version that
    carries none. Same mapping MLflow hands back, written down.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Unreadable(f"the auth policy fragment at {path} is not readable JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise Unreadable(f"the auth policy fragment at {path} is not a JSON object")
    return as_policy(document.get("auth_policy"), f"the fragment at {path}")


def read_auth_policy_mlflow(source: str) -> dict[str, Any] | None:
    """The `auth_policy` block of an MLmodel, read with MLflow's own reader.

    Given either a local MLmodel (or its directory) or a `models:/name/version`
    URI, which downloads the MLmodel and nothing else. Parsing the YAML here
    instead would be a second reader for a file format we do not own, and it
    would be the one used on the release path -- so it stays MLflow's, and the
    import stays lazy so the rest of this file needs nothing.
    """
    try:
        import mlflow
        from mlflow.models.model import Model
    except ImportError as exc:
        raise Unreadable(
            f"mlflow is not importable, so an MLmodel cannot be read: {exc}. Run this "
            f"the way agent-release.sh does, under the agent's environment: "
            f"(cd agent && uv run --python 3.13 python ../bundle/model-user-auth-check.py ...)"
        ) from exc
    try:
        # A models:/ URI for a three-level Unity Catalog model must use the UC
        # registry. Tracking still points at the workspace, and MLflow otherwise
        # inherits that as the registry and reports the just-created UC model as
        # "not found". Local MLmodel paths need no registry configuration.
        if source.startswith("models:/"):
            mlflow.set_registry_uri("databricks-uc")
        model = Model.load(source)
    except Exception as exc:  # noqa: BLE001 - every failure here is 'could not run'
        raise Unreadable(f"the MLmodel at {source} could not be read: {exc}") from exc
    return as_policy(getattr(model, "auth_policy", None), f"the MLmodel at {source}")


def observe_runtime_identity(result: Any = None, error: Any = None) -> str:
    """What the serving probe actually met, from a body or an HTTP error.

    `token_forwarded` is either the synthetic-token failure at Model Serving or
    the model resolving a real caller and rejecting the deliberately fake
    `expected_user` with IDENTITY_MISMATCH. `service_principal` is the
    no-invoker failure the boot-time readiness check names IDENTITY_REQUIRED.
    Envelope `execution_identity.mode` is not trusted as the runtime principal.
    """
    text = f"{error or ''}\n{result if isinstance(result, str) else json.dumps(result or '')}"
    if re.search(
        r"Unable to authenticate using user_credentials|model_serving_user_credentials",
        text,
        re.I,
    ):
        return "token_forwarded"
    custom = result if isinstance(result, dict) else {}
    nested = (
        custom.get("custom_outputs")
        if isinstance(custom.get("custom_outputs"), dict)
        else custom
    )
    code = str((nested or {}).get("code") or "")
    kind = str((nested or {}).get("type") or "")
    message = str((nested or {}).get("message") or "")
    combined = f"{message}\n{text}"
    if kind == "unavailable" and code == "IDENTITY_MISMATCH":
        # The probe intentionally names a user who cannot be the caller. Reaching
        # this comparison proves the model resolved an invoker identity; a
        # deployment with no forwarded credential fails earlier as
        # IDENTITY_REQUIRED. Treating both codes alike made a working OBO
        # endpoint fail every release.
        return "token_forwarded"
    if kind == "unavailable" and code == "IDENTITY_REQUIRED":
        return "service_principal"
    if re.search(
        r"without working user-authorization credential forwarding|"
        r"no credential for the signed-in user|no invoker token",
        combined,
        re.I,
    ):
        return "service_principal"
    identity = (nested or {}).get("execution_identity")
    mode = identity.get("mode") if isinstance(identity, dict) else None
    if mode == "signed_in_user":
        return "signed_in_user"
    if mode in {"service_principal", "assigned_service_principal"}:
        return "service_principal"
    return "unknown"


def compare_serving_identity(observed: str, *, user_auth: bool) -> str:
    """`ok`, `obo_not_wired`, `unverified`, or `skipped`."""
    if not user_auth:
        return "skipped"
    if observed in {"signed_in_user", "token_forwarded"}:
        return "ok"
    if observed == "service_principal":
        return "obo_not_wired"
    return "unverified"


def identity_probe_payload() -> dict[str, Any]:
    return {
        "input": [{"role": "user", "content": "identity readiness probe"}],
        "custom_inputs": {
            "identity_mode": "signed_in_user",
            "expected_user": "readiness-probe@invalid.example",
            "request_id": "identity-readiness-probe",
        },
    }


def invoke_serving_probe(host: str, token: str, endpoint: str) -> dict[str, Any]:
    """POST /serving-endpoints/{name}/invocations with a synthetic user token."""
    base = host.rstrip("/")
    url = f"{base}/serving-endpoints/{quote(endpoint, safe='')}/invocations"
    body = json.dumps(identity_probe_payload()).encode("utf-8")
    request = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-forwarded-access-token": SYNTHETIC_USER_TOKEN,
        },
    )
    try:
        with urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8", errors="replace")
            try:
                return {"result": json.loads(raw)}
            except json.JSONDecodeError:
                return {"result": raw}
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return {"error": parsed if parsed else str(exc), "status": exc.code}
    except URLError as exc:
        raise Unreadable(f"the serving endpoint {endpoint} could not be reached: {exc}") from exc


def scopes_of(policy: dict[str, Any] | None) -> tuple[bool, list[str]]:
    """(a user_auth_policy is present, the scopes it declares).

    The two are separate because absent and empty are different findings with
    different causes: no policy is a version logged as though user authorization
    were off, and an empty scope list is a version that asked for nothing.
    """
    user_policy = (policy or {}).get("user_auth_policy")
    if not isinstance(user_policy, dict):
        return False, []
    declared = user_policy.get("api_scopes")
    if not isinstance(declared, list):
        return True, []
    return True, [str(scope) for scope in declared]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--logged", metavar="SUMMARY_JSON", required=True)
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--registered",
        action="store_true",
        help="read models:/<model_name>/<model_version> named by the summary",
    )
    source.add_argument("--mlmodel", metavar="PATH", default=None)
    source.add_argument(
        "--auth-policy-json",
        metavar="PATH",
        default=None,
        help='a JSON MLmodel fragment: {"auth_policy": {...}}. Needs no mlflow.',
    )
    ap.add_argument(
        "--user-authorization",
        metavar="RAW",
        default=os.environ.get(USER_AUTH_ENV),
        help=f"what this release set {USER_AUTH_ENV} to; defaults to that variable",
    )
    ap.add_argument(
        "--adopt-registered-scopes",
        action="store_true",
        help=(
            "for an externally logged pinned version, validate the scopes already "
            "declared by that registered artifact instead of requiring current source "
            "capabilities that would need a re-log"
        ),
    )
    serving = ap.add_mutually_exclusive_group()
    serving.add_argument(
        "--serving-endpoint",
        metavar="NAME",
        default=None,
        help="invoke the live endpoint with a synthetic user token (deploy-time OBO probe)",
    )
    serving.add_argument(
        "--serving-probe-json",
        metavar="PATH",
        default=None,
        help="fixture {result,error,status} for the serving probe; needs no workspace",
    )
    args = ap.parse_args(argv)

    if args.adopt_registered_scopes and not (args.registered or args.auth_policy_json):
        print(
            "  COULD NOT RUN. --adopt-registered-scopes is valid only with "
            "--registered or an auth-policy fixture."
        )
        print("  A local MLmodel must state the expected scopes in its summary.")
        return EXIT_COULD_NOT_RUN

    if args.user_authorization is None:
        print("  COULD NOT RUN. Nothing said whether this was a user-authorization")
        print(f"  release: --user-authorization was not given and {USER_AUTH_ENV}")
        print("  is unset. An unanswered question is not a pass.")
        return EXIT_COULD_NOT_RUN

    try:
        user_auth = load("pia_user_authorization", AGENT / "user_authorization.py")
    except Unreadable as exc:
        print(f"  COULD NOT RUN. {exc}")
        print("  Nothing was inspected. This is not a pass.")
        return EXIT_COULD_NOT_RUN

    # The release's own rule, not a second reading of it: only "true" turns user
    # authorization on, and a well-meant "1" or "yes" resolves to off.
    resolution = user_auth.resolve(args.user_authorization)

    try:
        summary = read_summary(Path(args.logged))
    except Unreadable as exc:
        print(f"  COULD NOT RUN. {exc}")
        print("  Nothing was inspected. This is not a pass.")
        return EXIT_COULD_NOT_RUN

    derived = [str(scope) for scope in (summary.get("api_scopes") or [])]
    version = str(summary.get("model_version") or "")
    model_name = str(summary.get("model_name") or "")

    if not resolution.enabled:
        # NOT A PASS OF THE CHECK, and it does not pretend to be one. It is also
        # not a reason to block: this release did not ask for a user auth policy,
        # so a version without one is what it asked for. What the operator is owed
        # is the consequence, because the agent has no working passthrough mode --
        # `execution_identity.verify` refuses every request on such a version.
        print(f"  NOT CHECKED. {USER_AUTH_ENV}={resolution.raw!r} resolved to")
        print(f"  {resolution.mode}, so this release logged no user auth policy to verify.")
        print("  Version " + (version or "?") + " will refuse EVERY question with")
        print("  IDENTITY_REQUIRED: it has no invoker to read the data as, and it no")
        print("  longer falls back to reading it as itself. If that is not what you")
        print(f"  meant, re-release with {USER_AUTH_ENV}=true.")
        return EXIT_OK

    source_uri = args.mlmodel or args.auth_policy_json
    if args.registered:
        if not (model_name and version):
            absent = "no model_name" if not model_name else "no model_version"
            print("  COULD NOT RUN. --registered needs model_name and model_version from")
            print(f"  the summary at {args.logged}, and it carries {absent}.")
            return EXIT_COULD_NOT_RUN
        source_uri = f"models:/{model_name}/{version}"

    try:
        if args.auth_policy_json:
            policy = read_auth_policy_json(Path(args.auth_policy_json))
        else:
            policy = read_auth_policy_mlflow(str(source_uri))
    except Unreadable as exc:
        print(f"  COULD NOT RUN. {exc}")
        print("  The version's auth policy is UNKNOWN, which is not the same as absent")
        print("  and not the same as present. Do not read this as a pass.")
        return EXIT_COULD_NOT_RUN

    has_user_policy, baked = scopes_of(policy)
    scope_expectation = "this release derived"
    if args.adopt_registered_scopes:
        # A pinned external version is intentionally not re-logged by this
        # repository. Its artifact is therefore authoritative for which
        # optional transports exist. Requiring scopes derived from today's
        # source would turn every newly added capability into a retroactive
        # migration and make a no-re-log deployment impossible.
        derived = list(baked)
        scope_expectation = "the registered artifact declares"
    findings: list[str] = []

    if not derived:
        findings.append(
            "the release summary says this release derived NO api_scopes, so even a "
            "policy that carries them would carry them by accident. Model Serving "
            "downscopes the invoker's token to nothing and every Genie and SQL call "
            "fails inside the container rather than here."
        )

    if policy is None:
        findings.append(
            f"version {version or '?'} carries NO auth policy at all. This is the "
            f"failure a customer meets as an HTTP 400 on their first question: Model "
            f"Serving has no user credential to hand the container, and the SDK says "
            f"so in a sentence that names neither a cause nor a fix. Re-log and "
            f"redeploy through bundle/agent-release.sh from the full source repository "
            f"-- a restart, a re-grant or a data reload cannot write this."
        )
    elif not has_user_policy:
        findings.append(
            f"version {version or '?'} has an auth policy with NO user_auth_policy in "
            f"it, so nothing tells Model Serving to mint a downscoped user token. The "
            f"endpoint will authenticate as itself or not at all. Re-log and redeploy "
            f"through bundle/agent-release.sh from the full source repository."
        )
    elif not baked:
        findings.append(
            f"version {version or '?'} declares a user_auth_policy with an EMPTY "
            f"api_scopes list. The invoker's token is downscoped to nothing, so every "
            f"Genie and SQL call fails inside the container, at answer time, with an "
            f"authorization error that names no scope."
        )

    for scope in sorted(set(derived) - set(baked)):
        findings.append(
            f"{scope} is a scope THIS release derived from the target's configuration "
            f"and version {version or '?'} does not carry it in its user_auth_policy. "
            f"The agent will call that API and the downscoped token will not reach it."
        )

    # A user policy with nothing beside it leaves a bare `WorkspaceClient()` --
    # which is what the served Player Insights Agent model calls use -- with nothing to
    # resolve. `agent/user_authorization.py` says the two halves must agree or the
    # endpoint cannot authenticate at all; this is that sentence, enforced.
    if has_user_policy and not (policy or {}).get("system_auth_policy"):
        findings.append(
            f"version {version or '?'} declares a user_auth_policy with no "
            f"system_auth_policy beside it. The agent's own model calls build a plain "
            f"WorkspaceClient, which then has no resources and no identity to resolve."
        )

    where = source_uri if not args.registered else f"{source_uri} (the registered version)"
    if findings:
        print(f"  the model half of the user-authorization wiring is INCOMPLETE on {where}:")
        print()
        for finding in findings:
            print(f"  FAIL  {finding}")
        print()
        caveats(args.registered, serving_checked=False)
        return EXIT_FINDING

    genie = [s for s in baked if "genie" in s]
    sql = [s for s in baked if s == "sql" or s.startswith("sql")]
    print(f"  ok    {where} carries a user auth policy")
    print(f"        api_scopes: {', '.join(sorted(baked))}")
    print(f"        covers every scope {scope_expectation}: {', '.join(sorted(derived))}")
    if genie:
        print(f"        Genie is reachable as the invoker ({', '.join(sorted(genie))})")
    if sql:
        print(f"        SQL is reachable as the invoker ({', '.join(sorted(sql))})")
    print("        a system auth policy sits beside it, so a plain WorkspaceClient resolves")
    print()

    serving_checked = bool(args.serving_endpoint or args.serving_probe_json)
    if serving_checked:
        serving_status = probe_serving(args)
        if serving_status != EXIT_OK:
            caveats(args.registered, serving_checked=True)
            return serving_status

    caveats(args.registered, serving_checked=serving_checked)
    return EXIT_OK


def probe_serving(args: argparse.Namespace) -> int:
    """Deploy-time complement to the app's boot-time identity readiness check."""
    if args.serving_probe_json:
        try:
            document = json.loads(Path(args.serving_probe_json).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  COULD NOT RUN. the serving probe fixture is not readable JSON: {exc}")
            print("  The endpoint's token forwarding is UNKNOWN, which is not a pass.")
            return EXIT_COULD_NOT_RUN
        if not isinstance(document, dict):
            print("  COULD NOT RUN. the serving probe fixture is not a JSON object")
            return EXIT_COULD_NOT_RUN
        outcome = document
    else:
        host = (os.environ.get("DATABRICKS_HOST") or "").strip()
        token = (os.environ.get("DATABRICKS_TOKEN") or "").strip()
        if not host or not token:
            print("  COULD NOT RUN. --serving-endpoint needs DATABRICKS_HOST and DATABRICKS_TOKEN.")
            print("  The endpoint's token forwarding is UNKNOWN, which is not a pass.")
            return EXIT_COULD_NOT_RUN
        try:
            outcome = invoke_serving_probe(host, token, args.serving_endpoint)
        except Unreadable as exc:
            print(f"  COULD NOT RUN. {exc}")
            print("  The endpoint's token forwarding is UNKNOWN, which is not a pass.")
            return EXIT_COULD_NOT_RUN

    observed = observe_runtime_identity(result=outcome.get("result"), error=outcome.get("error"))
    verdict = compare_serving_identity(observed, user_auth=True)
    if verdict == "ok":
        print(f"  ok    serving probe observed {observed}: the endpoint accepted a user token")
        print("        (synthetic; Model Serving must try to downscope it)")
        return EXIT_OK
    if verdict == "obo_not_wired":
        print(f"  FAIL  {OBO_NOT_WIRED} observed={observed}")
        print("        The model expects SIGNED_IN_USER but the runtime is the service principal.")
        print("        Recreate the serving endpoint with on-behalf-of-user forwarding enabled.")
        return EXIT_FINDING
    print(f"  FAIL  serving probe could not tell whether OBO is wired (observed={observed}).")
    print("        Treat forwarding as unknown and do not ship this endpoint.")
    return EXIT_FINDING


def caveats(registered: bool, serving_checked: bool = False) -> None:
    """What this run did NOT establish, printed pass or fail.

    On the pass it stops the check being quoted as "on-behalf-of-user is
    working"; on the failure it stops a reader fixing the policy and expecting
    the customer's question to work.
    """
    print("  NOT verified by this check, and not verifiable from a model version:")
    if serving_checked:
        print("   - whether the calling application forwards the signed-in user's token")
        print("     on /invocations. The probe uses a synthetic token at deploy time;")
        print("     the app still has to forward the real one at ask time.")
    else:
        print("   - whether the serving ENDPOINT was created with on-behalf-of-user")
        print("     forwarding enabled. A version can carry the policy and still meet a")
        print("     caller with no user credential to downscope.")
        print("   - whether the calling application forwards the signed-in user's token")
        print("     on /invocations. Without it the invoker is the app's own service")
        print("     principal, which authenticates fine and is the wrong principal.")
    print("   - whether these scope strings are ones the platform recognises. MLflow")
    print("     does not validate them; a scope that does not exist registers cleanly")
    print("     and fails at serve time.")
    if not registered:
        print("   - this read a LOCAL file, not the registered version. Pass")
        print("     --registered to check what the registry actually holds.")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
