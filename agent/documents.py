"""Dashboards and reports: when to build one, and what a finished page may hold.

A request for a dashboard or for HTML returns one self-contained HTML page; a request
for a report, a one-pager, a deck or slides returns a multi-section document. Both are
decided here, in code, from the words of the request -- never by the model.

THE TRIGGERS ARE FORGIVING ON PURPOSE. A dashboard asked for as "dashbaord" used to fall
through to an ordinary answer, because the trigger was an exact string. A word that
starts with `d`, is 7-12 letters long and is within two edits of "dashboard(s)" now
counts. "dashed", "dashing" and "database" stay out: too short, or too far.
"""

from __future__ import annotations

import os
import re

DASHBOARD_SCHEMA_VERSION = "pia.dashboard/1"
REPORT_SCHEMA_VERSION = "pia.report/1"

#: Output-token cap for the one call that writes a dashboard. Its own setting, apart from
#: `max_output_tokens`: a page is far longer than an answer card.
DEFAULT_DASHBOARD_MAX_OUTPUT_TOKENS = 32_000
DASHBOARD_TOKENS_ENV = "PLAYER_INSIGHTS_DASHBOARD_MAX_OUTPUT_TOKENS"
#: HTML limit = cap x this. Replaces a flat limit that threw away finished pages.
DASHBOARD_HTML_CHARS_PER_TOKEN = 4
#: Do not start a dashboard call with less than reserve + this many seconds left.
DASHBOARD_MIN_SECONDS = 30.0


def dashboard_max_output_tokens() -> int:
    raw = os.environ.get(DASHBOARD_TOKENS_ENV, "").strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_DASHBOARD_MAX_OUTPUT_TOKENS
    return value if value > 0 else DEFAULT_DASHBOARD_MAX_OUTPUT_TOKENS


def dashboard_html_limit(cap: int | None = None) -> int:
    return (cap if cap is not None else dashboard_max_output_tokens()) * (
        DASHBOARD_HTML_CHARS_PER_TOKEN
    )


def _osa_distance(a: str, b: str) -> int:
    """Optimal string alignment: insert, delete, substitute, adjacent swap = one edit."""

    rows, cols = len(a) + 1, len(b) + 1
    d = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        d[i][0] = i
    for j in range(cols):
        d[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[-1][-1]


_WORDS = re.compile(r"[A-Za-z]+")
_DASHBOARD_WORD = re.compile(r"\b(?:dashboards?|html)\b", re.IGNORECASE)


def _misspelled_dashboard(text: str) -> bool:
    for word in _WORDS.findall(text):
        lowered = word.lower()
        if not lowered.startswith("d") or not 7 <= len(lowered) <= 12:
            continue
        if min(_osa_distance(lowered, "dashboard"), _osa_distance(lowered, "dashboards")) <= 2:
            return True
    return False


def dashboard_requested(text: str) -> bool:
    """A dashboard, HTML, or a recognisable misspelling of "dashboard"."""

    value = text or ""
    return bool(_DASHBOARD_WORD.search(value)) or _misspelled_dashboard(value)


_REPORT_REQUESTED = re.compile(
    r"\b(?:reports?|one[\s-]?pagers?|1[\s-]?pagers?|(?:1|one)\s*page\s*summar(?:y|ies)"
    r"|decks?|powerpoint|slides?)\b",
    re.IGNORECASE,
)


def report_requested(text: str) -> bool:
    return bool(_REPORT_REQUESTED.search(text or ""))


def wants_document(text: str) -> str:
    """ "dashboard", "report" or "": one question gets one document, dashboard first."""

    if dashboard_requested(text):
        return "dashboard"
    if report_requested(text):
        return "report"
    return ""


_CLOSING = re.compile(r"</html\s*>", re.IGNORECASE)


def trim_html(html: str, limit: int) -> tuple[str, bool]:
    """(html, trimmed). A page over the limit is cut back to its last closed document.

    Returns the trimmed page only when it is still a closed document; otherwise an
    empty string, so the caller can say it could not be trimmed safely.
    """

    if len(html) <= limit:
        return html, False
    head = html[:limit]
    matches = list(_CLOSING.finditer(head))
    if not matches:
        return "", True
    return head[: matches[-1].end()], True
