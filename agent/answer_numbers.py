"""Numbers in an answer: where they repeat (A1) and whether the data had them (A2).

Both jobs read the same thing, a number out of prose, so they share one reader.
Neither asks the model anything. The shape rules decide what a skimming reader
sees once; the check decides whether a figure may be shown at all, from the
rows the queries returned.

A NUMBER, HERE, IS A QUANTITY. A digit that touches a letter, an underscore or a
dot is part of a name (`v2`, `gold_2024`, `3.5.1`), not a count. An abbreviation
(`9.98M`, `12k`) is a number when it carries a decimal or two or more
significant digits; `10M` and `2k` have one, and are too coarse to compare (and
`Contoso` is, more often than not, a game title).
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

_MULTIPLIER = {
    "k": 1e3,
    "thousand": 1e3,
    "m": 1e6,
    "million": 1e6,
    "b": 1e9,
    "bn": 1e9,
    "billion": 1e9,
}

_NUMBER = re.compile(
    r"(?<![A-Za-z0-9_.])"
    r"(?P<digits>\d{1,3}(?:,\d{3})+|\d+)(?P<fraction>\.\d+)?"
    r"(?:(?P<suffix>\s?(?:thousand|million|billion)\b|(?:bn|[kKmMbB])(?![A-Za-z0-9_])))?"
    r"(?P<percent>\s?%)?"
    r"(?![A-Za-z0-9_])(?!\.\d)",
    re.IGNORECASE,
)

#: Numbers read out of evidence: anything that looks like a number, glued or not,
#: because a row cell sits inside a table, a JSON value or a date.
_LOOSE = re.compile(r"\d[\d,]*(?:\.\d+)?")

YEAR_RANGE = (1900, 2099)
CHECK_FLOOR = 100
_SENTENCES = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9*\-])")
_BOLD = re.compile(r"\*\*[^*]+\*\*")
_DASH = re.compile(r"\s[-\u2013\u2014]\s")


@dataclass(frozen=True)
class Quantity:
    """One number read out of text."""

    text: str
    value: float
    abbreviated: bool = False
    significant: int = 0
    percent: bool = False
    decimal: bool = False

    @property
    def comparable(self) -> bool:
        """Whether two texts repeating this number is something worth acting on."""

        if self.percent:
            return False
        if self.abbreviated:
            return self.significant >= 2
        return self.value >= 100 or self.decimal


def _significant(mantissa: str) -> int:
    digits = mantissa.replace(",", "").replace(".", "").lstrip("0").rstrip("0")
    return len(digits)


def quantities(text: str) -> list[Quantity]:
    found: list[Quantity] = []
    for match in _NUMBER.finditer(text or ""):
        digits = match.group("digits").replace(",", "")
        fraction = match.group("fraction") or ""
        suffix = (match.group("suffix") or "").strip().lower()
        mantissa = digits + fraction
        value = float(mantissa)
        abbreviated = bool(suffix)
        if abbreviated:
            value *= _MULTIPLIER[suffix]
        found.append(
            Quantity(
                text=match.group(0).strip(),
                value=value,
                abbreviated=abbreviated,
                significant=_significant(mantissa) if abbreviated else 0,
                percent=bool(match.group("percent")),
                decimal=bool(fraction) and not abbreviated,
            )
        )
    return found


def _rounded(value: float, digits: int) -> tuple[float, float]:
    """`value` cut and rounded to `digits` significant digits."""

    if value <= 0 or digits < 1:
        return value, value
    scale = 10 ** (math.floor(math.log10(value)) - digits + 1)
    scaled = value / scale
    return math.floor(scaled + 1e-9) * scale, round(scaled) * scale


def repeats(quantity: Quantity, others: Iterable[Quantity]) -> bool:
    """Whether `others` already carry this number, under any rounding."""

    for other in others:
        if not other.comparable:
            continue
        if _same(quantity, other):
            return True
    return False


def _same(left: Quantity, right: Quantity) -> bool:
    if math.isclose(left.value, right.value, rel_tol=1e-9, abs_tol=1e-9):
        return True
    for short, full in ((left, right), (right, left)):
        if short.abbreviated and short.significant >= 2 and not full.abbreviated:
            cut, rounded = _rounded(full.value, short.significant)
            if any(math.isclose(short.value, c, rel_tol=1e-6) for c in (cut, rounded)):
                return True
    return False


# ---------------------------------------------------------------------------
# A1: one number, once
# ---------------------------------------------------------------------------


def has_table(content: str) -> bool:
    return any(line.lstrip().startswith("|") for line in content.splitlines())


def trimmed_takeaway(takeaway: str) -> str:
    """Cut a takeaway at the first ": " or spaced dash after its bold figure."""

    bold = _BOLD.search(takeaway)
    if bold is None:
        return takeaway
    tail = takeaway[bold.end() :]
    cuts = [m.start() for m in (re.search(r":\s", tail), _DASH.search(tail)) if m]
    if not cuts:
        return takeaway
    cut = min(cuts)
    return (takeaway[: bold.end()] + tail[:cut]).rstrip(" ,;")


def _repeated(sentence: str, held: Sequence[Quantity], table: bool) -> bool:
    own = [q for q in quantities(sentence) if q.comparable]
    if not own:
        return False
    flags = [repeats(q, held) for q in own]
    return any(flags) if table else all(flags)


def without_repeated_numbers(narrative: str, *, takeaway: str, content: str, table: bool) -> str:
    """Drop narrative sentences and bullets that say again what was already said.

    Beside a table, a sentence goes if ANY of its comparable numbers repeats a
    takeaway or content number; without one, only if ALL of them do. A line that
    ends in a colon and whose list was dropped goes too.
    """

    held = quantities(takeaway) + quantities(content)
    out: list[str] = []
    for line in narrative.split("\n"):
        stripped = line.strip()
        if not stripped:
            out.append("")
            continue
        bullet = stripped.startswith(("-", "*", "+")) or bool(re.match(r"\d+[.)]\s", stripped))
        if bullet:
            if _repeated(stripped, held, table):
                continue
            out.append(line)
            continue
        sentences = _SENTENCES.split(stripped)
        kept = [x for x in sentences if not _repeated(x, held, table)]
        if not kept:
            continue
        text = " ".join(kept)
        out.append(text)
    # A colon line left with no list under it.
    for index, line in enumerate(out):
        if line.endswith(":") and not any(x.strip() for x in out[index + 1 :][:1]):
            out[index] = ""
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def figure_numbers(display: str, value: float) -> list[Quantity]:
    found = quantities(display)
    if not found:
        found = [Quantity(text=str(value), value=float(value), decimal=float(value) % 1 != 0)]
    return found


def figure_repeats(figure_display: str, figure_value: float, held: Sequence[Quantity]) -> bool:
    return any(repeats(q, held) for q in figure_numbers(figure_display, figure_value))


# ---------------------------------------------------------------------------
# A2: the data had it
# ---------------------------------------------------------------------------


def evidence_values(texts: Iterable[str]) -> list[float]:
    """Every number the queries returned, raw and as it might be rounded for display."""

    values: set[float] = set()
    for text in texts:
        for match in _LOOSE.finditer(text or ""):
            try:
                value = float(match.group(0).replace(",", "").rstrip(","))
            except ValueError:
                continue
            values.add(value)
            if value % 1:
                values.add(float(math.floor(value)))
                values.add(float(round(value)))
    return sorted(values)


def checkable(quantity: Quantity) -> bool:
    """Whole numbers of 100 or more, and abbreviations of them.

    Decimals, shares, small integers and years are not checked: a share is
    derived, a year is a label, and a small integer is as likely a count of rows
    as a measure.
    """

    if quantity.percent or quantity.decimal:
        return False
    if quantity.abbreviated and quantity.significant < 2:
        return False
    if quantity.value < CHECK_FLOOR:
        return False
    if (
        not quantity.abbreviated
        and quantity.value == int(quantity.value)
        and YEAR_RANGE[0] <= quantity.value <= YEAR_RANGE[1]
    ):
        return False
    return True


def supported(quantity: Quantity, values: Sequence[float]) -> bool:
    if not quantity.abbreviated:
        return any(math.isclose(quantity.value, v, rel_tol=1e-9, abs_tol=0.5) for v in values)
    for value in values:
        cut, rounded = _rounded(value, quantity.significant)
        if any(math.isclose(quantity.value, c, rel_tol=1e-6) for c in (cut, rounded)):
            return True
    return False


def unmatched(text: str, values: Sequence[float]) -> list[str]:
    """The checkable numbers in `text` that no returned value supports."""

    missing: list[str] = []
    for quantity in quantities(text):
        if checkable(quantity) and not supported(quantity, values):
            if quantity.text not in missing:
                missing.append(quantity.text)
    return missing


def figure_unmatched(display: str, value: float, values: Sequence[float]) -> str:
    """The display of a card whose number the data does not hold, else ""."""

    candidates = quantities(display)
    for quantity in candidates:
        if checkable(quantity) and not supported(quantity, values):
            return display
    if not candidates:
        whole = Quantity(text=display, value=float(value), decimal=float(value) % 1 != 0)
        if checkable(whole) and not supported(whole, values):
            return display
    return ""
