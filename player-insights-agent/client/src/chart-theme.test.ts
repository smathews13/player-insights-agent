import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHART_THEME_ATTRIBUTE,
  readChartTheme,
  sameChartTheme,
  themedFigure,
  type ChartTheme,
  type FigureSpec,
} from './plotly-config';

/**
 * A stored chart spec, drawn in the theme that is on screen now.
 *
 * The defect this covers is not subtle and was reported as "the charts are black on
 * black". A spec is written by the agent when the answer is produced and stored beside
 * it, so every colour in it is a light-theme literal: #161616 on the labels, #EBEBEB
 * on the gridlines, white behind the tooltip. Nothing in a stylesheet can reach them
 * -- Plotly draws SVG from a JavaScript object -- so the theme has to be resolved in
 * the object, at draw time, over a copy.
 *
 * WHAT IS ASSERTED HERE AND WHY IT IS THE FUNCTION RATHER THAN THE FIGURE. There is no
 * browser in this repository, so nothing here has seen a chart. What a pure function
 * can be held to is exactly the part that was wrong: which slot took which token, that
 * the answer's own object was not written to, and -- the half that matters more -- that
 * the two enhancements which are more than paint are refused on every shape they would
 * be a lie about. A "peak" on a scatter of two measures against each other is a claim
 * the agent never made, and this file is where that stays true.
 */

const SANS = "'DM Sans', system-ui, sans-serif";
/** `--font-mono` as tokens.css declares it, which is also the module's own fallback. */
const MONO = "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** The paints `tokens.css` resolves to at `:root`. */
const LIGHT: ChartTheme = {
  ink: '#161616',
  muted: '#6f6f6f',
  grid: '#ebebeb',
  surface: '#ffffff',
  accent: '#2272b4',
  second: '#04867d',
  third: '#4299e0',
  fourth: '#445461',
  mono: MONO,
};

/** The same slots under `html[data-theme='dark']`. */
const DARK: ChartTheme = {
  ink: '#f2f6fa',
  muted: 'rgba(232, 237, 242, 0.68)',
  grid: 'rgba(255, 255, 255, 0.12)',
  surface: '#11171c',
  accent: '#8fc1e8',
  // The teal is the one of the four that is not a blue, and it clears the contrast
  // floor on navy unaided, so the dark theme leaves it where it is.
  second: '#04867d',
  third: '#6faedd',
  fourth: '#8a9aa3',
  mono: MONO,
};

/**
 * WCAG 2.1 contrast between two hex colours.
 *
 * A local copy of the pair in `palette.test.ts`, which does not export them. Six lines
 * of arithmetic from a published formula is cheaper to repeat than a shared test helper
 * is to reach for, and a test that computes its own floor cannot drift from the one the
 * other file computes.
 */
function luminance(hex: string) {
  const channels = [1, 3, 5]
    .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The frame `agent/charts.py` writes around every cartesian figure.
 *
 * The three rule colours are what a spec stored BEFORE the grid was muted carries --
 * `charts.py` writes a translucent wash there now. Both are real inputs, since specs
 * are stored beside the answer that produced them and old answers are still read, and
 * the point of this fixture is that neither survives: the pass below overwrites all
 * three from the theme regardless of what it found.
 */
function cartesianLayout(): Record<string, unknown> {
  const axis = () => ({
    gridcolor: '#EBEBEB',
    zerolinecolor: '#EBEBEB',
    linecolor: '#EBEBEB',
    tickfont: { family: MONO, color: '#6F6F6F', size: 11 },
    automargin: true,
  });
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: SANS, color: '#161616', size: 12 },
    hoverlabel: { bgcolor: '#ffffff', bordercolor: '#EBEBEB', font: { family: MONO, color: '#161616', size: 12 } },
    legend: { orientation: 'h', x: 0, font: { family: SANS, color: '#161616', size: 11 } },
    colorway: ['#2272B4', '#04867D'],
    xaxis: { ...axis(), showgrid: false, title: { text: 'Date' } },
    yaxis: { ...axis(), showgrid: true, tickformat: ',' },
  };
}

/** One time series over five days, rising to its last value. The 31d full-window line. */
function lineSpec(overrides: Record<string, unknown> = {}): FigureSpec {
  return {
    kind: 'line',
    data: [
      {
        type: 'scatter',
        mode: 'lines',
        name: 'Sessions',
        x: ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18'],
        y: [118, 204, 361, 402, 482],
        line: { color: '#2272B4', width: 2 },
        marker: { color: '#2272B4', size: 6 },
        ...overrides,
      },
    ],
    layout: cartesianLayout(),
  };
}

/** Two measures against each other. A cloud of points, with no order and no peak. */
function scatterSpec(): FigureSpec {
  return {
    kind: 'scatter',
    data: [
      {
        type: 'scatter',
        mode: 'markers',
        name: 'Session length against bookings',
        x: [31.4, 45.15, 38.6, 22.8],
        y: [214.55, 1381.16, 902.4, 88.2],
        marker: { color: '#2272B4', size: 6 },
      },
    ],
    layout: cartesianLayout(),
  };
}

/** The launch-week panel: two series over the same five days, peaking on the last. */
function datedBarSpec(): FigureSpec {
  return {
    kind: 'bar',
    data: [
      {
        type: 'bar',
        name: 'Sessions',
        x: ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18'],
        y: [118, 204, 361, 402, 482],
        marker: { color: '#2272B4' },
      },
      {
        type: 'bar',
        name: 'Active players',
        x: ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18'],
        y: [96, 160, 288, 320, 371],
        marker: { color: '#04867D' },
      },
    ],
    layout: cartesianLayout(),
  };
}

/** A ranked breakdown. The agent sorts it by value, so its order is not a sequence. */
function rankedBarSpec(): FigureSpec {
  const layout = cartesianLayout();
  // The agent pins the order it ranked into, rather than leaving Plotly to infer one.
  layout.xaxis = { ...(layout.xaxis as Record<string, unknown>), categoryorder: 'total descending' };
  return {
    kind: 'bar',
    data: [
      {
        type: 'bar',
        name: 'Sessions',
        x: ['GB', 'DE', 'FR', 'ES'],
        y: [482, 96, 61, 44],
        marker: { color: '#2272B4' },
      },
    ],
    layout,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** One trace or layout branch, as a record, so a test can read into it without casts. */
function at(value: unknown): Record<string, unknown> {
  expect(value, 'expected an object here').toBeTypeOf('object');
  return value as Record<string, unknown>;
}

const PLOT_SOURCE = readFileSync(new URL('./PlotlyFigure.tsx', import.meta.url), 'utf8');
const SCHEME_SOURCE = readFileSync(new URL('./color-scheme.ts', import.meta.url), 'utf8');

describe('the theme is resolved into the figure, one slot at a time', () => {
  it('paints text, ticks, grid and tooltip from the dark tokens', () => {
    const { layout } = themedFigure(lineSpec(), DARK);

    expect(at(layout.font).color).toBe(DARK.ink);
    expect(at(at(layout.hoverlabel).font).color).toBe(DARK.ink);
    expect(at(layout.hoverlabel).bgcolor).toBe(DARK.surface);
    expect(at(layout.hoverlabel).bordercolor).toBe(DARK.grid);
    for (const name of ['xaxis', 'yaxis']) {
      const axis = at(layout[name]);
      expect(axis.gridcolor, name).toBe(DARK.grid);
      expect(axis.zerolinecolor, name).toBe(DARK.grid);
      expect(axis.linecolor, name).toBe(DARK.grid);
      // A hairline, stated: Plotly's own default is 1px and a spec is free to say
      // otherwise, and a 2px grid is the loudest thing on a small panel.
      expect(axis.gridwidth, name).toBe(1);
    }
  });

  it('sets every axis label in mono at the size the panel has room for', () => {
    const { layout } = themedFigure(lineSpec(), LIGHT);
    for (const name of ['xaxis', 'yaxis']) {
      const ticks = at(at(layout[name]).tickfont);
      expect(ticks.size, name).toBe(8);
      expect(ticks.family, name).toBe(LIGHT.mono);
      expect(ticks.color, name).toBe(LIGHT.muted);
    }
    // The axis title is a caption on the axis, not a mark, so it follows the
    // secondary rung rather than the ink one.
    expect(at(at(at(layout.xaxis).title).font).color).toBe(LIGHT.muted);
  });

  it('keeps the figure transparent so the panel behind it is the surface', () => {
    // Both themes, because the failure is asymmetric: a spec that named white
    // would lay a white slab on the night sky, and one that named the navy would
    // do the same thing to the light theme the day the agent is retuned.
    for (const theme of [LIGHT, DARK]) {
      const { layout } = themedFigure(
        { ...lineSpec(), layout: { ...cartesianLayout(), paper_bgcolor: '#ffffff' } },
        theme
      );
      expect(layout.paper_bgcolor).toBe('rgba(0,0,0,0)');
      expect(layout.plot_bgcolor).toBe('rgba(0,0,0,0)');
    }
  });

  it('maps the agent’s palette slot for slot rather than by trace position', () => {
    // The spec names `--chart-1` and `--chart-2` by value. Recognising the value
    // is what lets the token layer move a series -- the dark theme moves the
    // first and the third -- and have the figure follow, and it is also what
    // leaves a colour the model chose for a reason alone.
    const dark = themedFigure(datedBarSpec(), DARK);
    expect(at(at(dark.data[0]).marker).color).toContain(DARK.accent);
    expect(at(at(dark.data[1]).marker).color).toContain(DARK.second);

    const chosen = themedFigure(
      { ...rankedBarSpec(), data: [{ type: 'bar', x: ['GB', 'DE'], y: [2, 1], marker: { color: '#7a5e32' } }] },
      DARK
    );
    expect(at(at(chosen.data[0]).marker).color).toBe('#7a5e32');
  });

  it('maps the fourth series too, which had no slot and so stayed a light-theme colour', () => {
    /*
     * The bug: `agent/charts.py` assigns four series colours and this file mapped
     * three, so a fourth line kept #445461 on the night sky. That measures 2.0:1
     * against the dark card, under the 3:1 a graphic needs to be seen at all --
     * a line that is present, correct, and invisible.
     *
     * Asserted on a line rather than a bar because four series is where lines are:
     * `charts.py` separates past four by dash weight, not by inventing a hue.
     */
    const four: FigureSpec = {
      kind: 'line',
      data: ['#2272B4', '#04867D', '#4299E0', '#445461'].map((color, index) => ({
        type: 'scatter',
        mode: 'lines',
        x: ['2026-01-01', '2026-01-02'],
        y: [index, index + 1],
        line: { color },
      })),
      layout: cartesianLayout(),
    };
    const { data } = themedFigure(four, DARK);
    expect(data.map((trace) => at(at(trace).line).color)).toEqual([DARK.accent, DARK.second, DARK.third, DARK.fourth]);
  });

  it('gives every dark series enough contrast on the night sky to be seen', () => {
    // 3:1 is the floor for a graphical object, and the fourth series was the one
    // under it. Computed rather than asserted as a hex, so a future repaint of any
    // slot has to clear the same bar instead of only matching a literal.
    for (const [slot, colour] of Object.entries({
      accent: DARK.accent,
      second: DARK.second,
      third: DARK.third,
      fourth: DARK.fourth,
    })) {
      expect(contrast(colour, DARK.surface), `${slot} on the night sky`).toBeGreaterThanOrEqual(3);
    }
  });

  it('follows the surface with a pie’s slice separators, which the spec draws in white', () => {
    const pie: FigureSpec = {
      kind: 'pie',
      data: [
        {
          type: 'pie',
          labels: ['GB', 'DE'],
          values: [482, 96],
          marker: { colors: ['#2272B4', '#04867D'], line: { color: '#ffffff', width: 1 } },
        },
      ],
      layout: { font: { color: '#161616' }, legend: { font: { color: '#161616' } } },
    };
    const { data, layout } = themedFigure(pie, DARK);
    expect(at(at(at(data[0]).marker).line).color).toBe(DARK.surface);
    expect(at(at(data[0]).marker).colors).toEqual([DARK.accent, DARK.second]);
    // A pie has no axes, and a pair of empty ones would be two keys Plotly
    // ignores and a reader has to work out the reason for.
    expect(layout).not.toHaveProperty('xaxis');
  });
});

describe('the answer’s own chart object is never written to', () => {
  it('draws a frozen spec in both themes without touching it', () => {
    // Frozen rather than compared, because the module is an ES module and so runs
    // in strict mode: a write to a frozen object throws rather than being missed
    // by whichever key the comparison forgot to look at.
    const spec = deepFreeze(datedBarSpec());
    const before = JSON.stringify(spec);

    expect(() => themedFigure(spec, DARK)).not.toThrow();
    expect(() => themedFigure(spec, LIGHT)).not.toThrow();
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('hands back a copy, so two panels of one chart cannot share a repaint', () => {
    // The case this is written against: the same answer object is drawn in the
    // transcript and again in the Run Explorer's stage detail. A pass that
    // repainted its input would leave the second draw holding the first's theme.
    const spec = lineSpec();
    const dark = themedFigure(spec, DARK);
    const light = themedFigure(spec, LIGHT);

    expect(dark.data[0]).not.toBe(spec.data[0]);
    expect(dark.layout).not.toBe(spec.layout);
    expect(at(at(dark.data[0]).line).color).toBe(DARK.accent);
    expect(at(at(light.data[0]).line).color).toBe(LIGHT.accent);
    // And the spec still says what the agent wrote.
    expect(at(at(spec.data[0]).line).color).toBe('#2272B4');
  });

  it('carries every point, label and hover value across verbatim', () => {
    const spec = lineSpec({ hovertext: ['a', 'b', 'c', 'd', 'e'], customdata: [1, 2, 3, 4, 5] });
    const { data } = themedFigure(spec, DARK);
    const drawn = at(data[0]);

    expect(drawn.x).toEqual(at(spec.data[0]).x);
    expect(drawn.y).toEqual(at(spec.data[0]).y);
    expect(drawn.hovertext).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(drawn.customdata).toEqual([1, 2, 3, 4, 5]);
    expect(drawn.name).toBe('Sessions');
  });

  it('leaves a category order the agent settled exactly where it was', () => {
    const { layout } = themedFigure(rankedBarSpec(), DARK);
    expect(at(layout.xaxis).categoryorder).toBe('total descending');
    const { data } = themedFigure(rankedBarSpec(), DARK);
    expect(at(data[0]).x).toEqual(['GB', 'DE', 'FR', 'ES']);
  });
});

describe('the line treatment, and the two things it is allowed to add', () => {
  it('draws the stroke at the design’s weight in the action colour', () => {
    const { data } = themedFigure(lineSpec(), DARK);
    expect(at(at(data[0]).line).width).toBe(1.8);
    expect(at(at(data[0]).line).color).toBe(DARK.accent);
  });

  it('fills the area under a single ordered time series at 12%', () => {
    const dark = themedFigure(lineSpec(), DARK);
    expect(at(dark.data[0]).fill).toBe('tozeroy');
    expect(at(dark.data[0]).fillcolor).toBe('rgba(143, 193, 232, 0.12)');

    const light = themedFigure(lineSpec(), LIGHT);
    expect(at(light.data[0]).fillcolor).toBe('rgba(34, 114, 180, 0.12)');
  });

  it('does not fill one when the spec has said not to', () => {
    // `fill: 'none'` is the spec declining. Absent is the spec not mentioning it,
    // which is the case above, and the two must not be read as one.
    const { data } = themedFigure(lineSpec({ fill: 'none' }), DARK);
    expect(at(data[0]).fill).toBe('none');
    expect(at(data[0])).not.toHaveProperty('fillcolor');
  });

  it('does not fill under a comparison of two lines', () => {
    const spec = lineSpec();
    const second = { ...at(spec.data[0]), name: 'Active players', y: [96, 160, 288, 320, 371] };
    const { data, layout } = themedFigure({ ...spec, data: [at(spec.data[0]), second] }, DARK);

    // Two areas overlapping is not a reading of anything, and neither series is
    // "the" window. Both still get the stroke weight, because a figure with two
    // line weights in it reads as two kinds of claim.
    for (const trace of data) expect(at(at(trace).line).width).toBe(1.8);
    for (const trace of data) expect(at(trace)).not.toHaveProperty('fill');
    expect(layout).not.toHaveProperty('shapes');
    expect(data).toHaveLength(2);
  });

  it('marks the peak of an unambiguous time series, and marks it once', () => {
    const { data, layout } = themedFigure(lineSpec(), DARK);
    const shapes = layout.shapes as Record<string, unknown>[];

    expect(shapes).toHaveLength(1);
    expect(shapes[0].x0).toBe('2026-07-18');
    expect(shapes[0].x1).toBe('2026-07-18');
    expect(at(shapes[0].line).dash).toBe('dot');
    expect(at(shapes[0].line).color).toBe(DARK.accent);

    // The dot is a marker-only trace: a shape is sized in data coordinates and a
    // 3.5px dot has to be 3.5px whatever the values are.
    expect(data).toHaveLength(2);
    const dot = at(data[1]);
    expect(dot.x).toEqual(['2026-07-18']);
    expect(dot.y).toEqual([482]);
    expect(at(dot.marker).size).toBe(7);
    // It carries no reading of its own: the point underneath it has the tooltip,
    // and two tooltips on one datum is the peak reported twice.
    expect(dot.hoverinfo).toBe('skip');
    expect(dot.showlegend).toBe(false);
  });

  it('marks no peak when the largest value is shared', () => {
    // Two equal maxima is a figure with no single peak in it. Picking one would
    // be this file deciding which of the agent's numbers to point at.
    const { data, layout } = themedFigure(lineSpec({ y: [118, 482, 361, 402, 482] }), DARK);
    expect(layout).not.toHaveProperty('shapes');
    expect(data).toHaveLength(1);
  });

  it('marks no peak when the x axis is not an ordered run of timestamps', () => {
    // A line over categories is a trend, and the categories may have been sorted
    // by value, so "the last one" and "the largest" mean nothing about time.
    const overCategories = lineSpec({ x: ['GB', 'DE', 'FR', 'ES', 'IT'] });
    const { data, layout } = themedFigure(overCategories, DARK);
    expect(layout).not.toHaveProperty('shapes');
    expect(data).toHaveLength(1);
    expect(at(data[0])).not.toHaveProperty('fill');
    // Out-of-order dates are the same refusal: those are a scatter over time.
    const shuffled = lineSpec({ x: ['2026-07-16', '2026-07-14', '2026-07-15', '2026-07-18', '2026-07-17'] });
    expect(themedFigure(shuffled, DARK).layout).not.toHaveProperty('shapes');
  });

  it('adds nothing to a figure that already draws over itself', () => {
    // A spec carrying its own annotation has already said where to look. A
    // second marker beside it would be two pointers at one datum, and the first
    // one is the agent's.
    const annotated = lineSpec();
    annotated.layout = { ...annotated.layout, annotations: [{ text: '482 peak', x: '2026-07-18', y: 482 }] };
    const { data, layout } = themedFigure(annotated, DARK);

    expect(layout).not.toHaveProperty('shapes');
    expect(data).toHaveLength(1);
    // And the annotation it did carry is repainted, since its colour would
    // otherwise be the light theme's ink on the night sky.
    expect(at(at(layout.annotations as unknown[])[0]).font).toEqual({ color: DARK.ink });
  });

  it('does not invent a peak on an arbitrary scatter', () => {
    // THE ONE THIS FILE EXISTS FOR. Session length against bookings has a
    // largest y like any other set of numbers, and no peak: nothing in it is
    // "the latest", so a dot on its highest point would be a claim about a
    // sequence that is not there. Same for the area fill -- there is no window
    // to fill under.
    const { data, layout } = themedFigure(scatterSpec(), DARK);

    expect(layout).not.toHaveProperty('shapes');
    expect(data).toHaveLength(1);
    expect(at(data[0])).not.toHaveProperty('fill');
    // It is still themed: the markers take the action colour so the cloud is
    // visible on either surface.
    expect(at(at(data[0]).marker).color).toBe(DARK.accent);
  });
});

describe('the bar treatment dims a run of days and nothing else', () => {
  it('drops every column but the last when the last day is the peak', () => {
    const { data } = themedFigure(datedBarSpec(), DARK);
    const sessions = at(at(data[0]).marker).color as string[];
    const players = at(at(data[1]).marker).color as string[];

    expect(sessions).toHaveLength(5);
    expect(sessions[4]).toBe(DARK.accent);
    expect(new Set(sessions.slice(0, 4))).toEqual(new Set(['rgba(143, 193, 232, 0.42)']));
    // The paired series is dimmed on the same day, in its own colour.
    expect(players[4]).toBe(DARK.second);
    expect(new Set(players.slice(0, 4))).toEqual(new Set(['rgba(4, 134, 125, 0.42)']));
  });

  it('does not relabel or reorder the days it dims', () => {
    const spec = datedBarSpec();
    const { data } = themedFigure(spec, DARK);
    expect(at(data[0]).x).toEqual(at(spec.data[0]).x);
    expect(at(data[0]).y).toEqual(at(spec.data[0]).y);
  });

  it('keeps one weight across a ranked breakdown', () => {
    // The agent sorts a ranked bar chart by value, so its last bar is its
    // SMALLEST. Dimming three of four bars here would point at the wrong one,
    // and pointing at the largest would duplicate what the sort already says.
    const { data } = themedFigure(rankedBarSpec(), LIGHT);
    expect(at(at(data[0]).marker).color).toBe(LIGHT.accent);
  });

  it('keeps one weight when the peak is not the last day', () => {
    const midweek = datedBarSpec();
    midweek.data = [{ ...at(midweek.data[0]), y: [118, 204, 482, 402, 361] }];
    const { data } = themedFigure(midweek, DARK);
    expect(at(at(data[0]).marker).color).toBe(DARK.accent);
  });

  it('leaves a per-point colour list the model wrote alone, apart from the paint', () => {
    // A list is the model pointing at one bar, which is a meaning rather than a
    // default. Its entries are mapped onto the theme; its length and order are
    // not touched, so whichever bar it pointed at keeps the mark.
    const emphasised = datedBarSpec();
    emphasised.data = [
      { ...at(emphasised.data[0]), marker: { color: ['#2272B4', '#2272B4', '#2272B4', '#2272B4', '#FF3621'] } },
    ];
    const { data } = themedFigure(emphasised, DARK);
    expect(at(at(data[0]).marker).color).toEqual([DARK.accent, DARK.accent, DARK.accent, DARK.accent, '#FF3621']);
  });
});

describe('the theme is read off the document, and re-read when it changes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDocument(properties: Record<string, string>) {
    const root = { nodeName: 'HTML' };
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('getComputedStyle', (element: unknown) => {
      expect(element, 'the theme is read off <html>').toBe(root);
      return { getPropertyValue: (name: string) => properties[name] ?? '' };
    });
    return root;
  }

  it('reads the light tokens as the light theme paints them', () => {
    stubDocument({
      '--foreground': ' #161616',
      '--muted-foreground': '#6f6f6f',
      '--border': '#ebebeb',
      '--background': '#ffffff',
      '--chart-1': '#2272b4',
      '--chart-2': '#04867d',
      '--chart-3': '#4299e0',
      '--chart-4': '#445461',
      '--font-mono': MONO,
    });
    expect(readChartTheme()).toEqual(LIGHT);
  });

  it('reads the night-sky tokens once the attribute is on the document', () => {
    stubDocument({
      '--foreground': '#f2f6fa',
      '--muted-foreground': 'rgba(232, 237, 242, 0.68)',
      '--border': 'rgba(255, 255, 255, 0.12)',
      '--background': '#11171c',
      '--chart-1': '#8fc1e8',
      '--chart-2': '#04867d',
      '--chart-3': '#6faedd',
      '--chart-4': '#8a9aa3',
      '--font-mono': MONO,
    });
    expect(readChartTheme()).toEqual(DARK);
  });

  it('falls back to the light palette where there is no document to read', () => {
    // Server rendering and the tests. The honest fallback is what `:root`
    // declares, which is also what the agent already wrote into the spec, so a
    // figure drawn without a document looks exactly as it did before.
    expect(readChartTheme(null)).toEqual(LIGHT);
  });

  it('falls back per slot, so one missing token does not blank the rest', () => {
    stubDocument({ '--foreground': '#f2f6fa' });
    const theme = readChartTheme();
    expect(theme.ink).toBe('#f2f6fa');
    expect(theme.grid).toBe(LIGHT.grid);
  });

  it('tells two readings apart, so an unrelated attribute write redraws nothing', () => {
    expect(sameChartTheme(LIGHT, { ...LIGHT })).toBe(true);
    expect(sameChartTheme(LIGHT, DARK)).toBe(false);
    expect(sameChartTheme(LIGHT, { ...LIGHT, grid: '#ffffff' })).toBe(false);
  });

  it('watches the one attribute Appearance actually writes', () => {
    // Settings > Appearance flips the theme in place: no fetch, no route change,
    // nothing React re-renders from. A plot already on screen would keep the
    // paint it mounted with, which is what makes the preview look broken. The
    // attribute name is taken from the module that writes it rather than
    // restated, because a private copy of the string is how the two come apart.
    expect(CHART_THEME_ATTRIBUTE).toBe('data-theme');
    expect(SCHEME_SOURCE).toContain("root.setAttribute('data-theme', scheme)");
    expect(PLOT_SOURCE).toContain('new MutationObserver(follow)');
    expect(PLOT_SOURCE).toContain('attributeFilter: [CHART_THEME_ATTRIBUTE]');
    expect(PLOT_SOURCE).toContain('document.documentElement');
    // Re-read on mount as well: the first paint happens before the saved scheme
    // is applied, so the initial reading can be the default rather than the
    // choice, and no attribute write follows to correct it.
    expect(PLOT_SOURCE).toMatch(/follow\(\);\s*const watcher = new MutationObserver/);
  });

  it('redraws on a theme change rather than only on new data', () => {
    // The dependency list is the whole mechanism: without `theme` in it the
    // observer would fire, state would change, and the figure on screen would
    // keep its old paint.
    expect(PLOT_SOURCE).toContain('}, [data, layout, kind, height, theme]);');
  });
});

describe('nothing the figure attaches outlives the panel', () => {
  it('disconnects both observers and purges the plot', () => {
    // Three separate leaks if any one is missed: Plotly's own listeners and
    // canvas stack live outside React's tree, the size observer holds the node,
    // and the theme observer holds <html> for the lifetime of the tab.
    expect(PLOT_SOURCE).toContain('observer.disconnect()');
    expect(PLOT_SOURCE).toContain('Plotly.purge(element)');
    expect(PLOT_SOURCE).toContain('return () => watcher.disconnect();');
  });

  it('draws through the one reviewed config, from one call site', () => {
    // chart-read-only.test.ts owns the contents of that object. What is asserted
    // here is that the theme pass did not become a second way to reach Plotly.
    const calls = PLOT_SOURCE.match(/Plotly\.react\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(PLOT_SOURCE).toContain('FIGURE_CONFIG)');
    expect(PLOT_SOURCE).toContain('themedFigure({ kind, data, layout }, theme)');
  });
});
