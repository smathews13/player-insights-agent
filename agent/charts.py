"""The `new_plot` tool: renderer-neutral chart specifications built from query results.

The model decides *what* to plot and supplies a small semantic chart contract. This
module validates that contract, adapts it to Plotly, and owns the DuBois palette and
layout defaults. The app renders the resulting spec with Plotly.js in the browser.

Legacy Plotly `data` and `layout` arguments remain accepted at the adapter boundary so
stored prompts and compatible endpoints keep working. They are an implementation detail,
not the semantic condition for a completed answer.

Nothing here knows what the data is about. Series names, axis titles, categories and
units all arrive from the model, which reads them off the result set, so the tool
survives the dataset being replaced underneath it.

`grid` and `updatemenus` are refused: one panel per chart keeps a chat answer
readable and keeps the client's rendering surface small enough to test.
"""

from __future__ import annotations

import re
from typing import Any

from contracts import Chart

# --------------------------------------------------------------------------------------
# Palette
#
# The Databricks DuBois palette, mirroring the token names the client defines in
# client/src/styles/tokens.css so a chart cannot drift away from the surface it sits on.
# The names in the comments are the CSS custom properties a reader can go and look up
# there: `--chart-1`..`--chart-4` and `--chart-emphasis` are the chart contract, and the
# `--db-*` primitives behind them say which meaning each hue carries elsewhere in the app.
#
# DuBois rations colour by meaning, and a chart obeys the same rationing as a badge does.
# Blue is action and identity, so it is the ordinary bar and the first series; orange is
# "the one being pointed at"; red is failure; amber is evaluation. That is why the retired
# brand red is gone from here rather than merely restyled: red as the default series made
# every ordinary breakdown read as an error.
#
# Two lists, because a colour that works as a filled mass does not necessarily work as a
# one-pixel stroke:
#
#   FILL_SERIES   bars, pie slices, histogram bins, box bodies.
#   STROKE_SERIES lines and markers. EVERY ENTRY CLEARS 3:1 AGAINST WHITE (WCAG's
#                 non-text minimum). All four palette hues clear it, so the two lists
#                 share their first four entries; amber (1.90:1) is not in either.
# --------------------------------------------------------------------------------------

INK = "#161616"  # --db-ink: text on the figure, and the outline drawn around a pale fill
SLATE = "#6F6F6F"  # --db-slate: axis and tick labels
LINE = "#EBEBEB"  # --db-line: gridlines, axis lines, hover-label border, bar tracks

BLUE = "#2272B4"  # --chart-1 / --db-blue-600: the primary series and every ordinary bar
TEAL = "#04867D"  # --chart-2: second series
BLUE_LIGHT = "#4299E0"  # --chart-3 / --db-blue-500: third series
GREY_BLUE = "#445461"  # --chart-4 / --db-grey-blue: fourth series

# --chart-emphasis / --db-orange. One datum per figure, the leader in a ranking: it means
# "this is the one being pointed at", so a second use says nothing and a whole series in
# it says less than nothing. Never auto-assigned, never a line: DuBois allows orange as a
# filled mass only. `_paint` demotes every other use of it back to the series colour.
EMPHASIS = "#FF3621"

# Reserved meanings. No figure builder here expresses failure or evaluation today, so
# these are unused by the code and are written down for the case where one does: the value
# to use, and the form it is allowed to take.
RED_FAILURE = "#C82D4C"  # --db-red-600: failure or destruction, and nothing else
AMBER = "#FFAB00"  # --db-amber: evaluation, AS A FILLED MASS ONLY — never text, never 1px
AMBER_DEEP = "#93320B"  # --db-amber-deep: what evaluation uses as text or as a 1px edge

# Slow and outlier values are carried by weight rather than hue — full-strength colour and
# a thicker bar. There is no pale "slow" colour here on purpose, and amber is not it.

# Tints, so that a chart with more series than the palette has colours still separates
# them. Each is a literal sRGB composite of its base over white, written out so contrast is
# checked against the exact value rather than whatever a mix function returns.
#
# The weights differ per base, which they did in the retired palette too, but for a new
# reason: three of the four hues are blues, so tinting them all by the same amount
# collapses the two pale blues into one another. `--chart-3` is already the light blue, so
# it is taken furthest from its base. At these weights no pair in FILL_SERIES is closer
# than `--chart-1` and `--chart-3` already are in the token file (CIE76 dE 15.0), which is
# as separable as this palette can be made without inventing a hue DuBois does not have.
_BLUE_TINT = "#91B9DA"  # --chart-1 at 50% over white
_TEAL_TINT = "#8EC9C5"  # --chart-2 at 45% over white
_BLUE_LIGHT_TINT = "#C6E0F6"  # --chart-3 at 30% over white
_GREY_BLUE_TINT = "#A2AAB0"  # --chart-4 at 50% over white

FILL_SERIES = (
    BLUE,
    TEAL,
    BLUE_LIGHT,
    GREY_BLUE,
    _BLUE_TINT,
    _TEAL_TINT,
    _BLUE_LIGHT_TINT,
    _GREY_BLUE_TINT,
)
STROKE_SERIES = (BLUE, TEAL, BLUE_LIGHT, GREY_BLUE)

# Past four series, colour alone stops separating lines reliably, so the stroke pattern
# carries the difference instead of inventing more palette colours.
_DASHES = ("solid", "dash", "dot", "dashdot")

# Contrast floor for a stroke, a marker, or the outline drawn around a pale fill.
_MIN_STROKE_CONTRAST = 3.0

# --------------------------------------------------------------------------------------
# Type
#
# Both faces are served by the app itself (client/public/fonts, wired up in
# client/src/styles/fonts.css), so naming them here resolves in the browser rather than
# reaching for a CDN the deployment forbids. Each keeps a real fallback stack, the same one
# `tokens.css` uses: a figure that silently falls back to a proportional face loses the
# digit alignment the mono column exists for, and nothing on the page says so.
#
# Labels are set in the sans face; numerals and identifiers — tick values, tooltips, the
# value beside a bar — in the mono one.
# --------------------------------------------------------------------------------------

FONT_SANS = "'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
FONT_MONO = "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace"

# --------------------------------------------------------------------------------------
# Label geometry
#
# Two rules, and both of them are about the same thing: a label is only worth drawing if
# it has somewhere to sit. The category names and the slice shares arrive from the result
# set, so neither rule may assume anything about how long a name is or how small a share
# gets. What they can do is bound the space a label is allowed to ask for.
# --------------------------------------------------------------------------------------

#: Characters on one line of a wrapped tick label.
#:
#: Plotly reads `<br>` in a tick label as a line break, so a long category name can be a
#: short block of text instead of one long string. That is what lets Plotly keep the axis
#: horizontal at all: it measures the drawn text and rotates only as far as it has to, and
#: a name broken over lines is a quarter of the width it was.
TICK_LINE_CHARS = 14

#: Lines one tick label may occupy.
#:
#: The point of the cap is that the height the axis reserves is bounded by the layout
#: rather than by the longest name in the result set. Three lines of `TICK_LINE_CHARS`
#: holds every title in the current dataset without cutting anything.
TICK_LINE_LIMIT = 3

#: What a cut label ends with. One character, because it is competing for the same line.
ELLIPSIS = "\u2026"

#: The share of the total a pie slice needs before its label is drawn on the figure.
#:
#: Plotly puts every outside label at its slice's mid-angle and then pushes colliding
#: labels apart, drawing a leader line to cover the distance it moved them. A slice needs
#: roughly two label line-heights of arc for its label to sit where the slice is: on a pie
#: sized for this card that is about 4% of the total, so 5% is the round number above it.
#: Under that, several slivers share a mid-angle, every label starts in the same place, and
#: the result is the pile of crossing leader lines rather than a set of labels.
#:
#: Nothing is lost by not drawing one. Every slice is in the legend, and the tooltip
#: carries the label, the value and the share.
MIN_PIE_LABEL_SHARE = 0.05

#: Slices past which a pie stops being the honest shape for a part-of-whole split.
#:
#: Used in the brief below and nowhere in the code, and that is the point: which shape fits
#: a result set is the model's call, made while it can still see the numbers. This module
#: renders a pie with slivers as well as it can rather than refusing it, because a refusal
#: at this stage is not a bar chart, it is no chart at all.
MAX_PIE_SLICES = 6

# --------------------------------------------------------------------------------------
# Limits
#
# A chart spec is persisted as JSONB alongside the answer and shipped to the browser, so
# it is bounded here rather than trusted. These are generous for a chat answer and small
# enough that a runaway spec cannot bloat a conversation row.
# --------------------------------------------------------------------------------------

MAX_TRACES = 12
MAX_POINTS_PER_TRACE = 2_000

#: Charts one answer may carry. A product limit: a chat answer with more panels than
#: this is scrolled past rather than read. Interpolated into the brief below, so the
#: number the model is asked for and the number the code enforces stay the same.
MAX_CHARTS = 2

# `line` is not a Plotly trace type, but it is the single most common thing a model emits
# for a line chart, so it is translated instead of rejected.
_TRACE_ALIASES = {"line": "scatter", "scattergl": "scatter"}
SUPPORTED_TRACE_TYPES = frozenset({"bar", "scatter", "histogram", "pie", "box"})

_FILL_TRACE_TYPES = frozenset({"bar", "histogram", "pie", "box"})

_UNSUPPORTED_LAYOUT_KEYS = {
    "grid": "grid (multi-panel dashboard)",
    "updatemenus": "updatemenus (dropdown)",
}


class ChartError(ValueError):
    """A spec `new_plot` will not render. The message is written for the model to act on."""


class EmptyChartError(ChartError):
    """A spec with nothing on the axes: no traces, or traces carrying no points.

    A SUBCLASS rather than a message a caller reads back, because the two empty
    cases are not the same event as a malformed spec and must not be badged like
    one. A model that has decided there is nothing to draw still has to call the
    tool it was given -- `data` is required -- so it sends `data: []`, and that
    arrived in the trace as a renderer-specific validation error under an amber
    step, which reads as a chart that broke rather than a dataset that held no
    series. Callers treat this as a decline; every other `ChartError` stays a
    rejection.

    THE MESSAGE IS THE SENTENCE THE READER GETS, so these two read as accounts of
    what happened rather than as instructions to whoever sent the spec. The
    rejection messages are the other way round -- they name what the spec must be
    -- because that is a fault report and this is not. A decline whose text was
    still a renderer-specific demand put the validator in front of a reader
    whose answer was fine, and that sentence is the one they had already learnt
    to read as a breakage.

    A WRONG SHAPE IS NOT AN EMPTY ONE. A dict or a JSON string in the legacy `data`
    slot is a rejection, not a decline. `None` is the established no-chart sentinel.
    """


def _relative_luminance(colour: str) -> float:
    match = re.fullmatch(r"#([0-9a-fA-F]{6})", colour.strip())
    if not match:
        raise ValueError(f"not a six-digit hex colour: {colour!r}")
    digits = match.group(1)
    channels = []
    for index in (0, 2, 4):
        value = int(digits[index : index + 2], 16) / 255
        channels.append(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4)
    red, green, blue = channels
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_on_white(colour: str) -> float:
    """WCAG contrast ratio of `colour` against white, or 0.0 for anything unparseable.

    An unparseable value scores 0 so it fails every legibility check and gets replaced,
    rather than being passed through on the strength of not being understood.
    """

    try:
        return 1.05 / (_relative_luminance(colour) + 0.05)
    except ValueError:
        return 0.0


def _is_legible_stroke(colour: Any) -> bool:
    if not isinstance(colour, str) or contrast_on_white(colour) < _MIN_STROKE_CONTRAST:
        return False
    # Orange clears the contrast floor and is still not a line: DuBois allows it as a
    # filled mass only, so it must not survive as a stroke on the strength of being legible.
    return not _is_emphasis(colour)


def _is_emphasis(colour: Any) -> bool:
    return isinstance(colour, str) and colour.strip().lower() == EMPHASIS.lower()


def _spend_emphasis(colours: list[Any], budget: int, series: str) -> tuple[list[Any], int]:
    """Allow at most `budget` emphasised points in one per-point colour list.

    Orange means "this is the one being pointed at". Two orange bars point at nothing, so
    a list carrying more than one loses all of them rather than the code picking a winner
    the model never named. `budget` is per figure, not per trace, for the same reason.
    """

    marked = [index for index, colour in enumerate(colours) if _is_emphasis(colour)]
    if not marked:
        return colours, budget
    keep = len(marked) == 1 and budget >= 1
    if keep:
        return colours, budget - 1
    return [series if index in marked else colour for index, colour in enumerate(colours)], budget


def _trace_type(trace: dict[str, Any]) -> str:
    declared = str(trace.get("type") or "scatter").strip().lower()
    return _TRACE_ALIASES.get(declared, declared)


def _point_count(trace: dict[str, Any]) -> int:
    lengths = [
        len(value)
        for key in ("x", "y", "values", "labels")
        if isinstance(value := trace.get(key), list)
    ]
    return max(lengths) if lengths else 0


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge `override` over `base`. Anything the model set wins."""

    merged = dict(base)
    for key, value in override.items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[key] = _merge(existing, value)
        else:
            merged[key] = value
    return merged


def _title_text(value: Any) -> str:
    if isinstance(value, dict):
        text = value.get("text")
        return text.strip() if isinstance(text, str) else ""
    return value.strip() if isinstance(value, str) else ""


def _validate(data: Any, layout: dict[str, Any]) -> list[dict[str, Any]]:
    # A LIST THAT IS EMPTY AND A THING THAT IS NOT A LIST ARE DIFFERENT EVENTS, and
    # they used to share this line and this message. `data: []` is a model with
    # nothing to draw obeying a required argument, which is a decline. Anything
    # else in that slot -- a dict or a JSON string of a list -- is a spec in
    # the wrong shape, which is a fault worth seeing: reported as a decline it
    # would be filed as "the data held no series" and nobody would ever look for
    # the serialization bug behind it. The step's amber no longer reaches the run's
    # verdict (shared/run-verdict.ts), so there is no longer any reason to soften
    # this to keep a correct answer from reading as a broken one.
    if not isinstance(data, list):
        raise ChartError(
            f"`data` must be a list of chart series objects, and arrived as {type(data).__name__}."
        )
    if not data:
        raise EmptyChartError("the plotting step sent no traces, so there was nothing to draw")
    if len(data) > MAX_TRACES:
        raise ChartError(
            f"{len(data)} traces is more than one panel can carry; "
            f"send at most {MAX_TRACES}, or split this into separate charts."
        )
    for key, description in _UNSUPPORTED_LAYOUT_KEYS.items():
        if layout.get(key):
            raise ChartError(
                f"{description} is not supported: one panel per chart. "
                "Call new_plot once per chart instead of combining them."
            )

    traces: list[dict[str, Any]] = []
    for trace in data:
        if not isinstance(trace, dict):
            raise ChartError("Every entry in `data` must be a chart series object.")
        traces.append(dict(trace))

    unsupported = sorted({_trace_type(t) for t in traces} - SUPPORTED_TRACE_TYPES)
    if unsupported:
        raise ChartError(
            f"trace type(s) {unsupported} cannot be rendered "
            f"(supported: {sorted(SUPPORTED_TRACE_TYPES)})."
        )
    for trace in traces:
        count = _point_count(trace)
        if count > MAX_POINTS_PER_TRACE:
            raise ChartError(
                f"a trace carries {count:,} points, over the {MAX_POINTS_PER_TRACE:,} limit; "
                "aggregate the result set before plotting it."
            )
    if not any(_point_count(trace) for trace in traces):
        raise EmptyChartError("no trace carried any data points, so there was nothing to draw")
    return traces


def _semantic_spec(spec: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Translate the renderer-neutral chart contract into Plotly at the last boundary."""

    if not isinstance(spec, dict):
        raise ChartError("The chart specification must be an object.")

    kind = str(spec.get("kind") or "").strip().lower()
    if kind not in {"bar", "line", "scatter", "histogram", "pie", "box"}:
        raise ChartError("The chart specification names an unsupported chart kind.")

    series = spec.get("series")
    if not isinstance(series, list):
        raise ChartError("The chart specification must include a series list.")
    if not series:
        raise EmptyChartError("the chart recommendation contained no series")

    traces: list[dict[str, Any]] = []
    for item in series:
        if not isinstance(item, dict):
            raise ChartError("Each chart series must be an object.")
        trace: dict[str, Any] = {}
        name = item.get("name")
        if isinstance(name, str) and name.strip():
            trace["name"] = name.strip()

        if kind in {"bar", "line", "scatter"}:
            if not isinstance(item.get("x"), list) or not isinstance(item.get("y"), list):
                raise ChartError(f"Each {kind} series must include x and y lists.")
            trace.update({"type": "scatter" if kind in {"line", "scatter"} else "bar"})
            trace.update({"x": item["x"], "y": item["y"]})
            if kind == "line":
                trace["mode"] = "lines"
            elif kind == "scatter":
                trace["mode"] = "markers"
        elif kind == "pie":
            if not isinstance(item.get("labels"), list) or not isinstance(item.get("values"), list):
                raise ChartError("Each pie series must include labels and values lists.")
            trace.update({"type": "pie", "labels": item["labels"], "values": item["values"]})
        else:
            values = item.get("values")
            if not isinstance(values, list):
                raise ChartError(f"Each {kind} series must include a values list.")
            trace.update({"type": kind, "x" if kind == "histogram" else "y": values})
        traces.append(trace)

    layout: dict[str, Any] = {}
    x_title = spec.get("x_title")
    y_title = spec.get("y_title")
    if isinstance(x_title, str) and x_title.strip():
        layout["xaxis"] = {"title": {"text": x_title.strip()}}
    if isinstance(y_title, str) and y_title.strip():
        layout["yaxis"] = {"title": {"text": y_title.strip()}}
    stacking = str(spec.get("stacking") or "").strip().lower()
    if stacking:
        if kind != "bar" or stacking not in {"group", "stack", "relative"}:
            raise ChartError("The chart specification uses an unsupported stacking mode.")
        layout["barmode"] = stacking
    return traces, layout


def _paint(traces: list[dict[str, Any]]) -> None:
    """Assign the DuBois palette in place, one series at a time.

    A colour the model supplied is respected where it can be: per-point colour lists
    and scalar colours on a fill. There are two overrides. A scalar colour too pale to
    read as a stroke or marker is replaced, because an invisible line is a wrong chart
    reported as a successful one. And the emphasis orange is held to one datum per
    figure, because a colour that means "this one" stops meaning anything the moment it
    is used as a series colour.
    """

    emphasis_budget = 1

    for index, trace in enumerate(traces):
        kind = _trace_type(trace)
        trace["type"] = kind
        marker = dict(trace.get("marker") or {})

        if kind == "pie":
            # Pie colours are per slice, not per series, so the palette spans the trace.
            slices = max(_point_count(trace), 1)
            supplied_slices = marker.get("colors")
            if isinstance(supplied_slices, list):
                # A ranked bar has a leader; a part-of-whole split does not, so orange
                # here is decoration and goes back to the palette.
                marker["colors"] = [
                    FILL_SERIES[i % len(FILL_SERIES)] if _is_emphasis(colour) else colour
                    for i, colour in enumerate(supplied_slices)
                ]
            else:
                marker["colors"] = [FILL_SERIES[i % len(FILL_SERIES)] for i in range(slices)]
            # White, so adjacent slices separate from each other rather than from the card.
            outline = dict(marker.get("line") or {})
            outline.setdefault("color", "#ffffff")
            outline.setdefault("width", 1)
            marker["line"] = outline
            trace["marker"] = marker
            trace.setdefault("textinfo", "label+percent")
            _label_the_slices_with_room(trace)
            # The share as well as the value, because a slice under the label threshold
            # has its percentage nowhere else.
            trace.setdefault("hovertemplate", "%{label}<br>%{value:,} (%{percent})<extra></extra>")
            continue

        if kind in _FILL_TRACE_TYPES:
            colour = FILL_SERIES[index % len(FILL_SERIES)]
            supplied = marker.get("color")
            if isinstance(supplied, list):
                # Per-point colouring: the model highlighting one bar, which is a meaning
                # rather than a default. Only the emphasis budget is policed.
                marked, emphasis_budget = _spend_emphasis(supplied, emphasis_budget, colour)
                marker["color"] = marked
            elif isinstance(supplied, str) and supplied and not _is_emphasis(supplied):
                colour = supplied
            else:
                # A scalar orange is a whole series painted in the pointing colour.
                marker["color"] = colour
            # A pale fill needs an edge or it disappears into the card. The tints are
            # legitimate fills precisely because this outline exists.
            if not isinstance(marker.get("color"), list) and not _is_legible_stroke(
                marker.get("color")
            ):
                outline = dict(marker.get("line") or {})
                outline.setdefault("color", INK)
                outline.setdefault("width", 1)
                marker["line"] = outline
            trace["marker"] = marker
            _label_off_the_fill(trace, kind)
            continue

        # scatter: a line, a set of markers, or both.
        colour = STROKE_SERIES[index % len(STROKE_SERIES)]
        stroke = dict(trace.get("line") or {})
        supplied = stroke.get("color") or marker.get("color")
        if _is_legible_stroke(supplied):
            colour = str(supplied)
        stroke["color"] = colour
        stroke.setdefault("width", 2)
        if index >= len(STROKE_SERIES):
            stroke.setdefault("dash", _DASHES[(index // len(STROKE_SERIES)) % len(_DASHES)])
        trace["line"] = stroke
        marker["color"] = colour
        marker.setdefault("size", 6)
        trace["marker"] = marker
        trace.setdefault("mode", "lines+markers")
        if trace.get("fill") and trace["fill"] != "none":
            trace.setdefault("fillcolor", _rgba(colour, 0.14))


def _pie_shares(values: Any) -> list[float] | None:
    """Each slice's share of the total, or `None` if the values will not add up.

    `None` rather than a guess: a share that cannot be computed must not be treated as a
    small one, or a spec this module does not understand loses its labels silently.
    """

    if not isinstance(values, list) or not values:
        return None
    magnitudes: list[float] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        magnitudes.append(abs(float(value)))
    total = sum(magnitudes)
    if total <= 0:
        return None
    return [magnitude / total for magnitude in magnitudes]


def _label_the_slices_with_room(trace: dict[str, Any]) -> None:
    """Give an inline label to the slices that can hold one, and only to those.

    `textposition` is set rather than defaulted for the same reason it always was: outside
    the slice, never on it, because a percentage printed over a fill is the one thing the
    chart-card rules forbid outright. What is new is that it can be a list, which is how
    Plotly is told to skip a label per slice. A slice under `MIN_PIE_LABEL_SHARE` gets
    `none`: no text, and so no leader line either.

    `automargin` lets the labels that are drawn push the figure's margins out to fit them,
    which is the other half of the rule. Without it Plotly draws them at the edge of the
    plot area and the card clips whatever sticks out.
    """

    trace["automargin"] = True
    shares = _pie_shares(trace.get("values"))
    if shares is None or all(share >= MIN_PIE_LABEL_SHARE for share in shares):
        trace["textposition"] = "outside"
        return
    trace["textposition"] = [
        "outside" if share >= MIN_PIE_LABEL_SHARE else "none" for share in shares
    ]


def _line_chunks(text: str) -> list[str]:
    """`text` as pieces no wider than one line, splitting a word only when it is that wide."""

    pieces: list[str] = []
    for word in text.split():
        while len(word) > TICK_LINE_CHARS:
            pieces.append(word[:TICK_LINE_CHARS])
            word = word[TICK_LINE_CHARS:]
        if word:
            pieces.append(word)
    return pieces


def wrap_tick_label(text: str) -> tuple[str, bool]:
    """`text` broken over at most `TICK_LINE_LIMIT` lines, and whether anything was cut.

    Words first, so a name breaks where a reader would break it. A word wider than the
    line is split anyway, because one word cannot be allowed to set the width of the axis.
    """

    pieces = _line_chunks(text)
    if not pieces:
        return text, False
    lines: list[str] = []
    for piece in pieces:
        if lines and len(lines[-1]) + 1 + len(piece) <= TICK_LINE_CHARS:
            lines[-1] = f"{lines[-1]} {piece}"
        else:
            lines.append(piece)
    if len(lines) <= TICK_LINE_LIMIT:
        return "<br>".join(lines), False
    kept = lines[:TICK_LINE_LIMIT]
    kept[-1] = kept[-1][: max(TICK_LINE_CHARS - 1, 1)].rstrip() + ELLIPSIS
    return "<br>".join(kept), True


def _wrap_category_ticks(traces: list[dict[str, Any]]) -> None:
    """Break long category names over lines, so the axis is not a diagonal of full titles.

    A rotation angle is not a policy: whatever angle is picked, a long enough name still
    sprawls and a short enough one is tilted for nothing. Wrapping is a policy, because it
    bounds the height the axis can ask for no matter what the names turn out to be, and it
    leaves the angle to Plotly, which is the only thing that can measure the drawn text.

    The x axis of a vertical figure only. A horizontal bar reads its categories down the
    left, where the constraint is width rather than height and where a three-line label
    would be taller than the row it names.
    """

    if any(str(t.get("orientation") or "").lower() == "h" for t in traces):
        return
    for trace in traces:
        if _trace_type(trace) == "pie":
            continue
        values = trace.get("x")
        if not isinstance(values, list):
            continue
        wrapped: list[Any] = []
        cut = False
        for value in values:
            if not isinstance(value, str):
                wrapped.append(value)
                continue
            text, truncated = wrap_tick_label(value)
            wrapped.append(text)
            cut = cut or truncated
        if wrapped == values:
            continue
        # Two different names must never wrap to the same tick: that would merge their
        # bars into one category and report it as a chart. If a cut would do that, the
        # axis keeps the full names and Plotly rotates them, which is ugly but true.
        if len({str(value) for value in wrapped}) != len({str(value) for value in values}):
            continue
        if cut:
            # The axis no longer carries the whole name, so the tooltip has to.
            trace.setdefault("hovertext", list(values))
        trace["x"] = wrapped


def _label_off_the_fill(trace: dict[str, Any], kind: str) -> None:
    """Move any value labels the model attached outside the bar, and set them in mono.

    A value is never printed on top of a fill: it sits in its own column or beside the
    bar. Plotly's default for bar text is `auto`, which puts it inside whenever it fits,
    so the position is overridden rather than defaulted — the rule is not a preference.
    Box plots have no printed text and are left alone.
    """

    if kind not in {"bar", "histogram"}:
        return
    if trace.get("text") is None and not trace.get("texttemplate"):
        return
    trace["textposition"] = "outside"
    trace.setdefault("textfont", {"family": FONT_MONO, "size": 12, "color": INK})


def _rgba(colour: str, alpha: float) -> str:
    digits = colour.lstrip("#")
    red, green, blue = (int(digits[i : i + 2], 16) for i in (0, 2, 4))
    return f"rgba({red}, {green}, {blue}, {alpha})"


def _axis_defaults(traces: list[dict[str, Any]]) -> dict[str, Any]:
    shared = {
        "gridcolor": LINE,
        "zerolinecolor": LINE,
        "linecolor": LINE,
        # Ticks are mostly numerals, and the design sets them in the mono face so digits
        # line up down the axis the way they do in the value column beside a bar.
        "tickfont": {"family": FONT_MONO, "color": SLATE, "size": 11},
        "automargin": True,
    }
    horizontal = any(str(t.get("orientation") or "").lower() == "h" for t in traces)
    value_axis, category_axis = ("xaxis", "yaxis") if horizontal else ("yaxis", "xaxis")
    return {
        category_axis: dict(shared, showgrid=False),
        # Audience counts: thousands separators read far better than 8.413k.
        value_axis: dict(shared, showgrid=True, tickformat=","),
    }


#: The figure's padding, and nothing else.
#:
#: Not the space the labels need. Every axis here sets `automargin`, and a pie sets it per
#: trace, which makes Plotly measure the drawn tick text, axis titles and slice labels and
#: grow the margin to hold them. A hardcoded number for that job is a number that is wrong
#: for the next result set, and the failure mode is a clipped label rather than a warning.
_PADDING = {"l": 8, "r": 8, "t": 8, "b": 8}


def _legend(cartesian: bool) -> dict[str, Any]:
    """Where the legend goes, and why it cannot land on the tick labels.

    Plotly resolves several components asking for the same figure edge to the largest of
    their requests rather than to their sum. A legend placed below the plot in plot
    coordinates and a row of tick labels below the plot are two such components, so they
    are handed the same strip of the figure and drawn on top of each other. Longer names
    make it worse, not better: the axis takes more of the strip and the legend, positioned
    as a fraction of a plot area that just got shorter, moves further into it.

    Anchoring the legend to the figure's own edge instead of the plot area's takes it out
    of that negotiation. Plotly reserves a band at the edge for it, subtracts the band
    before the axis measures anything, and then adds whatever the axis asks for on top. The
    two bands stack rather than compete, at any label length, which is the property worth
    having here: it does not depend on how long a title is or how many series there are.
    """

    font = {"family": FONT_SANS, "color": INK, "size": 11}
    if cartesian:
        # Above the plot. The categories run along the bottom and the values up the left,
        # so the top is the one edge no tick label can reach.
        return {
            "orientation": "h",
            "xref": "paper",
            "x": 0,
            "xanchor": "left",
            "yref": "container",
            "y": 1,
            "yanchor": "top",
            "font": font,
        }
    # A pie, where the legend carries every slice, including the ones too small to label on
    # the figure. Down the right rather than under the chart: the card is far wider than it
    # is tall, so the pie's diameter is capped by its height and width is the cheap
    # direction to spend. One entry per row is also the only way a long title is readable.
    return {
        "orientation": "v",
        "xref": "container",
        "x": 1,
        "xanchor": "right",
        "yref": "paper",
        "y": 0.5,
        "yanchor": "middle",
        "font": font,
    }


def _base_layout(traces: list[dict[str, Any]]) -> dict[str, Any]:
    cartesian = all(_trace_type(t) != "pie" for t in traces)
    layout: dict[str, Any] = {
        # Transparent, so the chart inherits whatever card it is rendered inside.
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(0,0,0,0)",
        "font": {"family": FONT_SANS, "color": INK, "size": 12},
        "margin": dict(_PADDING),
        "showlegend": len(traces) > 1 or _trace_type(traces[0]) == "pie",
        "legend": _legend(cartesian),
        "hoverlabel": {
            "bgcolor": "#ffffff",
            "bordercolor": LINE,
            # A tooltip is a series name and a number; the number is the reason anyone
            # opened it, so the whole label is set in the mono face.
            "font": {"family": FONT_MONO, "color": INK, "size": 12},
        },
        "colorway": list(FILL_SERIES),
    }
    if cartesian:
        # One tooltip per x position reads better than one per trace once several series
        # share an axis, which is the common case for a breakdown or a time series.
        layout["hovermode"] = "x unified" if len(traces) > 1 else "closest"
        layout.update(_axis_defaults(traces))
        if any(_trace_type(t) == "bar" for t in traces):
            layout.setdefault("bargap", 0.28)
    return layout


def _hold_the_label_space(layout: dict[str, Any], traces: list[dict[str, Any]]) -> None:
    """Re-apply the few layout keys that carry the no-overlap guarantee.

    Everywhere else in this module a value the model supplied wins, and it should: the model
    read the result set and this code did not. These keys are the exception, because they
    are not statements about the data. They are the arrangement that stops one label being
    drawn over another, and the model cannot check its own choice: it has never seen the
    figure, does not know the card's width, and cannot measure how wide a title renders.

    So the legend keeps the edge it was given, both axes keep measuring their own labels,
    and a tick angle the model asked for is dropped rather than honoured. Only Plotly can
    pick that angle, because only Plotly has the drawn text in front of it.
    """

    cartesian = all(_trace_type(t) != "pie" for t in traces)
    legend = dict(layout.get("legend") or {})
    legend.update(_legend(cartesian))
    layout["legend"] = legend
    layout["margin"] = dict(_PADDING)
    for name in ("xaxis", "yaxis"):
        axis = layout.get(name)
        if isinstance(axis, dict):
            axis["automargin"] = True
            axis.pop("tickangle", None)


# --------------------------------------------------------------------------------------
# Order
#
# Which end of the axis the signal sits at. A separate concern from the label geometry
# above: that decides whether a label can be read at all, this decides whether a reader
# has to hunt for the one worth reading.
#
# ENFORCED HERE RATHER THAN ASKED FOR. `PLOT_INSTRUCTIONS` has told the model to sort a
# ranked bar chart by value for as long as it has existed, and a null-ratio breakdown
# still arrived in schema order: twenty columns, the only two with nulls in them last,
# under eighteen empty bars. A rule the model is free to skip is not a rule. Ordering is
# also the kind of thing code can settle alone, because it needs the values and not what
# they mean, which is what separates it from the shape of the chart.
#
# DONE WITH PLOTLY'S OWN `categoryorder`, NOT BY REORDERING THE ARRAYS. Two reasons.
# Plotly totals each category across every trace, so a grouped or stacked bar comes out
# ranked without this module deciding what the total of a stack is. And the points reach
# the browser in the order the model sent them, which keeps `marker.color`, `text`,
# `hovertext` and `customdata` lined up with the bars they belong to. Permuting five
# parallel arrays by hand is how a bar ends up wearing another bar's label.
# --------------------------------------------------------------------------------------

#: Category names that are a period rather than a name, in the formats a warehouse column
#: comes back as.
#:
#: A bar chart of months is a time series drawn with bars, and sorting one by value
#: destroys the only thing a period axis is for. The test is on the category values
#: because they are the only evidence available: the brief asks for a line here and gets
#: a bar often enough that a declared axis type cannot be relied on.
_TEMPORAL_CATEGORY = re.compile(
    r"""^(?:
        \d{4}(?:[-/]\d{1,2}){0,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?  # 2026, 2026-01, with a clock
      | \d{1,2}[-/]\d{1,2}[-/]\d{2,4}                               # 15/01/2026
      | (?:fy)?\d{2,4}[ -]?q[1-4]                                   # 2026-Q1, FY26Q3
      | q[1-4][ -]?(?:fy)?\d{2,4}                                   # Q1 2026
      | (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[ -]?\d{2,4}
      | \d{4}[ -]?w\d{1,2}                                          # 2026-W03
      | week[ -]?\d{1,2}
    )$""",
    re.IGNORECASE | re.VERBOSE,
)


def _is_horizontal(traces: list[dict[str, Any]]) -> bool:
    """Whether the categories read down the left rather than along the bottom.

    Mirrors the test in `_axis_defaults`, which picks which axis carries the values. The
    two have to agree: ordering the value axis instead of the category axis sets a key
    Plotly ignores and reports the chart as sorted.
    """

    return any(str(t.get("orientation") or "").lower() == "h" for t in traces)


def _sortable_categories(traces: list[dict[str, Any]]) -> list[str] | None:
    """The category names a value order may be applied to, or `None` for a figure it may not.

    Bars, and every trace has to be one. A line drawn over the same categories is a trend,
    and a trend reordered by size is a different claim about the data than the one the
    model made. A histogram bins raw values and has no categories to rank.

    Names only. Numbers and dates on that axis make it numeric or temporal, where a
    category order is not a thing that exists, and one category has no order at all.
    """

    if any(_trace_type(trace) != "bar" for trace in traces):
        return None
    key = "y" if _is_horizontal(traces) else "x"
    names: list[str] = []
    for trace in traces:
        values = trace.get(key)
        if not isinstance(values, list) or not values:
            return None
        if any(not isinstance(value, str) for value in values):
            return None
        names.extend(values)
    return names if len(set(names)) > 1 else None


def _order_bars_by_value(layout: dict[str, Any], traces: list[dict[str, Any]]) -> None:
    """Put the largest bar where the reader looks first, unless the model named an order.

    Descending along the bottom, ascending up the left. Those are the same instruction,
    not two: Plotly lays the first category out at the axis start, which is the left of an
    x axis and the BOTTOM of a y axis. Writing one direction for both is exactly how a
    twenty-column chart ended up with its two useful bars at the bottom.

    THREE THINGS TURN IT OFF, and all three are the model saying something this module
    cannot see past. A `categoryarray` is the categories being ordinal, or already ranked
    by something better than their own size. A `categoryorder` is the same statement in
    fewer words. And a declared numeric or date axis is not a category axis. A period
    among the names is the fourth, and it is checked with `any` rather than `all` on
    purpose: failing to sort one odd breakdown is a chart that reads awkwardly, and
    sorting twelve months by size is a chart that is wrong.
    """

    categories = _sortable_categories(traces)
    if categories is None:
        return
    if any(_TEMPORAL_CATEGORY.match(name.strip()) for name in categories):
        return
    horizontal = _is_horizontal(traces)
    name = "yaxis" if horizontal else "xaxis"
    axis = dict(layout.get(name) or {})
    if axis.get("categoryorder") or axis.get("categoryarray"):
        return
    if str(axis.get("type") or "").lower() in {"date", "linear", "log"}:
        return
    axis["categoryorder"] = "total ascending" if horizontal else "total descending"
    layout[name] = axis


def _kind(traces: list[dict[str, Any]]) -> str:
    """The chart's shape, for the client's badge: derived, never taken from the model."""

    kinds = {_trace_type(trace) for trace in traces}
    if len(kinds) > 1:
        return "combo"
    only = kinds.pop()
    if only != "scatter":
        return only
    modes = {str(trace.get("mode") or "lines+markers").lower() for trace in traces}
    if all("lines" not in mode for mode in modes):
        return "scatter"
    return "line"


def new_plot(
    data: Any = None,
    layout: dict[str, Any] | None = None,
    title: str = "",
    chart_id: str = "chart",
    spec: Any = None,
) -> Chart:
    """Validate one chart recommendation and adapt it to the current renderer.

    Raises `ChartError` with a message the model can act on. Callers treat a failed chart
    as a missing chart, never as a failed answer.
    """

    supplied_layout = dict(layout) if isinstance(layout, dict) else {}
    if spec is not None:
        data, semantic_layout = _semantic_spec(spec)
        supplied_layout = _merge(semantic_layout, supplied_layout)
    elif data is None:
        raise EmptyChartError("the plotting step found no applicable chart")
    traces = _validate(data, supplied_layout)
    _paint(traces)
    _wrap_category_ticks(traces)

    # The card header renders the title, so it is lifted out of the layout rather than
    # drawn twice. `title` from the tool call wins, since it is the model's own label.
    heading = title.strip() or _title_text(supplied_layout.get("title"))
    supplied_layout.pop("title", None)

    merged = _merge(_base_layout(traces), supplied_layout)
    _hold_the_label_space(merged, traces)
    # After the merge, so an order the model stated is visible to it and left alone.
    _order_bars_by_value(merged, traces)

    return Chart(
        id=chart_id,
        title=heading,
        kind=_kind(traces),
        data=traces,
        layout=merged,
    )


# The tool as the model sees it. Plotly is deliberately absent: renderer translation is
# an application concern, not a requirement the model must satisfy.
NEW_PLOT_TOOL = {
    "type": "function",
    "function": {
        "name": "new_plot",
        "description": (
            "Recommend one optional chart from the data you already have. Use outcome "
            "`chart` with a renderer-neutral `spec`, or outcome `not_applicable` when a "
            "tool response is required but no chart is warranted. One panel per call. "
            "Call it again for a second chart."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "outcome": {
                    "type": "string",
                    "enum": ["chart", "not_applicable"],
                    "description": "Whether this answer warrants a chart.",
                },
                "spec": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": ["bar", "line", "scatter", "histogram", "pie", "box"],
                        },
                        "series": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "x": {"type": "array"},
                                    "y": {"type": "array"},
                                    "labels": {"type": "array"},
                                    "values": {"type": "array"},
                                },
                            },
                        },
                        "x_title": {"type": "string"},
                        "y_title": {"type": "string"},
                        "stacking": {
                            "type": "string",
                            "enum": ["group", "stack", "relative"],
                        },
                    },
                    "required": ["kind", "series"],
                    "description": (
                        "Renderer-neutral chart meaning. For bar, line, and scatter, each "
                        "series has x and y. For pie, use labels and values. For histogram "
                        "and box, use values."
                    ),
                },
                "title": {
                    "type": "string",
                    "description": "Short chart title, taken from the result set itself.",
                },
            },
            "required": ["outcome"],
        },
    },
}

# The pair rule, held apart from the brief so a one-chart run can drop it.
#
# An operator can set the chart cap to 1 (`maxCharts` in runtime_settings.py). Left in
# at that cap, the brief asked for a second panel in one breath and forbade it in the
# next, and a model resolving that contradiction spends the single panel it is allowed
# on half of a pair. `_new_plot` removes this line when the cap is below two; see
# agent.py.
TWO_PANEL_RULE = (
    "- When the package contains a full date series plus a meaningful recent "
    "launch/event window, prefer two complementary panels: one line chart for the "
    "complete period and one bar chart for the recent window. The second panel must "
    "use only a real window and real measures present in the package; never infer an "
    "event boundary or manufacture a subset.\n"
    "- Do not produce a second panel that repeats the first chart in another shape. "
    "Each panel must answer a distinct evidence question."
)

# The plotting brief. It says nothing about this dataset on purpose: every label comes
# out of the result set, so it holds after the underlying data is replaced.
PLOT_INSTRUCTIONS = f"""You turn one assessed data package into at most {MAX_CHARTS} \
chart(s) by calling new_plot.

Rules:
- Plot only values present in the package. Never invent, extrapolate, or round a number.
- Choose the shape from the result set: a ranked breakdown is a bar chart, a date or \
period series is a line chart, a distribution is a histogram or box.
{TWO_PANEL_RULE}
- A part-of-whole split is a pie only when it has at most {MAX_PIE_SLICES} categories and \
every category is at least {MIN_PIE_LABEL_SHARE:.0%} of the total. Otherwise plot the \
shares as a ranked bar chart. A pie with slivers in it hides the small categories and \
crowds the labels on the big ones; a bar chart of the same shares reads at any count.
- Several measures over the same categories are several series on one chart, each with \
its own `name`. Set `stacking` to "group" or "stack" when you mean it.
- Take every label from the data itself: series names from the column or category \
names, axis titles from the measure and its unit, the title from what was asked.
- A ranked bar chart is sorted for you, largest value first, so send the rows in \
whatever order the query returned them. A bar chart whose categories are dates or periods \
is left in the order you send, so send that one in date order.
- Leave a category out when it has nothing in it AND those categories are most of the \
chart: a null-ratio breakdown over twenty columns where eighteen are zero is two bars and \
eighteen empty rows to look past. Plot the ones with a value, and say in the answer how \
many you left out and that they were zero. Never leave out a category that has a value, \
however small, and never leave one out to sharpen a point.
- A breakdown where every value is zero is not a chart. Say so in the answer instead.
- One panel per call. Call new_plot once per chart, at most {MAX_CHARTS} times in \
total, and not at all if the package holds no plottable rows or only a single scalar. If \
the tool interface requires a response, send outcome "not_applicable" without a spec.
- Describe chart meaning only. The application chooses the renderer, colours, fonts, \
margins, figure size, legend position, and tick angles. Send labels exactly as they \
appear in the data; do not shorten or abbreviate a name to make it fit.

Reply with tool calls only; any prose is discarded."""
