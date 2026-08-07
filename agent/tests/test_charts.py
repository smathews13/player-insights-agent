from __future__ import annotations

import pytest

from charts import (
    FILL_SERIES,
    GOLD,
    INK,
    MAX_POINTS_PER_TRACE,
    MAX_TRACES,
    RED,
    STROKE_SERIES,
    ChartError,
    contrast_on_white,
    new_plot,
)


def _bar(**overrides):
    trace = {"type": "bar", "x": ["a", "b", "c"], "y": [3, 2, 1]}
    trace.update(overrides)
    return trace


class TestPalette:
    def test_gold_is_absent_from_the_stroke_palette(self):
        """1.86:1 on white. A gold line or a 6px gold marker is not there at all."""

        assert GOLD in FILL_SERIES
        assert GOLD not in STROKE_SERIES

    def test_every_stroke_colour_clears_the_non_text_contrast_floor(self):
        for colour in STROKE_SERIES:
            assert contrast_on_white(colour) >= 3.0, colour

    def test_contrast_matches_the_measured_brand_values(self):
        # The same numbers index.css documents, so a token edit that changes one is
        # caught here rather than in a screenshot.
        assert contrast_on_white(RED) == pytest.approx(4.85, abs=0.02)
        assert contrast_on_white(GOLD) == pytest.approx(1.86, abs=0.02)
        assert contrast_on_white(INK) == pytest.approx(18.88, abs=0.05)

    def test_an_unparseable_colour_scores_zero_rather_than_passing(self):
        assert contrast_on_white("var(--pia-red)") == 0.0
        assert contrast_on_white("") == 0.0


class TestSeriesColouring:
    def test_the_first_series_is_brand_red(self):
        chart = new_plot([_bar()])
        assert chart.data[0]["marker"]["color"] == RED

    def test_categorical_series_get_distinct_colours(self):
        chart = new_plot([_bar(name=f"s{i}") for i in range(5)])
        colours = [trace["marker"]["color"] for trace in chart.data]
        assert len(set(colours)) == len(colours)

    def test_pale_fills_get_an_ink_outline_so_they_stay_visible(self):
        chart = new_plot([_bar(marker={"color": GOLD})])
        assert chart.data[0]["marker"]["line"]["color"] == INK

    def test_a_legible_fill_is_left_without_an_outline(self):
        chart = new_plot([_bar(marker={"color": RED})])
        assert "line" not in chart.data[0]["marker"]

    def test_lines_beyond_the_stroke_palette_are_separated_by_dash(self):
        traces = [{"type": "scatter", "mode": "lines", "x": [1, 2], "y": [1, 2]} for _ in range(6)]
        chart = new_plot(traces)
        first = chart.data[0]["line"]
        fifth = chart.data[len(STROKE_SERIES)]["line"]
        assert first["color"] == fifth["color"]
        assert first.get("dash", "solid") != fifth["dash"]

    def test_a_gold_line_supplied_by_the_model_is_replaced(self):
        """The model is told not to set colours; when it does anyway, an illegible
        stroke is a wrong chart reported as a good one, so it is overridden."""

        chart = new_plot(
            [{"type": "scatter", "mode": "lines", "x": [1], "y": [1], "line": {"color": GOLD}}]
        )
        assert chart.data[0]["line"]["color"] != GOLD
        assert contrast_on_white(chart.data[0]["line"]["color"]) >= 3.0

    def test_a_legible_line_colour_supplied_by_the_model_is_respected(self):
        chart = new_plot([{"type": "scatter", "x": [1], "y": [1], "line": {"color": INK}}])
        assert chart.data[0]["line"]["color"] == INK

    def test_per_point_colours_are_left_alone(self):
        """A colour list is the model highlighting one bar, which is a meaning, not a default."""

        highlight = [RED, INK, INK]
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


class TestRejections:
    def test_empty_data_is_refused(self):
        with pytest.raises(ChartError, match="non-empty list"):
            new_plot([])

    def test_a_non_list_is_refused(self):
        with pytest.raises(ChartError, match="non-empty list"):
            new_plot({"type": "bar"})

    def test_a_trace_with_no_points_is_refused(self):
        with pytest.raises(ChartError, match="nothing to draw"):
            new_plot([{"type": "bar", "x": [], "y": []}])

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
