"""The `new_plot` tool: Plotly specifications built from whatever the query returned.

The model decides *what* to plot and supplies Plotly `data` traces plus an optional
`layout`; this module owns validation, the brand palette and the layout defaults.
The app renders the resulting spec with Plotly.js in the browser.

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
# The app's brand palette, copied from client/src/index.css so a chart cannot drift
# away from the surface it sits on. Two lists, because a colour that works as a filled
# mass does not necessarily work as a one-pixel stroke:
#
#   FILL_SERIES   bars, pie slices, histogram bins, box bodies.
#   STROKE_SERIES lines and markers. EVERY ENTRY CLEARS 3:1 AGAINST WHITE (WCAG's
#                 non-text minimum), which is why gold (1.86:1) is absent.
#
# The three tints are literal sRGB composites over white, written out so contrast is
# checked against the exact value rather than whatever a mix function returns.
# --------------------------------------------------------------------------------------

INK = "#111111"  # --pia-ink
RED = "#e4002b"  # --pia-red, and the primary data series
RED_STRONG = "#b20022"  # --pia-red-strong
GOLD = "#fcaf17"  # --pia-gold, fills only
SLATE = "#6c707b"  # --pia-slate
LINE = "#e5e5e5"  # --pia-line, gridlines and hover borders

_RED_TINT = "#f38ca0"  # --pia-red at 45% over white
_GOLD_TINT = "#fdd78b"  # --pia-gold at 50% over white
_SLATE_TINT = "#aeb0b6"  # --pia-slate at 55% over white

FILL_SERIES = (RED, INK, GOLD, SLATE, RED_STRONG, _RED_TINT, _GOLD_TINT, _SLATE_TINT)
STROKE_SERIES = (RED, INK, SLATE, RED_STRONG)

# Past four series, colour alone stops separating lines reliably, so the stroke pattern
# carries the difference instead of inventing more brand colours.
_DASHES = ("solid", "dash", "dot", "dashdot")

# Contrast floor for a stroke, a marker, or the outline drawn around a pale fill.
_MIN_STROKE_CONTRAST = 3.0

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
    return isinstance(colour, str) and contrast_on_white(colour) >= _MIN_STROKE_CONTRAST


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
    if not isinstance(data, list) or not data:
        raise ChartError("`data` must be a non-empty list of Plotly trace objects.")
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
            raise ChartError("Every entry in `data` must be a Plotly trace object.")
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
        raise ChartError("No trace carries any data points, so there is nothing to draw.")
    return traces


def _paint(traces: list[dict[str, Any]]) -> None:
    """Assign brand colours in place, one series at a time.

    A colour the model supplied is respected where it can be: per-point colour lists
    and scalar colours on a fill. The one override is a scalar colour too pale to read
    as a stroke or marker, because an invisible line is a wrong chart reported as a
    successful one.
    """

    for index, trace in enumerate(traces):
        kind = _trace_type(trace)
        trace["type"] = kind
        marker = dict(trace.get("marker") or {})

        if kind == "pie":
            # Pie colours are per slice, not per series, so the palette spans the trace.
            slices = max(_point_count(trace), 1)
            if not isinstance(marker.get("colors"), list):
                marker["colors"] = [FILL_SERIES[i % len(FILL_SERIES)] for i in range(slices)]
            outline = dict(marker.get("line") or {})
            outline.setdefault("color", "#ffffff")
            outline.setdefault("width", 1)
            marker["line"] = outline
            trace["marker"] = marker
            trace.setdefault("textinfo", "label+percent")
            trace.setdefault("hovertemplate", "%{label}<br>%{value:,}<extra></extra>")
            continue

        if kind in _FILL_TRACE_TYPES:
            colour = FILL_SERIES[index % len(FILL_SERIES)]
            supplied = marker.get("color")
            if isinstance(supplied, list):
                pass  # per-point highlighting: the model meant this
            elif isinstance(supplied, str) and supplied:
                colour = supplied
            else:
                marker["color"] = colour
            # A pale fill needs an edge or it disappears into the card. Gold and the
            # tints are legitimate fills precisely because this outline exists.
            if not isinstance(marker.get("color"), list) and not _is_legible_stroke(
                marker.get("color")
            ):
                outline = dict(marker.get("line") or {})
                outline.setdefault("color", INK)
                outline.setdefault("width", 1)
                marker["line"] = outline
            trace["marker"] = marker
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


def _rgba(colour: str, alpha: float) -> str:
    digits = colour.lstrip("#")
    red, green, blue = (int(digits[i : i + 2], 16) for i in (0, 2, 4))
    return f"rgba({red}, {green}, {blue}, {alpha})"


def _axis_defaults(traces: list[dict[str, Any]]) -> dict[str, Any]:
    shared = {
        "gridcolor": LINE,
        "zerolinecolor": LINE,
        "linecolor": LINE,
        "tickfont": {"color": SLATE, "size": 11},
        "automargin": True,
    }
    horizontal = any(str(t.get("orientation") or "").lower() == "h" for t in traces)
    value_axis, category_axis = ("xaxis", "yaxis") if horizontal else ("yaxis", "xaxis")
    return {
        category_axis: dict(shared, showgrid=False),
        # Audience counts: thousands separators read far better than 8.413k.
        value_axis: dict(shared, showgrid=True, tickformat=","),
    }


def _base_layout(traces: list[dict[str, Any]]) -> dict[str, Any]:
    cartesian = all(_trace_type(t) != "pie" for t in traces)
    layout: dict[str, Any] = {
        # Transparent, so the chart inherits whatever card it is rendered inside.
        "paper_bgcolor": "rgba(0,0,0,0)",
        "plot_bgcolor": "rgba(0,0,0,0)",
        "font": {"color": INK, "size": 12},
        "margin": {"l": 8, "r": 8, "t": 8, "b": 8},
        "showlegend": len(traces) > 1 or _trace_type(traces[0]) == "pie",
        "legend": {
            "orientation": "h",
            "yanchor": "bottom",
            "y": -0.28,
            "x": 0,
            "font": {"color": INK, "size": 11},
        },
        "hoverlabel": {
            "bgcolor": "#ffffff",
            "bordercolor": LINE,
            "font": {"color": INK, "size": 12},
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
    data: Any,
    layout: dict[str, Any] | None = None,
    title: str = "",
    chart_id: str = "chart",
) -> Chart:
    """Validate one Plotly spec, apply the brand palette and layout, and return a `Chart`.

    Raises `ChartError` with a message the model can act on. Callers treat a failed chart
    as a missing chart, never as a failed answer.
    """

    supplied_layout = dict(layout) if isinstance(layout, dict) else {}
    traces = _validate(data, supplied_layout)
    _paint(traces)

    # The card header renders the title, so it is lifted out of the layout rather than
    # drawn twice. `title` from the tool call wins, since it is the model's own label.
    heading = title.strip() or _title_text(supplied_layout.get("title"))
    supplied_layout.pop("title", None)

    return Chart(
        id=chart_id,
        title=heading,
        kind=_kind(traces),
        data=traces,
        layout=_merge(_base_layout(traces), supplied_layout),
    )


# The tool as the model sees it. Kept beside the implementation so the description and
# what `new_plot` actually accepts cannot drift apart.
NEW_PLOT_TOOL = {
    "type": "function",
    "function": {
        "name": "new_plot",
        "description": (
            "Render one chart from the data you already have. Pass `data` (a list of "
            "Plotly.js trace objects) and optionally `layout` and `title`. One panel per "
            "call. Call it again for a second chart. Supported trace types: bar (grouped "
            "or stacked via layout.barmode), scatter (set mode to lines for a line or time "
            "series), histogram, pie, box. Do not set colours; they are applied "
            "automatically. Do not use layout.grid or layout.updatemenus."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "data": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Plotly.js data: a list of trace objects.",
                },
                "layout": {
                    "type": "object",
                    "description": (
                        "Plotly.js layout. Set axis titles and barmode here; leave "
                        "colours, fonts and margins alone."
                    ),
                },
                "title": {
                    "type": "string",
                    "description": "Short chart title, taken from the result set itself.",
                },
            },
            "required": ["data"],
        },
    },
}

# The plotting brief. It says nothing about this dataset on purpose: every label comes
# out of the result set, so it holds after the underlying data is replaced.
PLOT_INSTRUCTIONS = f"""You turn one assessed data package into at most {MAX_CHARTS} \
chart(s) by calling new_plot.

Rules:
- Plot only values present in the package. Never invent, extrapolate, or round a number.
- Choose the shape from the result set: a ranked breakdown is a bar chart, a date or \
period series is a scatter with mode "lines", a part-of-whole split with a handful of \
categories is a pie, a distribution is a histogram or box.
- Several measures over the same categories are several traces on one chart, each with \
its own `name`. Set layout.barmode to "group" or "stack" when you mean it.
- Take every label from the data itself: series names from the column or category \
names, axis titles from the measure and its unit, the title from what was asked.
- Sort a ranked bar chart by value. Keep a time series in date order.
- One panel per call. Call new_plot once per chart, at most {MAX_CHARTS} times in \
total, and not at all if the package holds no plottable rows or only a single scalar.
- Do not set colours, fonts, margins, or figure size.

Reply with tool calls only; any prose is discarded."""
