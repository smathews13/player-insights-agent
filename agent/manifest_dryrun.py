"""Print the manifest a log would declare, without logging anything.

Runs the same `preflight.resolve_declared_manifest` against the same live
workspace as `log_model.py` and stops. The manifest is generated rather than
written down, so it can change without anyone editing a file: a table added to
the schema by an unrelated job, or an inference payload table that appears after
the first deploy, changes what the next release grants.

Reads nothing but Unity Catalog listings, and writes nothing at all.

Usage, with the same environment `bundle/agent-release.sh` exports:

    cd agent && uv run --python 3.13 python manifest_dryrun.py
"""

from __future__ import annotations

import json
import os
import sys

from databricks.sdk import WorkspaceClient

from config import ENV_VARS, MissingConfiguration, Settings
from preflight import (
    MANIFEST_FROM_GENIE,
    MANIFEST_FROM_SCHEMA,
    MAX_DECLARED_TABLES,
    ScopeError,
    WideningCheckUnavailable,
    declared_tables,
    discovery_scopes,
    exclusion_reason,
    newly_granted_tables,
    resolve_declared_manifest,
    scope_tables,
)
from user_authorization import USER_AUTHORIZATION_ENV, api_scopes, resolve


def _scopes_or_none(settings: Settings) -> list[str]:
    """`discovery_scopes`, reported rather than fatal.

    For `genie` mode only, where the allowlist bounds the SQL guard but does not
    generate the manifest, so a broken entry must not stop the dry run.
    """

    try:
        return discovery_scopes(settings)
    except ScopeError as error:
        print(f"  (catalog_allowlist does not resolve: {error})")
        return []


#: What `manifest_source=genie` needs that no other mode does. The ids are
#: required in every mode, so a general "missing configuration" message is
#: correct but describes the smaller half of what has gone wrong here: in this
#: mode the spaces GENERATE the manifest rather than merely being called at
#: answer time.
GENIE_SPACE_KEYS = ("data_genie_space_id", "dictionary_genie_space_id")


def _resolve_settings() -> Settings | None:
    """`Settings.from_env`, refused in prose rather than as a traceback.

    A dry run is the first thing a deployer runs and the last thing that should
    answer them with a stack trace. `preflight` already refuses an unreadable or
    uncurated Genie space in a sentence that names the fix; this closes the one
    route that reached the terminal as Python.
    """

    try:
        return Settings.from_env()
    except MissingConfiguration as error:
        print("REFUSED. This configuration would not log:\n")
        print(f"  {error}")
        requested = (os.getenv(ENV_VARS["manifest_source"]) or "").strip().lower()
        if requested == MANIFEST_FROM_GENIE and any(
            not (os.getenv(ENV_VARS[key]) or "").strip() for key in GENIE_SPACE_KEYS
        ):
            print(
                f"\n  AND NOTE THE MODE. {ENV_VARS['manifest_source']}={MANIFEST_FROM_GENIE} "
                "asks for a manifest\n  DERIVED from the Genie spaces, so with no space id "
                "there is nothing to derive\n  it from: no table would be declared, the "
                "serving principal would be granted\n  SELECT on nothing, and the endpoint "
                "would answer every question as though the\n  workspace were empty. Set the "
                f"ids above, or use\n  {ENV_VARS['manifest_source']}={MANIFEST_FROM_SCHEMA} "
                "to enumerate catalog_allowlist instead."
            )
        return None


def main() -> int:
    settings = _resolve_settings()
    if settings is None:
        return 1
    workspace = WorkspaceClient()
    # Decides who the grants below apply to, and under user authorization decides
    # that they stop being the whole answer.
    user_auth = resolve(os.getenv(USER_AUTHORIZATION_ENV))
    scopes_requested = api_scopes(settings) if user_auth.enabled else ()
    model_name = os.getenv(
        "PLAYER_INSIGHTS_MODEL_NAME",
        f"{settings.catalog}.{settings.schema}.player_insights_agent",
    )

    genie_mode = settings.manifest_source == MANIFEST_FROM_GENIE

    print("catalog.schema     ", settings.namespace)
    print("manifest_source    ", settings.manifest_source)
    if genie_mode:
        print(
            "                     the manifest is what the Genie spaces curate; "
            "catalog_allowlist\n"
            "                     bounds the SQL guard but does not generate the manifest"
        )
    print("catalog_allowlist  ", ", ".join(settings.catalog_allowlist) or "(none)")
    print("catalog_denylist   ", ", ".join(settings.catalog_denylist) or "(none)")
    # Labelled as ours because it is. Unity Catalog's own cap is undocumented and
    # has refused 181; this sits below it so a release fails here, not in the
    # registry.
    print("ceiling            ", f"{MAX_DECLARED_TABLES} (ours, see MAX_DECLARED_TABLES)")
    print("execution identity ", user_auth.mode)
    if user_auth.enabled:
        print("api scopes         ", ", ".join(scopes_requested) or "(none)")
    elif user_auth.reason == "unrecognised":
        print(
            f"                    ({USER_AUTHORIZATION_ENV}={user_auth.raw!r} was IGNORED; "
            'only "true" enables user authorization)'
        )
    print()

    try:
        # Reported in both modes: in `genie` mode the allowlist is not the
        # generator, so a broken entry must not stop the run.
        scopes = discovery_scopes(settings) if not genie_mode else _scopes_or_none(settings)
        manifest, notes = resolve_declared_manifest(settings, workspace)
    except ScopeError as error:
        print("REFUSED. This configuration would not log:\n")
        print(f"  {error}")
        return 1

    print(f"MANIFEST: {len(manifest)} table(s) would be declared as DatabricksTable")
    print("resources, and granted SELECT to the serving principal:\n")
    if user_auth.enabled:
        # Before the list, because under this flag the list answers a narrower
        # question than it looks like it answers.
        print(
            "  NOTE: under user authorization this list is a CEILING, not a grant. The\n"
            "  serving principal still gets these, so the agent can make its own model\n"
            "  calls, but Genie and SQL run as whoever invoked the endpoint, and their\n"
            "  own Unity Catalog grants decide which of these actually answer. A caller\n"
            "  holding four of them gets an answer computed from four.\n"
        )
    for position, table in enumerate(manifest, 1):
        print(f"  {position:3d}. {table}")

    # "What was left out" is the half an operator cannot infer from the list. In
    # `genie` mode there is no schema listing to compare against, so the exclusions
    # `resolve_declared_manifest` already found are what there is.
    if genie_mode:
        print("\nEXCLUDED. Curated by a Genie space, deliberately not declared:\n")
        print("  (see NOTES below; nothing outside a space's curation is considered)")
        excluded = []
    else:
        print("\nEXCLUDED. In an allowlisted scope, deliberately not declared:\n")
        excluded = [
            (f"{scope}.{table.name}", reason)
            for scope in scopes
            for table in scope_tables(workspace, scope)
            if (reason := exclusion_reason(settings, f"{scope}.{table.name}", table))
        ]
        if excluded:
            for name, reason in excluded:
                print(f"  - {name}\n      {reason}")
        else:
            print("  (nothing)")

    # Split so these are not read as the fifth bullet of a list of table counts.
    loud = [note for note in notes if note.startswith(("WARNING:", "GOVERNANCE:"))]
    if loud:
        print("\nREAD THESE:\n")
        for note in loud:
            print(f"  {note}\n")

    print("\nNOTES:\n")
    for note in notes:
        if note not in loud:
            print(f"  - {note}")

    # Mode-dependent. In `schema` mode the contract MUST be declared: the union
    # guarantees it, and a gap means a listing failed. In `genie` mode the contract
    # need not exist at all, so "MISSING" would be a false alarm on every customer
    # schema; what an operator needs instead is what the absence costs.
    contract = declared_tables(settings)
    if genie_mode:
        bound = [table for table in contract if table in manifest]
        print(
            f"\nDATA CONTRACT: {len(bound)} of {len(contract)} table(s) declared. In "
            "manifest_source=genie\nthe contract is NOT required: the spaces decide, and "
            "these names are our demo's shape.\n"
        )
        for table in contract:
            print(f"  {'declared' if table in manifest else 'absent  '} {table}")
        if len(bound) < len(contract):
            print(
                "\n  GOVERNANCE: the cross-label refusal, the restricted-column refusal and\n"
                "  the net-bookings sign convention are enforced against contract-shaped\n"
                "  columns. For the tables above marked absent they have nothing to bind\n"
                "  to, so they degrade to prompt-level guardrails: asked of the model\n"
                "  rather than imposed on it. The enforced boundary is the Unity Catalog\n"
                "  grants this manifest generates: withhold SELECT on anything the agent\n"
                "  must not read rather than relying on the refusals to cover it."
            )
    else:
        print(f"\nDATA CONTRACT: {len(contract)} table(s), all of which must be declared:\n")
        for table in contract:
            print(f"  {'ok  ' if table in manifest else 'MISSING'} {table}")

    # Whether this release changes anyone's data access. Printed here as well as
    # gated in log_model.py, so an operator sees it before running the thing that
    # acts on it.
    print("\nAGAINST THE LIVE VERSION:\n")
    previous_version: int | None = None
    added: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    try:
        previous_version, added, removed = newly_granted_tables(workspace, model_name, manifest)
    except WideningCheckUnavailable as error:
        print(f"  could not compare: {error}")
    else:
        if previous_version is None:
            print(f"  {model_name} has no versions yet; nothing to compare against")
        else:
            print(f"  comparing against version {previous_version}\n")
            for name in added:
                print(f"  + {name}   NEWLY GRANTED")
            for name in removed:
                print(f"  - {name}   no longer granted")
            if not added and not removed:
                print("  no change: this release grants exactly what the live version has")
            elif added:
                print(
                    "\n  This release reaches wider than the live version. If that is what "
                    "you want,\n  log_model.py takes --allow-widening and records the "
                    "decision. If it is not, the\n  place to say so is catalog_denylist, "
                    "not by leaving the flag off a release that\n  needs it, which narrows "
                    "the agent without saying why."
                )

    print(
        "\n"
        + json.dumps(
            {
                "declared_tables": len(manifest),
                "excluded_tables": len(excluded),
                "manifest_source": settings.manifest_source,
                "contract_tables_declared": sum(
                    1 for table in declared_tables(settings) if table in manifest
                ),
                "scopes": scopes,
                "denylist": list(settings.catalog_denylist),
                "compared_against_version": previous_version,
                "newly_granted": list(added),
                "no_longer_granted": list(removed),
                "execution_identity": user_auth.mode,
                "api_scopes": list(scopes_requested),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
