"""Everything the served agent imports has to travel with it.

A module missing from `code_paths` is not a degraded agent. The artifact logs
cleanly, the registry accepts it, the endpoint is created, and then the container
fails to LOAD, which reads in the serving logs as an import error rather than as
"somebody added a file". It costs a deploy cycle to find, and the guard's absence
looks exactly like any other missing name.

So the list is derived rather than remembered: walk what agent.py actually
imports, transitively, and compare. Adding a module to the agent then either
updates this list or fails here, in a second, on a laptop.

The same derivation runs over the THIRD-PARTY imports and `pip_requirements`,
and that half is the worse failure of the two. `httpx` was imported by config.py
and declared by nobody: it arrived in the container as a dependency of openai,
which is not a promise, and when openai 3 moved to httpx2 it stopped arriving.
Nothing about that version LOADS differently. The endpoint reports READY, every
deployment check passes, and the first person to notice is whoever asks the
first question.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

AGENT = Path(__file__).parents[1]
ENTRY = "agent"

#: Operator-side programs that must never enter the served artifact.
#:
#: This is a boundary rather than an inventory of everything currently omitted.
#: Each file below either writes workspace state, resolves release-time
#: configuration, or builds an artifact. Shipping one would give the serving
#: container release machinery it neither imports nor needs, and would make the
#: artifact's contents depend on what happened to be beside agent.py at log time.
#:
#: Kept explicit even though `test_nothing_is_logged_that_the_agent_does_not_import`
#: also catches today's list. That derivation answers "is this imported?" This
#: list answers the stronger question from the model-update contract: "may this
#: category of file ever ship?", including after an accidental runtime import.
RELEASE_ONLY = {
    "apply_from_declaration",
    "apply_model_version",
    "deploy_agent",
    "host_metadata_probe",
    "log_model",
    "manifest_dryrun",
    "semantic_layer_build",
}

#: Import name to the distribution that provides it, for the few that differ.
#: Only what the agent actually imports; this is not a general mapping.
DISTRIBUTIONS = {"databricks": "databricks-sdk"}


def _declared() -> set[str]:
    body = re.search(
        r"code_paths=\[(.*?)\n        \],",
        (AGENT / "log_model.py").read_text(),
        re.DOTALL,
    )
    assert body, "code_paths is not declared the way this test reads it"
    return {
        name.removesuffix(".py")
        for name in re.findall(r'ROOT / "([\w.]+\.py)"', body.group(1))
    }


def _imports(module: str) -> set[str]:
    tree = ast.parse((AGENT / f"{module}.py").read_text())
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    # Every import, at any depth. A package imported inside a function is the
    # case that matters most here: it runs at answer time rather than at load,
    # so a container missing it still passes every check the deploy makes.
    return found


def _local_imports(module: str) -> set[str]:
    return {name for name in _imports(module) if (AGENT / f"{name}.py").is_file()}


def _reachable() -> set[str]:
    seen: set[str] = set()
    queue = [ENTRY]
    while queue:
        module = queue.pop()
        if module in seen:
            continue
        seen.add(module)
        queue.extend(_local_imports(module))
    return seen - {ENTRY}


def test_every_module_the_agent_imports_is_logged_with_it():
    missing = sorted(_reachable() - _declared())
    assert not missing, (
        f"{', '.join(missing)} would not be in the artifact, so the served model fails to "
        "load. Add them to code_paths in log_model.py."
    )


def test_nothing_is_logged_that_the_agent_does_not_import():
    # Not a tidiness rule. A module in the list and in nobody's imports is either
    # dead or reached by a route this test cannot see, and both are worth knowing
    # before the next person trusts the list as an inventory.
    extra = sorted(_declared() - _reachable())
    assert not extra, f"{', '.join(extra)} is logged with the model and imported by nothing"


def test_release_programs_never_ship_inside_the_served_model():
    shipped = {ENTRY, *_declared()}
    leaked = sorted(RELEASE_ONLY & shipped)
    assert not leaked, (
        f"{', '.join(leaked)} is release machinery, not runtime agent code. "
        "Keep it out of python_model and code_paths."
    )


def test_governed_knowledge_loader_and_payload_ship_together():
    source = (AGENT / "log_model.py").read_text()
    assert 'str(ROOT / "knowledge"),' in source
    assert 'str(ROOT / "knowledge.py"),' in source
    assert (AGENT / "knowledge.py").is_file()
    payloads = sorted((AGENT / "knowledge").glob("*.md"))
    assert payloads, "the declared knowledge directory must contain a governed payload"


def _declared_requirements() -> set[str]:
    body = re.search(
        r"pip_requirements=\[(.*?)\n        \],",
        (AGENT / "log_model.py").read_text(),
        re.DOTALL,
    )
    assert body, "pip_requirements is not declared the way this test reads it"
    # The distribution name, without whichever version specifier it carries.
    return {
        re.split(r"[<>=!~\[]", line, maxsplit=1)[0].strip().lower()
        for line in re.findall(r'"([^"]+)"', body.group(1))
    }


def _third_party() -> set[str]:
    found: set[str] = set()
    for module in {ENTRY, *_reachable()}:
        found.update(_imports(module))
    return {
        name
        for name in found
        if not (AGENT / f"{name}.py").is_file() and name not in sys.stdlib_module_names
    }


def test_every_package_the_agent_imports_is_in_pip_requirements():
    declared = _declared_requirements()
    missing = sorted(
        name for name in _third_party() if DISTRIBUTIONS.get(name, name).lower() not in declared
    )
    assert not missing, (
        f"{', '.join(missing)} is imported by a module logged with the model and named by "
        "no line of pip_requirements in log_model.py. It may still reach the container as "
        "somebody else's dependency, which is how httpx got there until openai 3 stopped "
        "bringing it. Declare it."
    )


def test_the_guard_and_the_failure_codes_are_both_in_there():
    # Named rather than left to the derivation above, because these two are the
    # ones whose absence is silent in the worst way: the SQL guard not loading
    # means no statement is checked.
    declared = _declared()
    assert "sql_policy" in declared
    assert "failures" in declared
