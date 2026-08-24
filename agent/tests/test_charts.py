from __future__ import annotations

from typing import Any

import pytest

from charts import (
    AMBER,
    AMBER_DEEP,
    BLUE,
    BLUE_LIGHT,
    EMPHASIS,
    FILL_SERIES,
    FONT_MONO,
    FONT_SANS,
    GREY_BLUE,
    INK,
    LINE,
    MAX_PIE_SLICES,
    MAX_POINTS_PER_TRACE,
    MAX_TRACES,
    MIN_PIE_LABEL_SHARE,
    NEW_PLOT_TOOL,
    PLOT_INSTRUCTIONS,
    RED_FAILURE,
    SLATE,
    STROKE_SERIES,
    TEAL,
    TICK_LINE_CHARS,
    TICK_LINE_LIMIT,
    ChartError,
    EmptyChartError,
    contrast_on_white,
    new_plot,
)

# The palette the app retired. Named here rather than in the module so that deleting a
# constant from `charts.py` cannot quietly delete the test that says it is gone.
RETIRED = ("#e4002b", "#b20022", "#fcaf17", "#111111", "#6c707b", "#e5e5e5")


def _bar(**overrides):
    trace = {"type": "bar", "x": ["a", "b", "c"], "y": [3, 2, 1]}
    trace.update(overrides)
    return trace


# Real title names from the dataset the app is pointed at, at roughly the shares it
# reported. They are here because they are the shape that broke: names that will not get
# shorter, and a tail of categories under one per cent that each asked for its own label.
LONG_TITLES = [
    "VLH Online",
    "Hoops 26",
    "Dynasty VII",
    "Scrapline 4",
    "Fairway Pro 25",
    "Hoops 25",
    "Iron Frontier Reckoning",
    "Iron Frontier Online",
    "Iron Frontier Reckoning 2",
    "Outfit: Old Harbor",
    "Velocity Heights V",
]
LONG_SHARES = [36.9, 25.9, 11.3, 7.7, 5.45, 4.5, 2.6, 2.7, 1.03, 0.956, 0.945]

_SLIVER_PIE = {"type": "pie", "labels": LONG_TITLES, "values": LONG_SHARES}


def _figures() -> list[Any]:
    """One of every shape the tool supports, painted. The whole-figure rules run over
    these rather than over a single bar chart, because a rule that only holds for bars is
    not the rule the design states."""

    return [
        new_plot([_bar()]),
        new_plot([_bar(name=f"s{i}") for i in range(MAX_TRACES)]),
        new_plot([_bar(text=["3", "2", "1"])]),
        new_plot([{"type": "pie", "labels": ["a", "b"], "values": [1, 2]}]),
        new_plot([{"type": "histogram", "x": [1, 2, 3]}]),
        new_plot([{"type": "box", "y": [1, 2, 3]}]),
        new_plot([{"type": "scatter", "mode": "lines", "x": [1, 2], "y": [1, 2]}]),
        new_plot(
            [{"type": "scatter", "mode": "lines", "x": [1, 2], "y": [1, 2]} for _ in range(6)]
        ),
    ]


def _walk(node: Any, path: str = "") -> list[tuple[str, Any]]:
    """Every leaf in a figure, with the dotted path that reached it."""

    found: list[tuple[str, Any]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            found.extend(_walk(value, f"{path}.{key}" if path else str(key)))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            found.extend(_walk(value, f"{path}[{index}]"))
    else:
        found.append((path, node))
    return found


def _leaves(chart) -> list[tuple[str, Any]]:
    return _walk(chart.data, "data") + _walk(chart.layout, "layout")


class TestPalette:
    def test_the_series_order_is_the_one_the_token_file_states(self):
        """`--chart-1`..`--chart-4`, in that order. Blue first: it is the action colour,
        and an ordinary breakdown must not open in the colour of a failure."""

        assert FILL_SERIES[:4] == (BLUE, TEAL, BLUE_LIGHT, GREY_BLUE)
        assert STROKE_SERIES == (BLUE, TEAL, BLUE_LIGHT, GREY_BLUE)

    def test_the_retired_brand_palette_appears_nowhere(self):
        rendered = repr(FILL_SERIES) + repr(STROKE_SERIES)
        for chart in _figures():
            rendered += repr(chart.data) + repr(chart.layout)
        for colour in RETIRED:
            assert colour.lower() not in rendered.lower(), colour

    def test_every_stroke_colour_clears_the_non_text_contrast_floor(self):
        for colour in STROKE_SERIES:
            assert contrast_on_white(colour) >= 3.0, colour

    def test_contrast_matches_the_measured_token_values(self):
        # The same numbers tokens.css is measured at, so a token edit that changes one is
        # caught here rather than in a screenshot nobody takes.
        assert contrast_on_white(BLUE) == pytest.approx(5.08, abs=0.02)
        assert contrast_on_white(TEAL) == pytest.approx(4.46, abs=0.02)
        assert contrast_on_white(BLUE_LIGHT) == pytest.approx(3.06, abs=0.02)
        assert contrast_on_white(GREY_BLUE) == pytest.approx(7.82, abs=0.02)
        assert contrast_on_white(EMPHASIS) == pytest.approx(3.62, abs=0.02)
        assert contrast_on_white(AMBER) == pytest.approx(1.90, abs=0.02)
        assert contrast_on_white(INK) == pytest.approx(18.10, abs=0.05)

    def test_the_tints_are_paler_than_their_bases_and_all_eight_are_distinct(self):
        """The tints carry series five to eight. They are a fifth to a half of their base
        over white, so each must read as the same hue gone pale, and no two of the eight
        may be the same value."""

        assert len(set(FILL_SERIES)) == len(FILL_SERIES)
        for base, tint in zip(FILL_SERIES[:4], FILL_SERIES[4:], strict=True):
            assert contrast_on_white(tint) < contrast_on_white(base), tint
            assert contrast_on_white(tint) > 1.0, tint

    def test_an_unparseable_colour_scores_zero_rather_than_passing(self):
        assert contrast_on_white("var(--chart-1)") == 0.0
        assert contrast_on_white("") == 0.0


class TestReservedMeanings:
    """DuBois rations colour by meaning. These are the meanings a chart is not allowed to
    borrow, stated as rules a test can check rather than as a note in a comment."""

    def test_the_emphasis_orange_is_not_a_series_colour(self):
        assert EMPHASIS not in FILL_SERIES
        assert EMPHASIS not in STROKE_SERIES

    def test_a_figure_never_paints_the_emphasis_orange_by_itself(self):
        """Nothing in `_figures()` asks to point at anything, so nothing in them is
        orange — including the twelve-series chart, which exhausts the palette."""

        for chart in _figures():
            painted = [
                path
                for path, value in _leaves(chart)
                if isinstance(value, str) and value.lower() == EMPHASIS.lower()
            ]
            assert painted == [], painted

    def test_the_emphasis_orange_is_used_at_most_once_per_figure(self):
        """It means "this is the one being pointed at". Two of them point at nothing."""

        chart = new_plot(
            [
                _bar(marker={"color": [EMPHASIS, BLUE, BLUE]}, name="first"),
                _bar(marker={"color": [EMPHASIS, BLUE, BLUE]}, name="second"),
            ]
        )
        uses = [
            value
            for _, value in _leaves(chart)
            if isinstance(value, str) and value.lower() == EMPHASIS.lower()
        ]
        assert len(uses) == 1

    def test_a_single_pointed_at_bar_keeps_its_emphasis(self):
        chart = new_plot([_bar(marker={"color": [EMPHASIS, BLUE, BLUE]})])
        assert chart.data[0]["marker"]["color"] == [EMPHASIS, BLUE, BLUE]

    def test_two_emphasised_bars_in_one_trace_lose_both(self):
        """Rather than the code picking a leader the model never named."""

        chart = new_plot([_bar(marker={"color": [EMPHASIS, EMPHASIS, BLUE]})])
        assert chart.data[0]["marker"]["color"] == [BLUE, BLUE, BLUE]

    def test_a_whole_series_in_the_emphasis_orange_is_demoted(self):
        chart = new_plot([_bar(marker={"color": EMPHASIS})])
        assert chart.data[0]["marker"]["color"] == BLUE

    def test_the_emphasis_orange_is_never_a_line(self):
        """It clears the contrast floor, so only an explicit rule keeps it off strokes:
        DuBois allows orange as a filled mass and nothing else."""

        chart = new_plot(
            [{"type": "scatter", "mode": "lines", "x": [1], "y": [1], "line": {"color": EMPHASIS}}]
        )
        assert chart.data[0]["line"]["color"] == BLUE
        assert chart.data[0]["marker"]["color"] == BLUE

    def test_an_emphasised_pie_slice_goes_back_to_the_palette(self):
        """A part-of-whole split has no leader to point at."""

        chart = new_plot(
            [
                {
                    "type": "pie",
                    "labels": ["a", "b"],
                    "values": [1, 2],
                    "marker": {"colors": [EMPHASIS, TEAL]},
                }
            ]
        )
        assert chart.data[0]["marker"]["colors"] == [BLUE, TEAL]

    def test_amber_is_never_a_font_colour(self):
        """Evaluation amber is 1.90:1 on white: legible as a filled mass, illegible as
        text. `AMBER_DEEP` is what text uses."""

        assert contrast_on_white(AMBER) < 3.0
        assert contrast_on_white(AMBER_DEEP) > 4.5
        for chart in _figures():
            for path, value in _leaves(chart):
                if path.endswith("font.color") and isinstance(value, str):
                    assert value.lower() != AMBER.lower(), path

    def test_amber_is_never_a_hairline(self):
        for chart in _figures():
            for path, value in _leaves(chart):
                if path.endswith("line.color") and isinstance(value, str):
                    assert value.lower() != AMBER.lower(), path

    def test_amber_and_the_failure_red_are_not_series_colours(self):
        for colour in (AMBER, AMBER_DEEP, RED_FAILURE):
            assert colour not in FILL_SERIES
            assert colour not in STROKE_SERIES

    def test_an_amber_line_supplied_by_the_model_is_replaced(self):
        """The model is told not to set colours; when it does anyway, an illegible
        stroke is a wrong chart reported as a good one, so it is overridden."""

        chart = new_plot(
            [{"type": "scatter", "mode": "lines", "x": [1], "y": [1], "line": {"color": AMBER}}]
        )
        assert chart.data[0]["line"]["color"] != AMBER
        assert contrast_on_white(chart.data[0]["line"]["color"]) >= 3.0


class TestType:
    def test_labels_are_set_in_the_sans_face(self):
        layout = new_plot([_bar(name="a"), _bar(name="b")]).layout
        assert layout["font"]["family"] == FONT_SANS
        assert layout["legend"]["font"]["family"] == FONT_SANS

    def test_numerals_are_set_in_the_mono_face(self):
        layout = new_plot([_bar()]).layout
        assert layout["yaxis"]["tickfont"]["family"] == FONT_MONO
        assert layout["xaxis"]["tickfont"]["family"] == FONT_MONO
        assert layout["hoverlabel"]["font"]["family"] == FONT_MONO

    def test_both_families_name_a_real_fallback(self):
        """A figure that silently falls back to a proportional face loses the digit
        alignment the mono column exists for, and says nothing about it."""

        assert FONT_SANS.startswith("'DM Sans',") and FONT_SANS.endswith("sans-serif")
        assert FONT_MONO.startswith("'DM Mono',") and FONT_MONO.endswith("monospace")
        assert len(FONT_MONO.split(",")) >= 3

    def test_axis_and_tick_labels_are_the_secondary_ink(self):
        layout = new_plot([_bar()]).layout
        assert layout["yaxis"]["tickfont"]["color"] == SLATE
        assert layout["yaxis"]["gridcolor"] == LINE


class TestValuesOffTheFills:
    """A value is never printed on top of a fill: it lives in its own column or beside
    the bar."""

    def test_a_bar_label_is_moved_outside_the_bar(self):
        chart = new_plot([_bar(text=["3", "2", "1"])])
        assert chart.data[0]["textposition"] == "outside"
        assert chart.data[0]["textfont"]["family"] == FONT_MONO

    def test_a_label_the_model_placed_inside_is_overridden(self):
        chart = new_plot([_bar(text=["3", "2", "1"], textposition="inside")])
        assert chart.data[0]["textposition"] == "outside"

    def test_pie_text_sits_outside_the_slices(self):
        chart = new_plot([{"type": "pie", "labels": ["a", "b"], "values": [1, 2]}])
        assert chart.data[0]["textposition"] == "outside"

    def test_no_figure_prints_text_on_a_fill(self):
        """`outside` or nothing at all. `none` is how a pie is told to skip the label on a
        sliver, so it is allowed; `inside` and `auto` put a value on a fill and are not."""

        for chart in _figures() + [new_plot([_SLIVER_PIE])]:
            for path, value in _leaves(chart):
                if "textposition" in path:
                    assert value in {"outside", "none"}, (path, value)

    def test_a_bar_without_labels_is_left_alone(self):
        """The rule is about where a value goes, not about adding one the model did not
        ask for."""

        chart = new_plot([_bar()])
        assert "textposition" not in chart.data[0]
        assert "text" not in chart.data[0]


class TestSeriesColouring:
    def test_the_first_series_is_the_action_blue(self):
        chart = new_plot([_bar()])
        assert chart.data[0]["marker"]["color"] == BLUE

    def test_categorical_series_get_distinct_colours(self):
        chart = new_plot([_bar(name=f"s{i}") for i in range(5)])
        colours = [trace["marker"]["color"] for trace in chart.data]
        assert len(set(colours)) == len(colours)

    def test_a_ninth_series_wraps_rather_than_running_out(self):
        chart = new_plot([_bar(name=f"s{i}") for i in range(9)])
        assert chart.data[8]["marker"]["color"] == chart.data[0]["marker"]["color"]

    def test_pale_fills_get_an_ink_outline_so_they_stay_visible(self):
        """The tints are legitimate fills precisely because this outline exists."""

        chart = new_plot([_bar(marker={"color": FILL_SERIES[6]})])
        assert chart.data[0]["marker"]["line"]["color"] == INK

    def test_a_legible_fill_is_left_without_an_outline(self):
        chart = new_plot([_bar(marker={"color": BLUE})])
        assert "line" not in chart.data[0]["marker"]

    def test_lines_beyond_the_stroke_palette_are_separated_by_dash(self):
        traces = [{"type": "scatter", "mode": "lines", "x": [1, 2], "y": [1, 2]} for _ in range(6)]
        chart = new_plot(traces)
        first = chart.data[0]["line"]
        fifth = chart.data[len(STROKE_SERIES)]["line"]
        assert first["color"] == fifth["color"]
        assert first.get("dash", "solid") != fifth["dash"]

    def test_a_legible_line_colour_supplied_by_the_model_is_respected(self):
        chart = new_plot([{"type": "scatter", "x": [1], "y": [1], "line": {"color": INK}}])
        assert chart.data[0]["line"]["color"] == INK

    def test_per_point_colours_are_left_alone(self):
        """A colour list is the model highlighting one bar, which is a meaning, not a default."""

        highlight = [BLUE, GREY_BLUE, GREY_BLUE]
        chart = new_plot([_bar(marker={"color": highlight})])
        assert chart.data[0]["marker"]["color"] == highlight

    def test_pie_slices_are_coloured_across_the_fill_palette(self):
        chart = new_plot([{"type": "pie", "labels": ["a", "b", "c"], "values": [1, 2, 3]}])
        assert chart.data[0]["marker"]["colors"] == list(FILL_SERIES[:3])


class TestKind:
    def test_a_bar_result_is_a_bar(self):
        assert new_plot([_bar()]).kind == "bar"

    def test_a_scatter_with_lines_is_a_line_chart(self):
        assert new_plot([{"type": "scatter", "mode": "lines", "x": [1], "y": [2]}]).kind == "line"

    def test_markers_only_stays_a_scatter(self):
        assert (
            new_plot([{"type": "scatter", "mode": "markers", "x": [1], "y": [2]}]).kind == "scatter"
        )

    def test_mixed_trace_types_report_as_a_combo(self):
        chart = new_plot([_bar(), {"type": "scatter", "mode": "lines", "x": [1], "y": [2]}])
        assert chart.kind == "combo"

    def test_type_line_is_translated_rather_than_rejected(self):
        """Not a Plotly trace type, but the single most common thing a model emits."""

        chart = new_plot([{"type": "line", "x": [1, 2], "y": [3, 4]}])
        assert chart.data[0]["type"] == "scatter"
        assert chart.kind == "line"

    def test_a_histogram_and_a_pie_keep_their_own_kind(self):
        assert new_plot([{"type": "histogram", "x": [1, 2, 3]}]).kind == "histogram"
        assert new_plot([{"type": "pie", "labels": ["a"], "values": [1]}]).kind == "pie"


class TestLayout:
    def test_the_title_moves_out_of_the_layout_into_the_envelope(self):
        """The card header draws the title, so leaving it in the layout draws it twice."""

        chart = new_plot([_bar()], {"title": {"text": "Sessions by week"}})
        assert chart.title == "Sessions by week"
        assert "title" not in chart.layout

    def test_an_explicit_title_argument_wins_over_the_layout(self):
        chart = new_plot([_bar()], {"title": "from layout"}, title="from argument")
        assert chart.title == "from argument"

    def test_model_supplied_layout_survives_the_defaults(self):
        chart = new_plot([_bar()], {"barmode": "stack", "yaxis": {"title": {"text": "Players"}}})
        assert chart.layout["barmode"] == "stack"
        assert chart.layout["yaxis"]["title"] == {"text": "Players"}
        # ...and is merged with them rather than replacing them.
        assert chart.layout["yaxis"]["gridcolor"]

    def test_a_log_axis_the_model_asked_for_is_not_overwritten(self):
        chart = new_plot([_bar()], {"yaxis": {"type": "log"}})
        assert chart.layout["yaxis"]["type"] == "log"

    def test_counts_are_formatted_with_thousands_separators(self):
        chart = new_plot([_bar()])
        assert chart.layout["yaxis"]["tickformat"] == ","

    def test_a_horizontal_bar_puts_the_value_format_on_the_x_axis(self):
        chart = new_plot([_bar(orientation="h")])
        assert chart.layout["xaxis"]["tickformat"] == ","
        assert chart.layout["yaxis"]["showgrid"] is False

    def test_the_background_is_transparent_so_the_card_shows_through(self):
        layout = new_plot([_bar()]).layout
        assert layout["paper_bgcolor"] == "rgba(0,0,0,0)"
        assert layout["plot_bgcolor"] == "rgba(0,0,0,0)"

    def test_a_single_series_hides_the_legend_and_several_show_it(self):
        assert new_plot([_bar()]).layout["showlegend"] is False
        assert new_plot([_bar(name="a"), _bar(name="b")]).layout["showlegend"] is True

    def test_several_series_share_one_tooltip_per_x_position(self):
        assert new_plot([_bar(), _bar()]).layout["hovermode"] == "x unified"

    def test_a_pie_has_no_cartesian_axes(self):
        layout = new_plot([{"type": "pie", "labels": ["a"], "values": [1]}]).layout
        assert "xaxis" not in layout
        assert "hovermode" not in layout


class TestTheLegendHasItsOwnSpace:
    """The bug Sam reported, stated as rules.

    The legend used to sit below the plot at a fixed fraction of the plot's height. Plotly
    hands one figure edge to whichever component asks for the most of it rather than to all
    of them, so the legend and the row of tick labels were given the same strip and drawn on
    top of each other. Long names made it worse: the axis claimed more of the strip and the
    legend, measured against a plot area that had just got shorter, moved further into it.

    These tests are about the arrangement rather than about any particular label, because
    the arrangement is the only part that can be guaranteed. Nothing here can tell whether
    the result looks right; see the note at the top of TestUnverifiable.
    """

    def _legends(self):
        return [(chart, chart.layout["legend"]) for chart in _figures()]

    def test_no_legend_sits_below_the_plot_in_plot_coordinates(self):
        """The exact shape of the bug: `yref: paper` with a negative `y` puts the legend in
        the strip the tick labels need, and puts it further in the longer the labels get."""

        for chart, legend in self._legends():
            below = legend.get("yref") == "paper" and legend.get("y", 0) < 0
            assert not below, (chart.kind, legend)

    def test_every_legend_is_anchored_to_a_figure_edge_rather_than_to_the_plot(self):
        """`container` is what moves the legend out of the negotiation over an edge: Plotly
        reserves the band before the axis measures anything, then adds the axis on top."""

        for chart, legend in self._legends():
            anchored = "container" in (legend.get("xref"), legend.get("yref"))
            assert anchored, (chart.kind, legend)

    def test_a_cartesian_legend_takes_the_top_and_leaves_the_bottom_to_the_ticks(self):
        """Different edges, so no label length can bring them together. The categories run
        along the bottom and the values up the left, so the top is the free edge."""

        layout = new_plot([_bar(name="a"), _bar(name="b")]).layout
        assert layout["legend"]["yref"] == "container"
        assert layout["legend"]["y"] == 1
        assert layout["legend"]["yanchor"] == "top"
        assert layout["legend"]["orientation"] == "h"

    def test_a_pie_legend_takes_the_right_so_no_leader_line_can_cross_it(self):
        """A pie's outside labels ring the whole slice, and Plotly draws a leader line to
        wherever it had to move one. Under the chart is exactly where those lines go, so the
        legend is not put there. Width is also the cheap direction: the card is wider than
        it is tall, so the pie's diameter is capped by its height, not by its width."""

        legend = new_plot([_SLIVER_PIE]).layout["legend"]
        assert legend["xref"] == "container"
        assert legend["x"] == 1
        assert legend["xanchor"] == "right"
        assert legend["orientation"] == "v"
        assert legend.get("yref") != "container" or legend.get("y") != 0

    def test_a_long_category_name_cannot_move_the_legend(self):
        """The same arrangement at three character counts. If any of these differed, the
        legend's position would be a function of the data, which is the failure mode."""

        arrangements = set()
        for length in (1, 40, 300):
            layout = new_plot(
                [
                    {"type": "bar", "x": ["z" * length, "y" * length], "y": [2, 1], "name": "a"},
                    {"type": "bar", "x": ["z" * length, "y" * length], "y": [1, 2], "name": "b"},
                ]
            ).layout
            arrangements.add(repr(sorted(layout["legend"].items(), key=str)))
        assert len(arrangements) == 1

    def test_the_model_cannot_put_the_legend_back_under_the_plot(self):
        """A layout key the model supplies wins everywhere else in this module, and should.
        Not this one: the model has never seen the figure and cannot measure a label."""

        layout = new_plot(
            [_bar(name="a"), _bar(name="b")],
            {"legend": {"orientation": "h", "yref": "paper", "y": -0.28, "yanchor": "bottom"}},
        ).layout
        assert layout["legend"]["yref"] == "container"
        assert layout["legend"]["y"] == 1

    def test_the_legend_keeps_what_the_model_said_that_is_not_about_position(self):
        """The override is scoped to the arrangement. Ordering is the model's business."""

        layout = new_plot(
            [_bar(name="a"), _bar(name="b")], {"legend": {"traceorder": "reversed"}}
        ).layout
        assert layout["legend"]["traceorder"] == "reversed"
        assert layout["legend"]["font"]["family"] == FONT_SANS


class TestTheFigureReservesItsOwnLabelSpace:
    def test_both_axes_measure_their_own_labels(self):
        for chart in _figures():
            for name in ("xaxis", "yaxis"):
                axis = chart.layout.get(name)
                if axis is not None:
                    assert axis["automargin"] is True, (chart.kind, name)

    def test_a_pie_measures_its_own_slice_labels(self):
        """Without this Plotly draws them at the edge of the plot area and the card clips
        whatever sticks out, which is the other half of what Sam saw."""

        assert new_plot([_SLIVER_PIE]).data[0]["automargin"] is True

    def test_the_margin_is_padding_and_does_not_grow_with_the_labels(self):
        """The label space is Plotly's to compute, because only Plotly has the drawn text.
        A margin that changed with the names would mean this module was guessing at it."""

        margins = set()
        for length in (1, 40, 300):
            layout = new_plot([{"type": "bar", "x": ["z" * length], "y": [1]}]).layout
            margins.add(repr(sorted(layout["margin"].items())))
        assert len(margins) == 1

    def test_a_tick_angle_the_model_asked_for_is_dropped(self):
        """A fixed angle is a guess about text width. Too shallow and long names collide,
        too steep and short ones sprawl for nothing. Plotly picks it from the real text."""

        layout = new_plot([_bar()], {"xaxis": {"tickangle": -45}}).layout
        assert "tickangle" not in layout["xaxis"]

    def test_the_model_keeps_the_axis_titles_it_set(self):
        layout = new_plot([_bar()], {"xaxis": {"title": {"text": "Title"}, "tickangle": 90}}).layout
        assert layout["xaxis"]["title"] == {"text": "Title"}


class TestLongCategoryNames:
    """The policy is wrapping, not a rotation angle. Wrapping bounds the height the axis
    can ask for whatever the names turn out to be, and leaves the angle to Plotly."""

    def test_a_long_name_is_broken_over_lines_rather_than_left_as_one_string(self):
        chart = new_plot([{"type": "bar", "x": LONG_TITLES, "y": LONG_SHARES}])
        assert chart.data[0]["x"][2] == "Sid Meier's<br>Dynasty<br>VII"
        assert chart.data[0]["x"][9] == "Outfit: The Old<br>Country"

    def test_a_short_name_is_left_exactly_as_it_arrived(self):
        chart = new_plot([{"type": "bar", "x": ["north", "south"], "y": [2, 1]}])
        assert chart.data[0]["x"] == ["north", "south"]

    def test_every_tick_is_bounded_in_both_directions_at_any_name_length(self):
        """The property the whole policy exists for. Three lines of fourteen characters is
        a block the axis can reserve room for; a 300-character name is not."""

        chart = new_plot([{"type": "bar", "x": ["z" * 300, "word " * 90], "y": [2, 1]}])
        for tick in chart.data[0]["x"]:
            lines = tick.split("<br>")
            assert len(lines) <= TICK_LINE_LIMIT, tick
            for line in lines:
                assert len(line) <= TICK_LINE_CHARS, line

    def test_a_name_too_long_to_wrap_keeps_its_full_text_on_hover(self):
        """Cutting the tick is allowed. Losing the name is not."""

        full = "Dynasty VI: Gathering Storm Anniversary"
        chart = new_plot([{"type": "bar", "x": [full], "y": [1]}])
        assert chart.data[0]["x"][0].endswith("\u2026")
        assert chart.data[0]["hovertext"] == [full]

    def test_two_different_names_never_wrap_to_the_same_tick(self):
        """Two ticks with the same text are one category, and the bars would be summed into
        it. A cut that would do that is abandoned: the axis keeps the full names and Plotly
        rotates them, which is worse to look at and still true."""

        shared = "Exactly The Same Leading Words Every Single Time "
        first, second = shared + "One", shared + "Two"
        chart = new_plot([{"type": "bar", "x": [first, second], "y": [2, 1]}])
        assert chart.data[0]["x"] == [first, second]
        assert len(set(chart.data[0]["x"])) == 2

    def test_a_horizontal_bar_keeps_its_names_on_one_line(self):
        """Its categories read down the left, where the constraint is width and the left
        margin already measures them. Three lines there would be taller than the row."""

        chart = new_plot([{"type": "bar", "orientation": "h", "y": LONG_TITLES, "x": LONG_SHARES}])
        assert chart.data[0]["y"] == LONG_TITLES

    def test_dates_and_numbers_on_the_axis_are_left_alone(self):
        chart = new_plot(
            [{"type": "scatter", "mode": "lines", "x": ["2026-01-01", "2026-02-01"], "y": [1, 2]}]
        )
        assert chart.data[0]["x"] == ["2026-01-01", "2026-02-01"]


class TestSmallPieSlices:
    def test_a_slice_below_the_threshold_gets_no_label_on_the_figure(self):
        chart = new_plot([_SLIVER_PIE])
        positions = chart.data[0]["textposition"]
        for label, share, position in zip(LONG_TITLES, LONG_SHARES, positions, strict=True):
            drawn = share / sum(LONG_SHARES) >= MIN_PIE_LABEL_SHARE
            assert position == ("outside" if drawn else "none"), (label, share, position)

    def test_the_slivers_that_caused_the_pile_up_are_the_ones_that_lose_their_label(self):
        """Six of the eleven titles are under five per cent of the total and five are under
        three. Those are the labels that stacked on each other and ran their leader lines
        down across the legend. Five labels are left, spread around the ring."""

        chart = new_plot([_SLIVER_PIE])
        drawn = [
            label
            for label, position in zip(LONG_TITLES, chart.data[0]["textposition"], strict=True)
            if position == "outside"
        ]
        assert drawn == [
            "VLH Online",
            "Hoops 26",
            "Dynasty VII",
            "Scrapline 4",
            "Fairway Pro 25",
        ]

    def test_a_suppressed_label_is_still_in_the_legend_and_the_tooltip(self):
        """Which is the whole reason not drawing it is honest rather than a deletion."""

        chart = new_plot([_SLIVER_PIE])
        assert chart.layout["showlegend"] is True
        assert chart.data[0]["labels"] == LONG_TITLES
        assert "%{label}" in chart.data[0]["hovertemplate"]
        assert "%{percent}" in chart.data[0]["hovertemplate"]

    def test_a_pie_whose_slices_all_clear_the_threshold_keeps_one_setting_for_all_of_them(self):
        """No per-slice list where there is nothing to suppress: a list of eleven identical
        strings is a spec that reads as if a rule fired when none did."""

        chart = new_plot([{"type": "pie", "labels": ["a", "b", "c"], "values": [40, 35, 25]}])
        assert chart.data[0]["textposition"] == "outside"

    def test_a_pie_that_cannot_be_measured_keeps_every_label(self):
        """A share that will not compute must not be treated as a small one, or a spec this
        module does not understand loses its labels without saying so."""

        for values in ([], ["12", "8"], [0, 0]):
            chart = new_plot([{"type": "pie", "labels": ["a", "b"], "values": values or [1, 2]}])
            if values in ([], [0, 0]):
                assert chart.data[0]["textposition"] == "outside"
        chart = new_plot([{"type": "pie", "labels": ["a", "b"], "values": ["12", "8"]}])
        assert chart.data[0]["textposition"] == "outside"

    def test_the_threshold_is_stated_once_and_the_brief_quotes_the_same_number(self):
        """The model is told when a pie stops being the right shape, and the renderer is
        told when a slice stops getting a label. One number behind both, or they drift."""

        assert f"{MIN_PIE_LABEL_SHARE:.0%}" in PLOT_INSTRUCTIONS
        assert str(MAX_PIE_SLICES) in PLOT_INSTRUCTIONS


class TestRankedBarsAreOrderedByValue:
    """The complaint: a null-ratio chart drew twenty columns in schema order, so the only
    two non-zero bars sat at the very bottom under eighteen empty ones and the signal had
    to be hunted for. `PLOT_INSTRUCTIONS` has asked the model to sort a ranked bar chart
    for as long as it has existed and the model sent schema order anyway, so the figure
    settles it instead of asking.
    """

    # The shape that broke rather than a reduction of it: eighteen empty categories are
    # the whole problem, and two of them are on either side of the ones that matter.
    COLUMNS = [f"column_{index:02d}" for index in range(20)]
    RATIOS = [0.0] * 20
    RATIOS[13] = 12.4
    RATIOS[17] = 3.1

    def _vertical(self, **layout):
        return new_plot([{"type": "bar", "x": self.COLUMNS, "y": self.RATIOS}], layout or None)

    def _horizontal(self, **layout):
        return new_plot(
            [{"type": "bar", "orientation": "h", "y": self.COLUMNS, "x": self.RATIOS}],
            layout or None,
        )

    def test_the_largest_bar_comes_first_along_the_bottom(self):
        assert self._vertical().layout["xaxis"]["categoryorder"] == "total descending"

    def test_the_largest_bar_comes_out_at_the_top_of_a_horizontal_axis(self):
        """Ascending, and it is not a contradiction. Plotly lays the first category out at
        the axis start, which is the left of an x axis and the BOTTOM of a y axis, so
        ascending up the left is the same instruction as descending along the bottom.
        Descending here would reproduce the bug: the twenty-column chart was horizontal.
        """

        assert self._horizontal().layout["yaxis"]["categoryorder"] == "total ascending"

    def test_only_the_axis_carrying_the_names_is_ordered(self):
        """A category order on the value axis is a key Plotly ignores, and a chart reported
        as sorted while it is not is worse than one that was never sorted."""

        assert "categoryorder" not in self._vertical().layout["yaxis"]
        assert "categoryorder" not in self._horizontal().layout["xaxis"]

    def test_the_ordered_axis_is_the_one_the_layout_calls_categorical(self):
        """Two places decide which axis holds the categories: the axis defaults, which take
        the gridlines off it, and the ordering. They are separate checks over the same
        traces, so this pins them together rather than trusting them to agree."""

        for chart, name in ((self._vertical(), "xaxis"), (self._horizontal(), "yaxis")):
            axis = chart.layout[name]
            assert axis["showgrid"] is False
            assert "categoryorder" in axis

    def test_the_points_reach_the_browser_in_the_order_they_were_sent(self):
        """Which is the reason the order is an axis setting and not a sort of the arrays.
        Plotly re-orders the categories; the parallel arrays a bar carries -- its colours,
        its printed values, its full names for the tooltip -- stay attached to their own
        bar. Permuting five arrays by hand is how a bar wears another bar's label."""

        colours = [EMPHASIS if ratio == max(self.RATIOS) else BLUE for ratio in self.RATIOS]
        labels = [f"{ratio}%" for ratio in self.RATIOS]
        chart = new_plot(
            [
                {
                    "type": "bar",
                    "x": self.COLUMNS,
                    "y": self.RATIOS,
                    "marker": {"color": colours},
                    "text": labels,
                }
            ]
        )
        assert chart.data[0]["x"] == self.COLUMNS
        assert chart.data[0]["y"] == self.RATIOS
        assert chart.data[0]["marker"]["color"] == colours
        assert chart.data[0]["text"] == labels

    @pytest.mark.parametrize(
        "periods",
        [
            ["2026-01", "2026-02", "2026-03"],
            ["2026-01-15", "2026-02-15", "2026-03-15"],
            ["Jan 2026", "Feb 2026", "Mar 2026"],
            ["January 2026", "February 2026", "March 2026"],
            ["2026-Q1", "2026-Q2", "2026-Q3"],
            ["Q1 2026", "Q2 2026", "Q3 2026"],
            ["2024", "2025", "2026"],
            ["2026-W01", "2026-W02", "2026-W03"],
            ["week 1", "week 2", "week 3"],
            ["15/01/2026", "15/02/2026", "15/03/2026"],
        ],
    )
    def test_a_bar_chart_of_periods_keeps_the_order_it_was_sent(self, periods):
        """A bar chart of months is a time series drawn with bars. Sorting one by size
        destroys the trend, which is the only thing a period axis is for. The brief asks
        for a line here and gets a bar often enough that this has to hold."""

        chart = new_plot([{"type": "bar", "x": periods, "y": [5, 90, 2]}])
        assert "categoryorder" not in chart.layout["xaxis"]

    def test_one_period_among_the_names_is_enough_to_leave_the_order_alone(self):
        """Deliberately the cautious direction. Not sorting one odd breakdown is a chart
        that reads awkwardly; sorting twelve months and an "Unknown" bucket by size is a
        chart that is wrong about what it shows."""

        chart = new_plot([{"type": "bar", "x": ["2026-01", "2026-02", "Unknown"], "y": [5, 90, 2]}])
        assert "categoryorder" not in chart.layout["xaxis"]

    def test_an_order_the_model_stated_is_not_overruled(self):
        """`categoryarray` is the model saying these categories are ordinal, or that it has
        ranked them by something better than their own size. Low, medium, high sorted by
        value is not an improvement on low, medium, high."""

        stated = self._vertical(xaxis={"categoryarray": self.COLUMNS})
        assert "categoryorder" not in stated.layout["xaxis"]
        assert stated.layout["xaxis"]["categoryarray"] == self.COLUMNS
        by_name = self._vertical(xaxis={"categoryorder": "category ascending"})
        assert by_name.layout["xaxis"]["categoryorder"] == "category ascending"

    def test_a_declared_numeric_or_date_axis_is_not_a_category_axis(self):
        for kind in ("date", "linear", "log"):
            chart = self._vertical(xaxis={"type": kind})
            assert "categoryorder" not in chart.layout["xaxis"], kind

    def test_a_line_drawn_over_the_same_categories_is_not_re_ordered(self):
        """A trend re-ordered by size is a different claim about the data than the one the
        model made, so a figure with anything but bars in it is left as sent."""

        chart = new_plot(
            [
                {"type": "bar", "x": self.COLUMNS, "y": self.RATIOS, "name": "measure"},
                {
                    "type": "scatter",
                    "mode": "lines",
                    "x": self.COLUMNS,
                    "y": self.RATIOS,
                    "name": "trend",
                },
            ]
        )
        assert "categoryorder" not in chart.layout["xaxis"]

    def test_shapes_with_no_categories_to_rank_are_left_alone(self):
        """A histogram bins raw values, and a pie has no cartesian axes at all."""

        histogram = new_plot([{"type": "histogram", "x": [1, 2, 2, 3]}])
        assert "categoryorder" not in histogram.layout["xaxis"]
        assert "xaxis" not in new_plot([_SLIVER_PIE]).layout

    def test_numbers_on_the_category_axis_are_left_alone(self):
        chart = new_plot([{"type": "bar", "x": [2024, 2025, 2026], "y": [5, 90, 2]}])
        assert "categoryorder" not in chart.layout["xaxis"]

    def test_a_single_category_has_no_order(self):
        """One bar cannot be sorted, and a setting that fired where nothing was ranked
        reads as though a rule applied when none did."""

        chart = new_plot([{"type": "bar", "x": ["only"], "y": [1]}])
        assert "categoryorder" not in chart.layout["xaxis"]

    def test_several_series_are_ranked_by_their_total(self):
        """Plotly sums each category across every trace, so a grouped or stacked bar comes
        out ranked without this module deciding what the total of a stack is."""

        chart = new_plot(
            [
                {"type": "bar", "x": ["p", "q", "r"], "y": [1, 9, 2], "name": "first"},
                {"type": "bar", "x": ["p", "q", "r"], "y": [3, 1, 4], "name": "second"},
            ],
            {"barmode": "stack"},
        )
        assert chart.layout["xaxis"]["categoryorder"] == "total descending"

    def test_ordering_leaves_the_label_arrangement_where_it_was(self):
        """Sorting is a separate concern from the layout fix that put the legend in its own
        band and wrapped long names instead of rotating them. Ordering a chart must not
        quietly pick any of that up."""

        chart = new_plot([{"type": "bar", "x": LONG_TITLES, "y": LONG_SHARES, "name": "share"}])
        assert chart.layout["xaxis"]["categoryorder"] == "total descending"
        assert chart.layout["legend"]["yref"] == "container"
        assert chart.layout["margin"] == {"l": 8, "r": 8, "t": 8, "b": 8}
        assert chart.layout["xaxis"]["automargin"] is True
        assert "tickangle" not in chart.layout["xaxis"]
        for tick in chart.data[0]["x"]:
            assert len(tick.split("<br>")) <= TICK_LINE_LIMIT

    def test_the_brief_stops_asking_the_model_for_what_the_figure_guarantees(self):
        """And says what it does instead. A brief that still asked for a sort would leave a
        reader of it unable to tell which of the two was in charge."""

        assert "sorted for you" in PLOT_INSTRUCTIONS
        assert "Sort a ranked bar chart by value." not in PLOT_INSTRUCTIONS
        # The half that is still the model's call, because it needs to know what a zero
        # means and this module only knows that it is a zero.
        assert "Never leave out a category that has a value" in PLOT_INSTRUCTIONS

    def test_a_second_time_panel_must_add_real_evidence(self):
        assert "one line chart for the complete period" in PLOT_INSTRUCTIONS
        assert "one bar chart for the recent window" in PLOT_INSTRUCTIONS
        assert "never infer an event boundary or manufacture a subset" in PLOT_INSTRUCTIONS
        assert "must answer a distinct evidence question" in PLOT_INSTRUCTIONS


class TestTheLayoutIsSharedRatherThanPerChart:
    """Every chart the agent can produce comes through `new_plot`, so the arrangement is
    written once. A fix applied per chart shape breaks on the next question."""

    def test_every_shape_gets_the_same_arrangement_from_the_same_place(self):
        shared = {
            repr(
                {
                    "margin": sorted(chart.layout["margin"].items()),
                    "legend": sorted(
                        (key, value)
                        for key, value in chart.layout["legend"].items()
                        if key != "font"
                    ),
                }
            )
            for chart in _figures()
            if chart.kind != "pie"
        }
        assert len(shared) == 1

    def test_the_arrangement_is_derived_from_the_traces_and_not_hardcoded_per_call(self):
        """The same two calls that differ only in shape get different legend edges, which is
        what makes one code path able to serve both."""

        bar = new_plot([_bar(name="a"), _bar(name="b")]).layout["legend"]
        pie = new_plot([_SLIVER_PIE]).layout["legend"]
        assert bar["yref"] == "container" and pie["xref"] == "container"
        assert bar["orientation"] == "h" and pie["orientation"] == "v"

    def test_a_shape_this_test_file_has_never_seen_still_gets_the_arrangement(self):
        """The agent writes the spec, so the next question can produce a combination none of
        these tests names. It has to arrive laid out anyway."""

        chart = new_plot(
            [
                {"type": "bar", "x": LONG_TITLES, "y": LONG_SHARES, "name": "measure"},
                {
                    "type": "scatter",
                    "mode": "lines",
                    "x": LONG_TITLES,
                    "y": LONG_SHARES,
                    "name": "trend",
                },
            ],
            {"barmode": "stack"},
        )
        assert chart.kind == "combo"
        assert chart.layout["legend"]["yref"] == "container"
        assert chart.layout["xaxis"]["automargin"] is True
        for trace in chart.data:
            for tick in trace["x"]:
                assert len(tick.split("<br>")) <= TICK_LINE_LIMIT


class TestDeclines:
    """Nothing to draw, told apart from a spec this tool will not draw.

    THE SUBCLASS IS THE CONTRACT AND NOTHING PINNED IT. `agent.py` catches
    `EmptyChartError` before `ChartError` and reports it as a decline: the step
    ends green and no chart is drawn. Every other `ChartError` is a rejection.
    That distinction shipped with no test of its own, so collapsing the subclass
    back into its parent -- one line, and it would look like a simplification --
    would silently restore the amber badge on every run whose data held no
    series, which is the defect it was written to remove.
    """

    def test_no_traces_at_all_is_a_decline(self):
        # The shape a model sends when it has decided there is nothing to plot:
        # `data` is a required argument, so declining still means calling the tool.
        with pytest.raises(EmptyChartError):
            new_plot([])

    def test_none_is_the_renderer_independent_no_chart_sentinel(self):
        with pytest.raises(EmptyChartError):
            new_plot(None)

    def test_traces_carrying_no_points_are_a_decline(self):
        with pytest.raises(EmptyChartError):
            new_plot([{"type": "bar", "x": [], "y": []}])

    def test_a_decline_reads_as_an_account_rather_than_a_demand(self):
        """The message reaches a reader, in the trace, under a step that is green."""

        for empty in ([], [{"type": "bar", "x": [], "y": []}]):
            with pytest.raises(EmptyChartError) as raised:
                new_plot(empty)
            assert "nothing to draw" in str(raised.value)
            # The sentence a reader had already learnt to read as a breakage.
            assert "must be" not in str(raised.value)

    @pytest.mark.parametrize("wrong_shape", [{"type": "bar"}, "[]", 7])
    def test_a_data_argument_of_the_wrong_shape_is_not_a_decline(self, wrong_shape):
        """A serialization fault must stay visible instead of reading as empty data.

        `data` arriving as a dict or as a JSON string of a list is a spec
        in the wrong shape. It shared this branch with `data: []` and therefore
        shared its message, so a model that stringified its traces would have been
        filed as a dataset with no series and nobody would have gone looking. The
        step's amber no longer reaches the run's verdict, so there is nothing left
        to buy by softening it.
        """

        with pytest.raises(ChartError) as raised:
            new_plot(wrong_shape)
        assert not isinstance(raised.value, EmptyChartError)
        assert "must be a list" in str(raised.value)
        # Names what arrived, so the fault is diagnosable from the trace alone.
        assert type(wrong_shape).__name__ in str(raised.value)


class TestRejections:
    def test_a_trace_that_is_not_an_object_is_refused(self):
        with pytest.raises(ChartError, match="must be a chart series object"):
            new_plot(["not a trace"])

    def test_an_unsupported_trace_type_names_what_is_supported(self):
        with pytest.raises(ChartError, match="supported"):
            new_plot([{"type": "surface", "z": [[1, 2], [3, 4]]}])

    def test_a_multi_panel_grid_is_refused_with_the_recovery_path(self):
        with pytest.raises(ChartError, match="one panel per chart"):
            new_plot([_bar()], {"grid": {"rows": 2, "columns": 1}})

    def test_a_dropdown_is_refused(self):
        with pytest.raises(ChartError, match="updatemenus"):
            new_plot([_bar()], {"updatemenus": [{"buttons": []}]})

    def test_too_many_traces_is_refused(self):
        with pytest.raises(ChartError, match="one panel"):
            new_plot([_bar() for _ in range(MAX_TRACES + 1)])

    def test_an_unaggregated_result_set_is_refused(self):
        rows = MAX_POINTS_PER_TRACE + 1
        with pytest.raises(ChartError, match="aggregate"):
            new_plot([{"type": "bar", "x": list(range(rows)), "y": list(range(rows))}])


class TestRendererNeutralContract:
    def test_a_semantic_bar_spec_is_adapted_after_validation(self):
        chart = new_plot(
            spec={
                "kind": "bar",
                "series": [
                    {
                        "name": "players",
                        "x": ["alpha", "beta"],
                        "y": [12, 7],
                    }
                ],
                "x_title": "title",
                "y_title": "players",
            },
            title="Players by title",
        )

        assert chart.kind == "bar"
        assert chart.data[0]["type"] == "bar"
        assert chart.data[0]["x"] == ["alpha", "beta"]
        assert chart.layout["yaxis"]["title"] == {"text": "players"}

    def test_the_model_contract_does_not_require_renderer_objects(self):
        function = NEW_PLOT_TOOL["function"]
        encoded = str(function)

        assert function["parameters"]["required"] == ["outcome"]
        assert "spec" in function["parameters"]["properties"]
        assert "data" not in function["parameters"]["properties"]
        assert "Plotly" not in encoded


class TestGeneralPurpose:
    """The dataset is being replaced underneath this tool, so nothing about the data may
    be baked in. These are the four shapes the app has to cover."""

    def test_a_single_series_breakdown(self):
        chart = new_plot(
            [{"type": "bar", "x": ["north", "south"], "y": [12, 7], "name": "accounts"}],
            {"yaxis": {"title": {"text": "accounts"}}},
            title="Accounts by region",
        )
        assert chart.kind == "bar"
        assert chart.data[0]["x"] == ["north", "south"]

    def test_multiple_series_over_shared_categories(self):
        chart = new_plot(
            [
                {"type": "bar", "x": ["p", "q"], "y": [1, 2], "name": "first"},
                {"type": "bar", "x": ["p", "q"], "y": [3, 4], "name": "second"},
            ],
            {"barmode": "group"},
        )
        assert [t["name"] for t in chart.data] == ["first", "second"]
        assert chart.layout["barmode"] == "group"

    def test_a_time_series(self):
        chart = new_plot(
            [
                {
                    "type": "scatter",
                    "mode": "lines",
                    "x": ["2026-01-01", "2026-02-01"],
                    "y": [10, 14],
                    "name": "sessions",
                }
            ],
            {"xaxis": {"type": "date"}},
        )
        assert chart.kind == "line"
        assert chart.layout["xaxis"]["type"] == "date"

    def test_a_categorical_part_of_whole_split(self):
        chart = new_plot(
            [{"type": "pie", "labels": ["one", "two", "three"], "values": [50, 30, 20]}]
        )
        assert chart.kind == "pie"
        assert len(chart.data[0]["marker"]["colors"]) == 3

    def test_no_column_or_series_name_is_invented(self):
        """Whatever the caller passes through is what comes out; the module adds no labels."""

        chart = new_plot([{"type": "bar", "x": ["zz_unlikely"], "y": [1], "name": "qq_unlikely"}])
        rendered = repr(chart.data) + repr(chart.layout)
        assert "zz_unlikely" in rendered and "qq_unlikely" in rendered
        assert chart.title == ""
