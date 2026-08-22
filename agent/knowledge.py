"""Load the small, governed knowledge payload that travels with the model."""

from __future__ import annotations

from pathlib import Path


def load_packaged_knowledge(directory: Path | None = None) -> str:
    """Return markdown payloads in stable filename order.

    The payload is deliberately text-only and local to the model artifact. It
    must not become a substitute for governed, request-time evidence.
    """

    root = directory or Path(__file__).with_name("knowledge")
    if not root.is_dir():
        return ""
    sections = [path.read_text(encoding="utf-8").strip() for path in sorted(root.glob("*.md"))]
    return "\n\n".join(section for section in sections if section)


def add_packaged_knowledge(instructions: str, payload: str) -> str:
    """Append a non-empty payload to model instructions."""

    return f"{instructions}\n\n# Packaged knowledge\n{payload}" if payload else instructions
