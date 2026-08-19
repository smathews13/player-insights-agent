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

`agent/log_model.py` writes the user auth policy and the baked "run as user"
flag together, so a version logged through `bundle/agent-release.sh` is
internally consistent. That is exactly why this check is worth having: it means
a missing policy is evidence that something OTHER than the release wrote the
version, and it is the half of the wiring a release can still see afterwards.
Read at deploy time it costs one MLmodel download; read by a customer it costs
their first question.

WHAT IT VERIFIES, on the registered version itself:

  the model version has an auth_policy at all      MLmodel `auth_policy`
  it has a user_auth_policy under it               MLmodel `auth_policy.user_auth_policy`
  whose api_scopes is not empty                    the downscoped token's whole reach
  and covers every scope THIS release derived      the release summary's `api_scopes`
  and a system_auth_policy sits beside it          a bare WorkspaceClient needs one

The fourth line is where "at least dashboards.genie and sql when those are
configured" is enforced, and it is enforced WITHOUT a second list: the release
summary's `api_scopes` is what `agent/user_authorization.py::api_scopes` derived
from this target's Genie spaces and warehouse, plus the Vector Search pair when
an index is configured. Requiring the policy to cover it means a target with a
Genie space must carry the Genie scope and a target with a warehouse must carry
the SQL scope, with the spellings owned by the agent rather than repeated here.

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
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
AGENT = REPO / "agent"

EXIT_OK, EXIT_FINDING, EXIT_COULD_NOT_RUN = 0, 1, 2

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
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001 - reported as 'could not run'
        del sys.modules[name]
        raise Unreadable(f"{path} could not be imported: {exc}") from exc
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
        from mlflow.models.model import Model
    except ImportError as exc:
        raise Unreadable(
            f"mlflow is not importable, so an MLmodel cannot be read: {exc}. Run this "
            f"the way agent-release.sh does, under the agent's environment: "
            f"(cd agent && uv run --python 3.13 python ../bundle/model-user-auth-check.py ...)"
        ) from exc
    try:
        model = Model.load(source)
    except Exception as exc:  # noqa: BLE001 - every failure here is 'could not run'
        raise Unreadable(f"the MLmodel at {source} could not be read: {exc}") from exc
    return as_policy(getattr(model, "auth_policy", None), f"the MLmodel at {source}")


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
        help="a JSON MLmodel fragment: {\"auth_policy\": {...}}. Needs no mlflow.",
    )
    ap.add_argument(
        "--user-authorization",
        metavar="RAW",
        default=os.environ.get(USER_AUTH_ENV),
        help=f"what this release set {USER_AUTH_ENV} to; defaults to that variable",
    )
    args = ap.parse_args(argv)

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
    # which is what the orchestrator's own model calls use -- with nothing to
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
        caveats(args.registered)
        return EXIT_FINDING

    genie = [s for s in baked if "genie" in s]
    sql = [s for s in baked if s == "sql" or s.startswith("sql")]
    print(f"  ok    {where} carries a user auth policy")
    print(f"        api_scopes: {', '.join(sorted(baked))}")
    print(f"        covers every scope this release derived: {', '.join(sorted(derived))}")
    if genie:
        print(f"        Genie is reachable as the invoker ({', '.join(sorted(genie))})")
    if sql:
        print(f"        SQL is reachable as the invoker ({', '.join(sorted(sql))})")
    print("        a system auth policy sits beside it, so a plain WorkspaceClient resolves")
    print()
    caveats(args.registered)
    return EXIT_OK


def caveats(registered: bool) -> None:
    """What this run did NOT establish, printed pass or fail.

    On the pass it stops the check being quoted as "on-behalf-of-user is
    working"; on the failure it stops a reader fixing the policy and expecting
    the customer's question to work.
    """
    print("  NOT verified by this check, and not verifiable from a model version:")
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
