"""Conversation carry-over: read the whole conversation, within a budget, and reuse it.

The app sends `custom_inputs.prior_turns`: every earlier turn of the conversation,
oldest first, each with its question, answer parts and the evidence blocks it read.
Before this module the agent saw only the last 12 messages and re-ran every query on
every follow-up, which is why long conversations failed and why "make that a dashboard"
re-read all the data.

Three jobs, all pure (no model, no network) so they can be tested to the byte:

* `parse_prior_turns`  bounds what a caller can send, and counts what it rejected.
* `fit_turns`          keeps what fits `HISTORY_TOKEN_BUDGET`, compressing older turns
                       and leaving out what still does not fit, and says so.
* `statement_key`, `eligible_blocks`  decide which earlier results may stand in for a
                       new query.

THE BUDGET IS NOT AN APP SETTING, deliberately. A setting the app could raise is a way to
spin a run out of resources; the constants live here.

TRUST BOUNDARY. Reuse trusts the rows in `prior_turns`. That is safe only because the
server reads them from its own store, scoped to the signed-in user. Keep it so.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any

HISTORY_TOKEN_BUDGET = 30_000
HISTORY_FULL_TURNS = 2
PROMPT_TRIPWIRE_TOKENS = 120_000

MAX_TURNS = 200
MAX_TEXT_CHARS = 20_000
MAX_LIST_ITEMS = 50
MAX_BLOCKS_PER_TURN = 100
MAX_RESULT_CHARS = 40_000

TURN_TYPES = frozenset({"answer", "clarification", "plan", "report", "dashboard", "unavailable"})
ROW_TOOLS = ("run_sql", "query_named_table", "data_genie")
SQL_TOOLS = ("run_sql", "query_named_table")

CARRIED_CAVEAT = (
    "Some figures were carried over from earlier in this conversation rather than queried again."
)
COMPRESSED_CAVEAT = (
    "Earlier parts of this conversation were shortened to fit, so some detail was not read."
)
OMITTED_CAVEAT = (
    "The earliest parts of this conversation were too long to read in full and were not read."
)
UNREADABLE_CAVEAT = "The earlier conversation could not be read; only this message was used."
ROWS_DROPPED_CAVEAT = (
    "The rows from the most recent data turn were not available, so a chart could not use them."
)


def estimate_tokens(value: Any) -> int:
    return math.ceil(len(json.dumps(value, default=str)) / 4)


def _text(value: Any) -> str:
    return value[:MAX_TEXT_CHARS] if isinstance(value, str) else ""


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value[:MAX_LIST_ITEMS]:
        if isinstance(item, str):
            out.append(item[:MAX_TEXT_CHARS])
        elif isinstance(item, dict) and isinstance(item.get("name"), str):
            out.append(item["name"][:MAX_TEXT_CHARS])
    return out


def _block(raw: Any, turn_id: str = "") -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("tool"), str):
        return None
    result = raw.get("result")
    result = result if isinstance(result, str) else ""
    truncated = raw.get("truncated") is True
    if len(result) > MAX_RESULT_CHARS:
        result, truncated = result[:MAX_RESULT_CHARS], True
    arguments = raw.get("arguments")
    total = raw.get("total_rows")
    return {
        "turn_id": _text(raw.get("turn_id")) or turn_id,
        "tool": raw["tool"],
        "arguments": arguments if isinstance(arguments, dict) else {},
        "result": result,
        "sources": _strings(raw.get("sources")),
        "truncated": truncated,
        "total_rows": total if isinstance(total, int) and not isinstance(total, bool) else None,
        "compressed": raw.get("compressed") is True,
        "version": _text(raw.get("version")),
    }


@dataclass
class Parsed:
    turns: list[dict[str, Any]] = field(default_factory=list)
    carried: int = 0
    rejected: int = 0
    dropped: int = 0


def parse_prior_turns(value: Any) -> Parsed | None:
    """The carried turns, bounded; None when the field is absent or not a list.

    A list -- even an empty one -- means "present". Anything else means today's path.
    """

    if not isinstance(value, list):
        return None
    parsed = Parsed(carried=len(value))
    if len(value) > MAX_TURNS:
        parsed.dropped = len(value) - MAX_TURNS
        value = value[-MAX_TURNS:]
    for raw in value:
        if not isinstance(raw, dict):
            parsed.rejected += 1
            continue
        blocks = [
            block
            for block in (
                _block(b, _text(raw.get("turn_id")))
                for b in (raw.get("evidence_blocks") or [])[:MAX_BLOCKS_PER_TURN]
            )
            if block
        ]
        turn = {
            "turn_id": _text(raw.get("turn_id")),
            "question": _text(raw.get("question")),
            "type": raw.get("type") if raw.get("type") in TURN_TYPES else "",
            "takeaway": _text(raw.get("takeaway")),
            "narrative": _text(raw.get("narrative")),
            "content": _text(raw.get("content")),
            "caveats": _strings(raw.get("caveats")),
            "sources": _strings(raw.get("sources")),
            "evidence_blocks": blocks,
            "evidence_withheld": raw.get("evidence_withheld") is True,
            "compressed": False,
        }
        if not (
            turn["question"] or turn["takeaway"] or turn["narrative"] or turn["content"] or blocks
        ):
            parsed.rejected += 1
            continue
        parsed.turns.append(turn)
    return parsed


def _view(turn: dict[str, Any]) -> dict[str, Any]:
    """What a consumer reads of one turn: blocks without their ids and build."""

    blocks = [
        {
            k: v
            for k, v in b.items()
            if k not in {"turn_id", "version"} and not (turn["compressed"] and k == "result")
        }
        for b in turn["evidence_blocks"]
    ]
    return {
        **{k: v for k, v in turn.items() if k not in {"evidence_blocks"}},
        "evidence_blocks": blocks,
    }


def _compress(turn: dict[str, Any]) -> dict[str, Any]:
    return {
        **turn,
        "narrative": "",
        "content": "",
        "compressed": True,
        "evidence_blocks": [
            {**b, "result": "", "compressed": True} for b in turn["evidence_blocks"]
        ],
    }


def _lossless(turn: dict[str, Any]) -> bool:
    return not (
        turn["narrative"] or turn["content"] or any(b["result"] for b in turn["evidence_blocks"])
    )


@dataclass
class Fitted:
    turns: list[dict[str, Any]]
    compressed: list[int] = field(default_factory=list)
    omitted: list[int] = field(default_factory=list)
    tokens: int = 0


def fit_turns(turns: list[dict[str, Any]], budget: int = HISTORY_TOKEN_BUDGET) -> Fitted:
    """Keep what fits, newest first. Compress older turns; omit what still does not fit.

    The latest `HISTORY_FULL_TURNS` are always tried whole; after the first one that does
    not fit whole, every older turn is compressed. A turn that does not fit even
    compressed is omitted along with every older one. Numbers are 1-based turn positions.
    """

    remaining = budget
    whole = True
    kept: dict[int, dict[str, Any]] = {}
    compressed: list[int] = []
    omitted: list[int] = []
    omitting = False
    count = len(turns)
    for position, index in enumerate(range(count - 1, -1, -1)):
        turn = turns[index]
        if omitting:
            omitted.append(index + 1)
            continue
        cost = estimate_tokens(_view(turn))
        if (whole or _lossless(turn)) and cost <= remaining:
            kept[index] = turn
            remaining -= cost
            continue
        if position >= HISTORY_FULL_TURNS:
            whole = False
        small = _compress(turn)
        small_cost = estimate_tokens(_view(small))
        if small_cost <= remaining:
            kept[index] = small
            compressed.append(index + 1)
            remaining -= small_cost
        else:
            omitting = True
            omitted.append(index + 1)
    ordered = [kept[i] for i in sorted(kept)]
    return Fitted(ordered, sorted(compressed), sorted(omitted), budget - remaining)


def history_caveats(fitted: Fitted, parsed: Parsed) -> list[str]:
    notes: list[str] = []
    if fitted.compressed or fitted.omitted or parsed.dropped:
        if fitted.omitted or parsed.dropped:
            notes.append(OMITTED_CAVEAT)
        if fitted.compressed:
            notes.append(COMPRESSED_CAVEAT)
    return notes


def history_messages(turns: list[dict[str, Any]]) -> list[dict[str, str]]:
    """The conversation as chat messages. Assistant entries carry their `type`."""

    messages: list[dict[str, str]] = []
    for turn in turns:
        if turn["question"]:
            messages.append({"role": "user", "content": turn["question"]})
        body = "\n\n".join(p for p in (turn["takeaway"], turn["narrative"], turn["content"]) if p)
        if body:
            entry = {"role": "assistant", "content": body}
            if turn["type"]:
                entry["type"] = turn["type"]
            messages.append(entry)
    return messages


def established_context(turns: list[dict[str, Any]]) -> list[str]:
    """The finder's view: question, type, takeaway and sources per turn. No SQL, no rows."""

    lines: list[str] = []
    for turn in turns:
        parts = []
        if turn["question"]:
            parts.append(f"question: {turn['question']}")
        if turn["type"]:
            parts.append(f"type: {turn['type']}")
        if turn["takeaway"]:
            parts.append(f"established_in_earlier_turn: {turn['takeaway']}")
        if turn["sources"]:
            parts.append("sources: " + ", ".join(turn["sources"]))
        if parts:
            lines.append("\n".join(parts))
    return lines


def conversation_text(turns: list[dict[str, Any]]) -> str:
    """The synthesis step's conversation section, built from the kept turns."""

    return "\n\n".join(f"Earlier turn: {line}" for line in established_context(turns))


def latest_data_rows(parsed_turns: list[dict[str, Any]]) -> tuple[list[str], bool]:
    """Chart rows from the latest carried turn that read data, and whether they were lost.

    If that turn's rows were withheld or compressed there are no rows, and the flag is True
    so the answer can say a chart could not use them.
    """

    for turn in reversed(parsed_turns):
        blocks = [b for b in turn["evidence_blocks"] if b["tool"] in ROW_TOOLS]
        if not blocks:
            continue
        if turn["evidence_withheld"] or turn["compressed"]:
            return [], True
        rows = [
            f"{b['tool']}({json.dumps(b['arguments'], default=str)}) returned:\n{b['result']}"
            for b in blocks
            if b["result"]
        ]
        return rows, not rows
    return [], False


# ---------------------------------------------------------------------------
# Reuse
# ---------------------------------------------------------------------------

_LITERAL = re.compile(r"('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|`[^`]*`)")


def statement_key(sql: str) -> str | None:
    """A normalised statement, or None when it must never be keyed.

    Outside quoted literals: whitespace collapsed, case folded, spaces around `(`, `)` and
    `,` removed. Literals are kept verbatim. A trailing `;` is stripped. A statement with
    a comment (`--` or `/*`) is never keyed.
    """

    if not isinstance(sql, str) or not sql.strip():
        return None
    if "--" in sql or "/*" in sql:
        return None
    out: list[str] = []
    for piece in _LITERAL.split(sql.strip().rstrip(";").strip()):
        if _LITERAL.fullmatch(piece):
            out.append(piece)
            continue
        text = re.sub(r"\s+", " ", piece).lower()
        out.append(re.sub(r"\s*([(),])\s*", r"\1", text))
    return "".join(out).strip()


def block_key(block: dict[str, Any]) -> tuple[str, str] | None:
    tool = block["tool"]
    args = block.get("arguments") or {}
    if tool in SQL_TOOLS:
        key = statement_key(str(args.get("sql") or ""))
        return ("sql", key) if key else None
    if tool == "data_genie":
        question = args.get("question")
        return ("genie", question) if isinstance(question, str) and question else None
    return None


def eligible_blocks(
    parsed_turns: list[dict[str, Any]],
    readable: list[str] | tuple[str, ...],
    build_sha: str,
    tables_of_sql: Any,
) -> list[dict[str, Any]]:
    """Whole, readable, trustworthy blocks an earlier turn read. The newest wins a repeat.

    `tables_of_sql(sql)` returns the tables a statement reads (raising if it cannot be
    parsed). A block is dropped when its turn's rows were not carried, it is partial, any
    table it names is not readable by this build, or (Genie) it came from another build.
    """

    allowed = {name.lower() for name in readable}
    chosen: dict[tuple[str, str], dict[str, Any]] = {}
    for turn in reversed(parsed_turns):
        if turn["evidence_withheld"] or turn["compressed"]:
            continue
        for block in turn["evidence_blocks"]:
            if block["tool"] not in ROW_TOOLS:
                continue
            if block["truncated"] or block["compressed"] or not block["result"].strip():
                continue
            key = block_key(block)
            if key is None or key in chosen:
                continue
            tables = {s.lower() for s in block["sources"]}
            if block["tool"] in SQL_TOOLS:
                try:
                    tables |= {t.lower() for t in tables_of_sql(str(block["arguments"].get("sql")))}
                except Exception:  # noqa: BLE001 - unreadable SQL is not reusable
                    continue
            if tables - allowed:
                continue
            if block["tool"] == "data_genie" and (not build_sha or block["version"] != build_sha):
                continue
            chosen[key] = block
    return list(chosen.values())


DECISION_SYSTEM = (
    "You decide whether an earlier result in this conversation already answers the new "
    "request. Reply with JSON only. `reuse`: the listed results are enough, no new query is "
    "needed. `reuse_and_fetch`: some are useful, but a specific part is missing; describe "
    "only that missing part in `gap_request`. `fetch`: none of them help. `use` lists the "
    "indexes of the results to reuse. Never reuse a result that measures something "
    "different from what is asked. A request only to present, chart, summarise or restyle "
    "earlier results (a dashboard, a report, a chart) needs no new query: choose `reuse`."
)

DECISION_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "reuse_decision",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "decision": {"type": "string", "enum": ["reuse", "reuse_and_fetch", "fetch"]},
                "use": {"type": "array", "items": {"type": "integer"}},
                "gap_request": {"type": "string"},
            },
            "required": ["decision", "use", "gap_request"],
        },
    },
}


def decision_prompt(request: str, blocks: list[dict[str, Any]]) -> str:
    previews = "\n\n".join(
        f"[{index}] {block['tool']} {json.dumps(block['arguments'], default=str)[:400]}\n"
        f"{block['result'][:1_500]}"
        for index, block in enumerate(blocks)
    )
    return f"New request:\n{request}\n\nEarlier results:\n{previews}"


def parse_decision(text: str, count: int) -> tuple[str, list[int], str]:
    """(decision, use, gap_request); falls back to fetch on anything unusable."""

    fetch = ("fetch", [], "")
    try:
        payload = json.loads(text)
        decision = payload["decision"]
        use = payload["use"]
        gap = str(payload.get("gap_request") or "").strip()
    except (ValueError, KeyError, TypeError):
        return fetch
    if decision not in {"reuse", "reuse_and_fetch", "fetch"} or not isinstance(use, list):
        return fetch
    if decision == "fetch":
        return fetch
    if (
        not use
        or any(isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < count for i in use)
        or len(set(use)) != len(use)
    ):
        return fetch
    if decision == "reuse_and_fetch" and not gap:
        return fetch
    return decision, list(use), gap
