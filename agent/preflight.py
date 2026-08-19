"""What a release declares the agent may read, and what that grants it.

THIS MODULE GENERATES ACCESS. It is not a health check. The list
`resolve_declared_manifest` returns becomes the `DatabricksTable` resources on
the logged model version, and `agents.deploy()` grants the serving principal
SELECT on exactly those, so changing what this returns changes what the agent
can read.

Four things refuse a release:

  The CEILING past `MAX_DECLARED_TABLES`, because each entry is a dependency on
  the model version and Unity Catalog refuses a version with too many.

  The PAYLOAD-TABLE EXCLUSION. An AI Gateway inference payload table holds the
  prompts and completions of every request, so declaring one would grant the
  agent read access to its own users' conversations.

  An EMPTY MANIFEST, which produces an agent that can read nothing and fails at
  answer time looking like a broken workspace.

  The WIDENING REFUSAL. The manifest is generated, so it can broaden with no
  edit to any file; granting more than the previous version got needs
  ``--allow-widening``.

`python manifest_dryrun.py` prints what a release would declare, with every
exclusion and its reason, without logging anything.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable, Sequence
from fnmatch import fnmatch
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # `config` imports the table declaration below, so this stays type-only.
    from config import Settings

# ---------------------------------------------------------------------------
# The table declaration
#
# One list, read by the DatabricksTable resources in `log_model.py` (which is
# what automatic authentication passthrough actually grants) and by
# `Settings.tables` (what the running agent believes it depends on). It is split
# by space because `genie` mode declares one space's tables at a time.
#
# THIS IS OUR DEMO'S SHAPE AND IS NOT A REQUIREMENT IN EITHER MODE. A name that
# does not exist is reported rather than declared.
#
# Names only: nothing here or downstream should encode a brand, a title or a
# row count.
# ---------------------------------------------------------------------------

DATA_GENIE_TABLES = (
    "gold_player_180d_summary",
    "gold_title_daily_summary",
    "silver_gameplay_activity",
    "silver_player_profiles",
    "silver_purchases",
)
DICTIONARY_GENIE_TABLES = ("data_dictionary",)

DECLARED_TABLES = (*DATA_GENIE_TABLES, *DICTIONARY_GENIE_TABLES)

# ---------------------------------------------------------------------------
# Where the manifest comes from
#
# The manifest is the set of `DatabricksTable` resources logged with the model,
# which is exactly what automatic authentication passthrough grants the serving
# principal, so this setting decides what the agent can read.
#
# `schema`: enumerate every table Unity Catalog exposes in each
#   `catalog_allowlist` scope, then union the data contract in where it exists.
#
# `genie`: declare the tables the agent's two Genie spaces curate and nothing
#   else. It cannot declare a table that does not exist, because a space can only
#   curate one that does, and it cannot be large, because the platform caps a
#   space at MAX_GENIE_CURATED_TABLES.
#
# What `genie` mode costs: the contract tables are undeclared by design, so a
# question needing one is answered by saying it is out of scope.
# `governance_notes` states this at log time. The enforced SQL guard is
# unaffected in either mode, because it matches column names.
# ---------------------------------------------------------------------------

#: Enumerate `catalog_allowlist`, union the data contract where it exists.
MANIFEST_FROM_SCHEMA = "schema"
#: Declare what the Genie spaces curate, and only that.
MANIFEST_FROM_GENIE = "genie"

MANIFEST_SOURCES = (MANIFEST_FROM_SCHEMA, MANIFEST_FROM_GENIE)

# ---------------------------------------------------------------------------
# The ceiling on the manifest
#
# Two jobs. The manifest must stay small enough to be a deliberate declaration,
# since one mis-scoped allowlist entry can enumerate thousands of tables in a
# shared catalog, and it must stay under whatever Unity Catalog accepts as one
# model version's dependency list.
# ---------------------------------------------------------------------------

#: The one observed refusal of a model version for too many dependencies. UC's
#: real limit is undocumented and nobody has bisected it, so this is evidence
#: about one workspace on one day rather than a constant to reason from.
OBSERVED_DEPENDENCY_REFUSAL = 181

#: Documented maximum tables or views per Genie space. Two spaces is therefore
#: 60 at the outside, which is what makes `manifest_source = "genie"`
#: structurally incapable of reaching the refusal above.
MAX_GENIE_CURATED_TABLES = 30

#: Where the manifest stops being generated and starts being refused. OUR
#: BUDGET, NOT THE PLATFORM'S LIMIT: set below `OBSERVED_DEPENDENCY_REFUSAL` so
#: this file fails before the registry does, and above the 60 two fully-curated
#: Genie spaces can reach. It is NOT a claim that 90 passes and 91 does not.
MAX_DECLARED_TABLES = 90

#: Where the manifest becomes worth a second look, reported rather than refused.
WARN_DECLARED_TABLES = MAX_GENIE_CURATED_TABLES * 2

#: Schemas that can be named but must never be declared. Reading
#: `information_schema` from inside the endpoint fails even with catalog-level
#: SELECT, because it is backed by the `system` catalog and needs `USE CATALOG
#: system` granted separately. Declaring it would advertise tables the agent has
#: been measured to be unable to read.
UNDECLARABLE_SCHEMAS = frozenset({"information_schema"})

#: Columns that together identify an AI Gateway inference payload table: the
#: request log `databricks.agents.deploy()` creates in the agent's own schema.
#:
#: Recognised by SHAPE, not by name. The table is named after the customer's
#: endpoint, so our literal name is worth nothing on their workspace and a
#: '*_payload' rule would swallow a real table of theirs. `tables.list()`
#: already returns columns, so this costs no extra call and no extra grant.
PAYLOAD_TABLE_SIGNATURE = frozenset(
    {"databricks_request_id", "request", "response", "served_entity_id"}
)

# ---------------------------------------------------------------------------
# The build stamp
#
# The model, the app and the browser client are released by three separate
# commands, and a skewed deployment degrades quietly rather than erroring. The
# stamp makes the skew readable. It is a git commit rather than a version
# number because a commit cannot drift from what was built. Neither end copies
# the other: this reads git at log time and `bundle/app-release.sh` reads it at
# app-release time.
# ---------------------------------------------------------------------------

#: Environment variable carrying the stamp when git is not available: a CI
#: checkout without history, or the app server, which has no repository at all.
BUILD_SHA_VAR = "PLAYER_INSIGHTS_BUILD_SHA"

#: Appended when the tree the build came from held uncommitted TRACKED changes.
#: Untracked files are ignored: `mlruns/` and a local `mlflow.db` appear in any
#: tree the log has run in, and treating those as dirt would mark every build.
DIRTY_SUFFIX = "+dirty"


def _git(args: Sequence[str], cwd: Path) -> str | None:
    """`git` output, or None when git or the repository is not there."""

    try:
        finished = subprocess.run(  # noqa: S603 - fixed argv, no shell
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if finished.returncode != 0:
        return None
    return finished.stdout.strip()


def resolve_build_stamp(
    env: Any = None,
    cwd: Path | None = None,
    git: Callable[[Sequence[str], Path], str | None] = _git,
) -> str:
    """The commit this build came from, or ``""`` when it cannot be known.

    GIT FIRST, environment second: a stale ``PLAYER_INSIGHTS_BUILD_SHA`` left in
    a shell would otherwise stamp the artifact with a commit it was not built
    from. Returns the empty string rather than ``"unknown"``, so no reader can
    mistake absence for a match.
    """

    environment = os.environ if env is None else env
    root = Path(__file__).resolve().parent if cwd is None else cwd

    head = git(["rev-parse", "HEAD"], root)
    if head:
        # Tracked modifications only; see DIRTY_SUFFIX.
        dirt = git(["status", "--porcelain", "--untracked-files=no"], root)
        return f"{head}{DIRTY_SUFFIX}" if dirt else head

    declared = str(environment.get(BUILD_SHA_VAR) or "").strip()
    return declared


#: Longest an underlying error is allowed to be when quoted into a note. The
#: notes are read in a terminal, where one driver traceback buries every other.
MAX_ERROR_CHARS = 400


def _clean(error: BaseException) -> str:
    """One line naming the exception type and what it said."""

    text = " ".join(str(error).split())
    return f"{type(error).__name__}: {text}"[:MAX_ERROR_CHARS] if text else type(error).__name__


# ---------------------------------------------------------------------------
# The data contract
# ---------------------------------------------------------------------------


def declared_tables(settings: Settings) -> list[str]:
    """The DATA CONTRACT, fully qualified. NOT the declared resource list.

    `settings.readable_tables` is what the model declared and the principal was
    granted; this is the narrower set our own demo estate is built to.
    `resolve_declared_manifest` unions this into the manifest only where the
    tables exist, so the two cannot be swapped.
    """

    # PLAYER_INSIGHTS_TABLES is human-edited, and a fully-qualified entry is the
    # obvious mistake to make in it: qualifying one again yields a five-part
    # name in the GRANT, which is unusable rather than merely wrong.
    return [
        table if table.count(".") == 2 else f"{settings.namespace}.{table}"
        for table in settings.tables
    ]



# ---------------------------------------------------------------------------
# Generating the declaration
#
# `DECLARED_TABLES` above is the DATA CONTRACT: the tables our own demo estate
# is built to. The MANIFEST is every table named as
# a `DatabricksTable` resource at model-log time, which is exactly what
# passthrough grants the serving principal and therefore exactly what the agent
# can read. It is generated here, at log time, and baked into the artifact;
# `list_data_assets` reads it back rather than querying Unity Catalog live, so
# the agent cannot advertise a table it cannot read.
#
# A bare catalog entry expands to all of its non-system schemas, and a schema
# among them that exposes no tables is skipped rather than refused: an empty
# schema is an ordinary thing for a catalog to hold and says nothing about
# whether the entry was right. A two-part catalog.schema entry stays limited to
# that schema. data_catalogs is required, so there is no implicit app-catalog
# default that can widen silently.
#
# A scope is not automatically safe to declare in full: the endpoint writes its
# own inference payload table into the agent's schema. That one is excluded by
# shape, and `catalog_denylist` covers whatever only the operator can know about.
#
# THE DATA CONTRACT IS UNIONED IN ONLY WHERE THE TABLES EXIST. Declaring a
# resource for a table that is not there grants SELECT on a name and does not
# make the Genie space work, so it hides the problem until the first question.
# ---------------------------------------------------------------------------


class ScopeError(ValueError):
    """An allowlist entry cannot be turned into a table scope.

    Raised at log time, where an operator is watching, rather than resolved to
    a guess. The message names the entry and the edit that fixes it.
    """


def discovery_scopes(settings: Settings) -> list[str]:
    """Normalized `catalog` or `catalog.schema` data scopes.

    Order follows `catalog_allowlist` and duplicates are dropped, so the
    generated manifest is stable across log runs and two releases of the same
    configuration produce the same resource list.
    """

    scopes: list[str] = []
    for entry in settings.catalog_allowlist:
        name = entry.strip().strip("`")
        if not name:
            continue
        parts = name.split(".")
        if len(parts) == 2:
            if parts[1] in UNDECLARABLE_SCHEMAS:
                raise ScopeError(
                    f"data_catalogs entry {name!r} names {parts[1]}, which the "
                    "serving principal cannot read however it is declared: it is backed "
                    "by the 'system' catalog and needs USE CATALOG system granted "
                    "separately. Use list_data_assets for discovery instead."
                )
            scope = name
        elif len(parts) == 1:
            scope = name
        else:
            raise ScopeError(
                f"data_catalogs entry {name!r} has {len(parts)} parts. An entry is "
                "either 'catalog' or 'catalog.schema'."
            )
        if scope not in scopes:
            scopes.append(scope)
    return scopes


def scope_allows(settings: Settings, full_name: str) -> bool:
    """Whether a three-part table name is inside the declared data boundary."""

    parts = full_name.strip().strip("`").split(".")
    if len(parts) != 3:
        return False
    catalog, schema, _ = parts
    return any(
        scope == catalog or scope == f"{catalog}.{schema}"
        for scope in discovery_scopes(settings)
    )


def discovery_scope_groups(settings: Settings, workspace: Any) -> list[tuple[str, list[str]]]:
    """Each `data_catalogs` entry beside the concrete schemas it covers.

    GROUPED RATHER THAN FLATTENED, because the ENTRY is the unit a scope failure
    is about. A bare catalog entry names a catalog, so one schema inside it that
    exposes nothing is not evidence of anything: an empty schema is ordinary, and
    an app catalog acquires them the moment a deployment declares a telemetry or
    assets schema it has not written to yet. What IS evidence is the whole entry
    exposing nothing, which is what `_manifest_from_schema` refuses on.
    """

    groups: list[tuple[str, list[str]]] = []
    for scope in discovery_scopes(settings):
        if "." in scope:
            groups.append((scope, [scope]))
            continue
        try:
            schemas = workspace.schemas.list(catalog_name=scope)
        except Exception as error:  # noqa: BLE001
            raise ScopeError(
                f"Listing schemas in data catalog {scope!r} failed ({_clean(error)}). "
                "A whole-catalog scope must be expanded completely before model logging."
            ) from error
        covered = sorted(
            {
                f"{scope}.{name}"
                for item in schemas
                if (name := str(getattr(item, "name", "") or ""))
                and name not in UNDECLARABLE_SCHEMAS
            }
        )
        groups.append((scope, covered))
    return groups


def expanded_discovery_scopes(settings: Settings, workspace: Any) -> list[str]:
    """Expand whole-catalog entries into concrete non-system schemas."""

    expanded: list[str] = []
    for _, covered in discovery_scope_groups(settings, workspace):
        for scope in covered:
            if scope not in expanded:
                expanded.append(scope)
    return expanded


def scope_tables(workspace: Any, scope: str) -> list[Any]:
    """Every table Unity Catalog exposes in one `catalog.schema` scope.

    Returns the listing entries rather than names, because the exclusion rules
    below read each table's columns to recognise an inference payload table.
    Sorted by name so two log runs of one configuration declare the same
    resources in the same order.
    """

    catalog, schema = scope.split(".", 1)
    listed = workspace.tables.list(catalog_name=catalog, schema_name=schema)
    return sorted(listed, key=lambda table: table.name)


def is_inference_payload_table(table: Any) -> bool | None:
    """Whether a listing entry is an AI Gateway request log.

    ``None`` means the question could not be asked: the entry carried no column
    metadata, so the signature could not be evaluated. Distinguished from
    ``False`` because an unscreened table is a gap an operator should see, not
    a table that was checked and cleared.
    """

    columns = getattr(table, "columns", None)
    if columns is None:
        return None
    return PAYLOAD_TABLE_SIGNATURE <= {getattr(column, "name", "") for column in columns}


def denylist_match(full_name: str, relative_name: str, patterns: Sequence[str]) -> str | None:
    """The first `catalog_denylist` pattern this table matches, if any.

    Patterns are globs, matched against both the fully-qualified name and the
    bare table name, so `raw_*` and
    `some_catalog.some_schema.raw_purchases` both work.
    """

    for pattern in patterns:
        candidate = pattern.strip().strip("`")
        if not candidate:
            continue
        if fnmatch(full_name, candidate) or fnmatch(relative_name, candidate):
            return candidate
    return None


def exclusion_reason(settings: Settings, full_name: str, table: Any = None) -> str | None:
    """Why this table must not be declared, or ``None`` to declare it.

    One function so that the check protecting the data contract and the filter
    applied to the listing cannot disagree: the original defect in this area
    was two derivations of "what gets declared" drifting apart.
    """

    relative_name = full_name.rsplit(".", 1)[-1]
    pattern = denylist_match(full_name, relative_name, settings.catalog_denylist)
    if pattern:
        return f"catalog_denylist pattern {pattern!r}"
    if table is not None and is_inference_payload_table(table):
        return (
            "inference payload table: an AI Gateway request log, holding every "
            "question asked of a served endpoint, its answer, and the requester"
        )
    return None


def ceiling_notes(manifest: Sequence[str]) -> list[str]:
    """Notes about the manifest's size, or `ScopeError` when it is over budget.

    RAISES RATHER THAN TRUNCATING. A manifest trimmed to fit produces an endpoint
    that silently cannot read the tables that fell off the end.
    """

    count = len(manifest)
    if count > MAX_DECLARED_TABLES:
        raise ScopeError(
            f"{count} tables is over the {MAX_DECLARED_TABLES}-table ceiling on the "
            "manifest. Every entry becomes a DatabricksTable resource and a SELECT grant "
            "to the serving principal.\n\n"
            f"Unity Catalog refuses a model version with too many dependencies "
            f"(observed at {OBSERVED_DEPENDENCY_REFUSAL}) and that limit is documented "
            "nowhere, so this stops below the only refusal anyone has measured rather "
            "than letting log_model fail opaquely after the log has run.\n\n"
            "Two ways down, and the first is usually the right one:\n\n"
            "  - Declare what will actually be asked. Set manifest_source=genie and the "
            "manifest becomes the tables your Genie spaces curate rather than every table "
            f"in a schema. A space holds at most {MAX_GENIE_CURATED_TABLES} tables, so two "
            f"spaces cannot exceed {WARN_DECLARED_TABLES} however wide the schema is.\n"
            "  - Narrow what is enumerated. catalog_allowlist should name the "
            "'catalog.schema' scopes the agent is meant to analyse, and catalog_denylist "
            "rules out tables inside them.\n\n"
            "See the whole list, and every exclusion with its reason, without logging "
            "anything:  cd agent && uv run --python 3.13 python manifest_dryrun.py"
        )
    if count > WARN_DECLARED_TABLES:
        return [
            f"WARNING: {count} tables is past {WARN_DECLARED_TABLES} (more than two "
            f"fully-curated Genie spaces could hold), and the ceiling is "
            f"{MAX_DECLARED_TABLES}. Unity Catalog's own cap on dependencies per model "
            f"version is undocumented and has been seen to refuse "
            f"{OBSERVED_DEPENDENCY_REFUSAL}, so a manifest this size is being driven by "
            "schema enumeration rather than by anything that will be asked. "
            "manifest_source=genie declares the latter."
        ]
    return []


def genie_curated_tables(workspace: Any, space_id: str) -> list[str]:
    """Fully-qualified tables one Genie space curates, in the order it lists them.

    Read from the space's serialized definition, which is where curation
    actually lives. Names come back three-part already; anything shorter is
    dropped rather than guessed at,
    because a two-part name resolved against the agent's own catalog would
    declare, and grant SELECT on, a table nobody named.
    """

    space = workspace.genie.get_space(space_id, include_serialized_space=True)
    serialized = getattr(space, "serialized_space", None)
    if not serialized:
        return []
    document = json.loads(serialized)
    tables = ((document.get("data_sources") or {}).get("tables")) or []

    found: list[str] = []
    for entry in tables:
        identifier = str((entry or {}).get("identifier") or "").strip().strip("`")
        if identifier.count(".") == 2 and identifier not in found:
            found.append(identifier)
    return found


def _manifest_from_genie(
    settings: Settings, workspace: Any
) -> tuple[tuple[str, ...], list[str]]:
    """`(manifest, notes)` for the tables the agent's Genie spaces curate.

    Union of the two spaces, in space order, with the same exclusions `schema`
    mode applies. The data contract is NOT unioned in: that is the mode's whole
    purpose, and `governance_notes` states what it costs.

    A space that curates nothing, or cannot be read, is a refusal. A manifest
    built from one of two spaces would produce an endpoint that fails only on
    whichever half of the questions belong to the space that was silently
    skipped, which is worse than not releasing.
    """

    spaces = [
        ("data", settings.data_genie_space_id),
        ("dictionary", settings.dictionary_genie_space_id),
    ]
    configured = [(role, space_id) for role, space_id in spaces if space_id]
    if not configured:
        raise ScopeError(
            "manifest_source=genie needs at least one Genie space id, and neither "
            "data_genie_space_id nor dictionary_genie_space_id is set. The mode declares "
            "what the spaces curate, so with no space there is nothing to declare and "
            "the endpoint could read nothing. Set the ids, or use "
            f"manifest_source={MANIFEST_FROM_SCHEMA} to enumerate catalog_allowlist "
            "instead."
        )

    notes: list[str] = []
    manifest: list[str] = []
    excluded: list[tuple[str, str]] = []
    for role, space_id in configured:
        try:
            curated = genie_curated_tables(workspace, space_id)
        except Exception as error:  # noqa: BLE001
            raise ScopeError(
                f"Reading the {role} Genie space ({space_id}) failed ({_clean(error)}). "
                "In manifest_source=genie the space's curation IS the manifest, so a "
                "partial read would log a model granted SELECT on some unknowable "
                "subset of what it needs."
            ) from error
        if not curated:
            raise ScopeError(
                f"The {role} Genie space ({space_id}) curates no Unity Catalog tables "
                "that the identity logging this model can see. Either the space has no "
                "data sources attached, or that identity cannot read its definition. "
                "Attach the tables the space is meant to answer from, or use "
                f"manifest_source={MANIFEST_FROM_SCHEMA}."
            )
        notes.append(f"{role} Genie space {space_id}: {len(curated)} curated table(s)")
        if len(curated) > MAX_GENIE_CURATED_TABLES:
            notes.append(
                f"NOTE: the {role} space lists {len(curated)} tables, past the "
                f"{MAX_GENIE_CURATED_TABLES} the platform documents per space. The "
                "documented figure may have moved; the manifest ceiling still applies."
            )
        for full_name in curated:
            if full_name in manifest:
                continue
            # No listing entry to screen, so `is_inference_payload_table` cannot
            # be asked. That is a smaller gap here than in `schema` mode: a
            # payload table reaches the manifest only if a human curated it into
            # a Genie space, where in schema mode it arrives by enumeration.
            # The name-shaped half of the check still runs, and the denylist with it.
            reason = exclusion_reason(settings, full_name, None)
            if reason:
                excluded.append((full_name, reason))
                continue
            manifest.append(full_name)

    if not manifest:
        raise ScopeError(
            "Every table the Genie spaces curate was excluded, so no table would be "
            "declared and the endpoint could read nothing: "
            + "; ".join(f"{name}: {reason}" for name, reason in excluded)
        )

    if excluded:
        notes.append(
            f"{len(excluded)} curated table(s) excluded from the manifest: "
            + "; ".join(f"{name}: {reason}" for name, reason in excluded)
        )

    outside = [name for name in manifest if not scope_allows(settings, name)]
    if outside:
        raise ScopeError(
            f"{len(outside)} table(s) curated by the Genie spaces fall outside "
            "data_catalogs: " + ", ".join(outside) + ". data_catalogs is the complete "
            "read boundary, including when manifest_source=genie. Add the intended "
            "catalog or catalog.schema scope, or remove the table from the space."
        )

    notes.extend(governance_notes(settings, manifest))
    notes.extend(ceiling_notes(manifest))
    return tuple(manifest), notes


def _allowlist_scopes(settings: Settings) -> list[str]:
    """`discovery_scopes` without its refusals, for reporting in `genie` mode."""

    try:
        return discovery_scopes(settings)
    except ScopeError:
        return []


def governance_notes(settings: Settings, manifest: Sequence[str]) -> list[str]:
    """What an undeclared data contract does to the agent's governance behaviour.

    Nothing, now, beyond the manifest itself. The agent carries no compiled
    description of any dataset, so there is no longer a body of guidance that
    was offered for one schema and withheld from another; both manifest_source
    modes behave identically. The SQL guard's refusals are matched on column
    NAME and never consulted the manifest in either mode.

    The residual risk is stated in the note because it is easy to get backwards:
    the guard's column lists are OUR names, so a schema calling the same
    identifiers something else is unrefused.
    """

    missing = [name for name in declared_tables(settings) if name not in manifest]
    if not missing:
        return []
    return [
        f"GOVERNANCE: {len(missing)} data-contract table(s) are not declared, so the "
        "agent cannot read them and will say so rather than answering from something "
        "else.\n"
        "  STILL ENFORCED, unchanged: the SQL guard refuses crm_customer_ref "
        "anywhere in a statement, refuses NATURAL joins as unanalysable, and refuses "
        "returning email, display_name, player_id, platformid_accountid or "
        "partner_player_ref. These match on column NAME and never consulted the manifest.\n"
        "  WHAT TO DO ABOUT IT: the enforced boundary for this deployment is the "
        "Unity Catalog grants this manifest generates, so withhold SELECT on "
        "anything the agent must not read. And note that the guard's column lists "
        "are OUR names: a schema calling the same identifiers something else is not "
        "refused, in either manifest_source mode. If yours does, the names belong in "
        "BLOCKED_COLUMNS and UNRETURNABLE_COLUMNS in agent/tools.py."
    ]


def resolve_declared_manifest(
    settings: Settings, workspace: Any
) -> tuple[tuple[str, ...], list[str]]:
    """Return ``(manifest, notes)`` for the configured `manifest_source`.

    Runs as whoever is logging the model, so it resolves what THAT identity can
    see. That is the right identity: passthrough can only grant tables the
    logging principal could name, and a table invisible here would be a resource
    nobody could have used.

    The manifest is what `log_model` turns into `DatabricksTable` resources,
    which is what automatic authentication passthrough grants, so this function
    generates access, and every refusal below is a refusal to release rather
    than a failed check.
    """

    if settings.manifest_source == MANIFEST_FROM_GENIE:
        return _manifest_from_genie(settings, workspace)
    return _manifest_from_schema(settings, workspace)


#: How many schema names the refusal below prints before summarising the rest.
#: The message is read in a terminal, and a catalog with four hundred schemas
#: would otherwise bury the sentence that says what to do about it.
MAX_NAMED_EMPTY_SCHEMAS = 12


def _nothing_visible_refusal(entry: str, covered: Sequence[str]) -> str:
    """The message for a `data_catalogs` entry that exposes no table anywhere.

    Names the ENTRY and what the identity could actually see, because the two
    situations this covers need telling apart: a catalog whose schemas are all
    empty or unreadable, and an entry naming something that is not there.
    """

    if not covered:
        seen = (
            "It exposed no schemas at all, so either the catalog does not exist under "
            "that name or the identity cannot see into it."
        )
    else:
        named = ", ".join(covered[:MAX_NAMED_EMPTY_SCHEMAS])
        rest = len(covered) - MAX_NAMED_EMPTY_SCHEMAS
        seen = (
            f"All {len(covered)} schema(s) it covers listed zero tables: {named}"
            + (f", and {rest} more" if rest > 0 else "")
            + "."
        )
    return (
        f"data_catalogs entry {entry!r} exposed no tables to the identity logging this "
        f"model. {seen} Either the entry names the wrong scope or that identity lacks "
        "USE SCHEMA on it; both produce an endpoint that can read nothing from it.\n\n"
        "This is the WHOLE entry, not one schema. A single empty schema inside a "
        "catalog that exposes others is ordinary and is skipped with a note, so there "
        "is no need to hand-list the non-empty schemas to get past this."
    )


def _manifest_from_schema(
    settings: Settings, workspace: Any
) -> tuple[tuple[str, ...], list[str]]:
    """`(manifest, notes)` for every table in each `catalog_allowlist` scope.

    EXCLUSIONS ARE APPLIED BEFORE THE CONTRACT IS UNIONED IN, and a contract
    table an exclusion would remove stops the log. That ordering makes
    "excluded" final rather than something a later step can quietly undo.

    The contract is unioned in only where the listing returned the table. An
    absent one is reported instead (see `_absent_contract_advice`).

    AN EMPTY SCHEMA IS SKIPPED, NOT FATAL. This refused any scope that listed no
    tables, which made a bare catalog entry unusable: `cdp_share_prod` holds four
    schemas of production data and an empty `default`, and the empty one stopped
    the release while claiming the scope was wrong. It was not. The refusal now
    fires per `data_catalogs` ENTRY, where zero visible tables really does mean
    the entry names the wrong thing or the identity lacks USE SCHEMA.
    """

    groups = discovery_scope_groups(settings, workspace)
    if not groups:
        raise ScopeError(
            "data_catalogs resolved to no scopes, so no table would be declared "
            "and the endpoint could read nothing."
        )

    notes: list[str] = []
    manifest: list[str] = []
    excluded: list[tuple[str, str]] = []
    unscreened: list[str] = []
    listed_tables: dict[str, Any] = {}
    # Two entries can cover one schema (a catalog and a catalog.schema inside it).
    # Listing it once keeps the notes from double-counting, and keeps a schema
    # that is empty for one entry from reading as empty for the other.
    listings: dict[str, list[Any]] = {}
    for entry, covered in groups:
        visible = 0
        empty: list[str] = []
        for scope in covered:
            if scope in listings:
                found = listings[scope]
            else:
                try:
                    found = scope_tables(workspace, scope)
                except Exception as error:  # noqa: BLE001
                    raise ScopeError(
                        f"Listing tables in {scope} failed ({_clean(error)}). Declaring "
                        "the manifest from a partial listing would log a model that "
                        "silently cannot read half of what it advertises, so this stops "
                        "here."
                    ) from error
                listings[scope] = found
                if found:
                    notes.append(f"{scope}: {len(found)} table(s)")
            if not found:
                empty.append(scope)
                continue
            visible += len(found)
            for table in found:
                full_name = f"{scope}.{table.name}"
                if full_name in listed_tables:
                    continue
                listed_tables[full_name] = table
                reason = exclusion_reason(settings, full_name, table)
                if reason:
                    excluded.append((full_name, reason))
                    continue
                if is_inference_payload_table(table) is None:
                    unscreened.append(full_name)
                manifest.append(full_name)
        if not visible:
            raise ScopeError(_nothing_visible_refusal(entry, covered))
        if empty:
            # A NOTE, NOT A REFUSAL: reported so an operator can see a schema they
            # expected tables in came back empty, without it stopping a release
            # over the ordinary case of a schema nothing has been written to.
            notes.append(
                f"{entry}: {len(empty)} schema(s) exposed no tables and were skipped: "
                + ", ".join(empty)
            )

    # Before the union, so that a contract table an exclusion would remove is a
    # refusal rather than a silent re-add. Either half of the misconfiguration is
    # worth stopping for: re-adding it defeats the exclusion, and honouring it
    # produces an agent whose Genie spaces fail on their first call.
    contract_offences = [
        (name, reason)
        for name in declared_tables(settings)
        if (reason := exclusion_reason(settings, name, listed_tables.get(name)))
    ]
    if contract_offences:
        raise ScopeError(
            "These tables are part of the agent's data contract, and an exclusion "
            "would drop them: "
            + "; ".join(f"{name} ({reason})" for name, reason in contract_offences)
            + ". A model logged without them has Genie spaces that fail as a whole on "
            "their first call, so this stops here. Narrow catalog_denylist, or change "
            "the data contract in DATA_GENIE_TABLES / DICTIONARY_GENIE_TABLES if the "
            "table genuinely no longer belongs to it."
        )

    if excluded:
        notes.append(
            f"{len(excluded)} table(s) in scope excluded from the manifest: "
            + "; ".join(f"{name}: {reason}" for name, reason in excluded)
        )
    if unscreened:
        notes.append(
            f"{len(unscreened)} table(s) carried no column metadata, so they could not "
            "be screened for the inference-payload signature and were declared as "
            "listed: " + ", ".join(unscreened)
        )

    # Conditional on the table existing: declaring one that is not there grants
    # SELECT on a name and makes nothing work.
    contract = [
        name
        for name in declared_tables(settings)
        if name not in manifest and name in listed_tables
    ]
    if contract:
        manifest.extend(contract)
        notes.append(
            f"{len(contract)} data-contract table(s) added that the scope listing "
            "returned but the manifest had not reached: " + ", ".join(contract)
        )

    absent = [name for name in declared_tables(settings) if name not in listed_tables]
    if absent:
        notes.append(
            f"WARNING: {len(absent)} data-contract table(s) do not exist in any "
            "allowlisted scope and are NOT declared: " + ", ".join(absent) + ". "
            + _absent_contract_advice(absent, declared_tables(settings))
        )
    notes.extend(governance_notes(settings, manifest))
    notes.extend(ceiling_notes(manifest))
    return tuple(manifest), notes


def _absent_contract_advice(absent: Sequence[str], contract: Sequence[str]) -> str:
    """Which of two very different situations an absent contract table means.

    All of them absent is a schema that is simply not ours, which is supported.
    SOME of them absent is the dangerous one, in both of its readings.
    """

    if len(absent) == len(contract):
        return (
            "None of the contract is present, so this deployment is not built on our "
            "data model. That is a supported configuration and nothing here needs "
            "fixing; see the GOVERNANCE note below for what it means for the "
            "contract-bound behaviours. manifest_source=genie describes such a "
            "deployment more directly."
        )
    return (
        "Some of the contract is present and some is not, which is the configuration "
        "worth stopping on. Either this IS our schema and the listing did not return "
        "what it should have (check the identity logging this model has USE SCHEMA "
        "and SELECT), or it is a schema that partly collides with our table names, in "
        "which case the collision is a coincidence and the columns behind these names "
        "are not ours. A partly-present contract is the case that reads as "
        "authoritative while being wrong."
    )


# ---------------------------------------------------------------------------
# What a release would ADD to the agent's reach
#
# The manifest is generated, so it can widen with no edit to any file: a table
# lands from an unrelated job, an allowlist widens, a denylist is missing from
# the shell that ran the release. None of those errors. So the release compares
# what it is about to declare against Unity Catalog's record of what the
# previous version was granted, and a superset must be approved rather than
# observed. Narrowing is not gated; it is already loud.
# ---------------------------------------------------------------------------


class WideningCheckUnavailable(RuntimeError):
    """The comparison could not be made, as distinct from finding no widening.

    Kept separate because the two must not read alike at a call site. "Nothing
    new is granted" is a result; "Unity Catalog would not tell me what the last
    version was granted" is an absence of one, and a gate that cannot see is
    not a gate that passed.
    """


def granted_tables(workspace: Any, model_name: str, version: int) -> tuple[str, ...]:
    """Tables Unity Catalog records as dependencies of one model version.

    These are the `DatabricksTable` resources logged with that version, which is
    exactly the set automatic authentication passthrough granted its serving
    principal, read back from the registry rather than inferred from whatever
    configuration happens to be in scope now.
    """

    info = workspace.model_versions.get(model_name, int(version))
    dependencies = getattr(getattr(info, "model_version_dependencies", None), "dependencies", None)
    names = {
        name
        for dependency in (dependencies or [])
        if (table := getattr(dependency, "table", None)) is not None
        and (name := getattr(table, "table_full_name", None))
    }
    return tuple(sorted(names))


def latest_model_version(workspace: Any, model_name: str) -> int | None:
    """The highest existing version of the registered model, or ``None``.

    ``None`` means the model has no versions: a first release, which has no
    previous grant set to widen and so nothing to approve.
    """

    versions = [
        int(version.version)
        for version in workspace.model_versions.list(model_name)
        if getattr(version, "version", None) is not None
    ]
    return max(versions) if versions else None


def newly_granted_tables(
    workspace: Any, model_name: str, manifest: Sequence[str]
) -> tuple[int | None, tuple[str, ...], tuple[str, ...]]:
    """``(previous_version, added, removed)`` for a manifest about to be logged.

    ``previous_version`` is ``None`` for a first release, where both lists are
    empty. Raises `WideningCheckUnavailable` when the previous version's
    dependencies cannot be read, including when the registry returns none at
    all, since a model that declares no tables and a model whose dependencies
    have not been populated look identical from here, and reporting "everything
    is new" against the second would train an operator to wave the gate through.
    """

    try:
        previous = latest_model_version(workspace, model_name)
    except Exception as error:  # noqa: BLE001 - any registry failure, reported not swallowed
        raise WideningCheckUnavailable(
            f"could not list versions of {model_name}: {error}"
        ) from error
    if previous is None:
        return None, (), ()

    try:
        granted = granted_tables(workspace, model_name, previous)
    except Exception as error:  # noqa: BLE001
        raise WideningCheckUnavailable(
            f"could not read the dependencies of {model_name} version {previous}: {error}"
        ) from error
    if not granted:
        raise WideningCheckUnavailable(
            f"{model_name} version {previous} records no table dependencies, which is "
            "indistinguishable from a version whose dependencies Unity Catalog has not "
            "populated, so there is nothing to compare against"
        )

    current = set(manifest)
    added = tuple(name for name in manifest if name not in set(granted))
    removed = tuple(name for name in granted if name not in current)
    return previous, added, removed


def widening_refusal(model_name: str, previous_version: int, added: Sequence[str]) -> str:
    """The message for a release whose reach is wider than the live version's.

    Phrased as an unrecorded decision rather than a fault: widening is often
    deliberate, and a message that reads like an alarm gets silenced by narrowing
    the agent back without deciding to.
    """

    return (
        f"This release declares {len(added)} table(s) that {model_name} version "
        f"{previous_version} does not. Deploying it grants the serving principal SELECT "
        "on each, and validate_sql begins accepting them:\n"
        + "\n".join(f"  + {name}" for name in added)
        + "\n\nThere is nothing necessarily wrong with that. What this cannot tell "
        "apart is a widening somebody chose from one that arrived on its own: a table "
        "another job created, or a catalog_denylist that was not in the shell this "
        "time. The difference has to be stated rather than inferred.\n\n"
        "Two ways forward, and they are not equivalent:\n\n"
        "  - The list above is what you want the agent to reach. Re-run with "
        "--allow-widening. That is the decision, recorded on the command line.\n"
        "  - It is not. Then something should be excluded, and the place to say so is "
        "catalog_denylist in databricks.yml, NOT by dropping --allow-widening from a "
        "command that already had it, which narrows the agent by omission and leaves no "
        "trace of why.\n\n"
        "Either way, see the whole picture first (every table, every exclusion and its "
        "reason) with:  cd agent && uv run --python 3.13 python manifest_dryrun.py"
    )


