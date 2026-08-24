"""Load the small, governed knowledge payload that travels with the model.

Knowledge is split by audience, not by tier convenience:

- ``common_knowledge.md`` is finder-only always-on context. Abbreviations and
  the franchise registry have to be in context *before* the model picks a tool.
- ``counting_users.md`` is short on purpose. It rides on every finder call,
  every synthesis call, and the plan-facts call.
- On-demand documents would be tools. Their bodies were not in the handoff, so
  this module does not invent them.
"""

from __future__ import annotations

from pathlib import Path

KNOWLEDGE_DIR = Path(__file__).with_name("knowledge")

#: Finder always-on files, in the order they are appended.
COMMON_KNOWLEDGE_FILES = ("common_knowledge.md", "governance.md")
COUNTING_USERS_FILE = "counting_users.md"

#: On-demand knowledge tools. Empty until the handoff documents themselves are
#: supplied — inventing those bodies would put inference in the artifact wearing
#: the same authority as domain expertise.
KNOWLEDGE_TOOLS: list[dict] = []


def _read(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _join(sections: list[str]) -> str:
    return "\n\n".join(section for section in sections if section)


def load_common_knowledge(directory: Path | None = None) -> str:
    """Finder always-on context: abbreviations, franchise facts, governance."""

    root = directory or KNOWLEDGE_DIR
    if not root.is_dir():
        return ""
    return _join([_read(root / name) for name in COMMON_KNOWLEDGE_FILES])


def load_counting_users(directory: Path | None = None) -> str:
    """Identifier contract shared by both tiers."""

    root = directory or KNOWLEDGE_DIR
    return _read(root / COUNTING_USERS_FILE)


def load_packaged_knowledge(directory: Path | None = None) -> str:
    """Return markdown payloads in stable filename order.

    Kept for tests and for any caller that still wants the whole tree. Serving
    uses ``load_common_knowledge`` and ``load_counting_users`` separately.
    """

    root = directory or KNOWLEDGE_DIR
    if not root.is_dir():
        return ""
    sections = [path.read_text(encoding="utf-8").strip() for path in sorted(root.glob("*.md"))]
    return _join(sections)


def add_packaged_knowledge(instructions: str, payload: str) -> str:
    """Append a non-empty payload to model instructions."""

    return f"{instructions}\n\n# Packaged knowledge\n{payload}" if payload else instructions
