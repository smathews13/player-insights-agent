import type { PlotConfig, PlotData, PlotLayout } from 'plotly.js-cartesian-dist-min';
import { egressPathAllowed } from './egress-policy';

export const FIGURE_CONFIG: PlotConfig = {
  displaylogo: false,
  displayModeBar: 'hover',
  responsive: true,
  scrollZoom: false,
  doubleClick: 'reset',
  editable: false,
  showAxisRangeEntryBoxes: false,
  showEditInChartStudio: false,
  showSendToCloud: false,
  get modeBarButtonsToRemove(): string[] {
    const reading = ['lasso2d', 'select2d', 'toggleSpikelines', 'autoScale2d'];
    return egressPathAllowed('chart-image') ? reading : [...reading, 'toImage'];
  },
};

/*
 * ---- Presentation, applied to a copy of the spec at draw time ----
 *
 * A chart spec is written by the agent and stored beside the answer, so every colour
 * in it is a STATIC LIGHT-THEME LITERAL: ink #161616 on the labels, #EBEBEB on the
 * gridlines, white behind the tooltip. Those were correct when this app had one
 * theme. On the night sky they are a figure drawn in near-black on near-black, with a
 * white tooltip flaring out of it, and no amount of stylesheet can reach inside an
 * SVG Plotly draws from a JavaScript object.
 *
 * So the theme is resolved HERE, at the moment of drawing, off the same custom
 * properties every other surface reads. Two rules govern everything below:
 *
 *   1. THE ANSWER'S DATA IS NEVER TOUCHED. `themedFigure` deep-copies both halves of
 *      the spec and writes only into the copy. `answer.charts` is shared with the
 *      transcript, the Run Explorer's stage detail and whatever is persisted, and a
 *      figure that repainted its own input would leave a light-theme chart holding
 *      dark-theme colours the moment it was drawn twice.
 *   2. NOTHING HERE INVENTS A FACT. Points, labels, hover text, category order and
 *      series names are carried across verbatim. What this file may change is how a
 *      thing is painted -- a colour, a stroke width, an opacity -- and the two
 *      enhancements that are more than paint (an area fill under a line, a marker on
 *      its peak) are each gated on the incoming figure already being unambiguously
 *      that shape. An arbitrary scatter of two measures against each other has a
 *      largest y value and no "peak", and a chart that labelled one would be
 *      inventing a claim the agent did not make.
 */

/** The attribute Settings > Appearance writes the scheme onto. See color-scheme.ts. */
export const CHART_THEME_ATTRIBUTE = 'data-theme';

/**
 * The paints one figure needs, resolved from the document rather than from a spec.
 *
 * Eight slots and no more: everything else in a spec is geometry, which is the same
 * in both themes. The four series slots exist because a spec names the agent's
 * palette by value, and mapping slot for slot is what lets the token layer move a
 * series colour -- as the dark theme already moves `--chart-1` and `--chart-3` -- and
 * have the charts follow.
 *
 * THERE WERE THREE, AND THE AGENT EMITS FOUR. A fourth series was painted in the
 * light theme's grey-blue whatever the surface, which is 2.31:1 on the night sky --
 * under the 3:1 a graphic needs to be seen at all. So a four-series chart had one
 * line the reader simply could not find, and it was the slot with no mapping rather
 * than the slot with a bad colour: nothing here was reading `--chart-4`.
 */
export interface ChartTheme {
  /** Figure text: the legend, the hover label, any value a spec prints beside a bar. */
  ink: string;
  /** Axis tick labels and axis titles, which are secondary to the marks. */
  muted: string;
  /** Gridlines, axis lines, zero lines, and the hover label's edge. */
  grid: string;
  /** The hover label's fill and a pie's slice separators: opaque in both themes. */
  surface: string;
  /** The action colour. The first series, and the line the design draws in blue. */
  accent: string;
  /** The second series. */
  second: string;
  /** The third series. */
  third: string;
  /** The fourth series, past which `agent/charts.py` separates by dash rather than hue. */
  fourth: string;
  /** The face every numeral on an axis is set in. */
  mono: string;
}

/** Which custom property fills each slot. */
const THEME_TOKENS: Record<keyof ChartTheme, string> = {
  ink: '--foreground',
  muted: '--muted-foreground',
  grid: '--border',
  surface: '--background',
  accent: '--chart-1',
  second: '--chart-2',
  third: '--chart-3',
  fourth: '--chart-4',
  mono: '--font-mono',
};

/**
 * What a slot resolves to when the document cannot be read.
 *
 * Server rendering and the tests are the two cases, and in both the honest answer is
 * the light theme: these are the values `tokens.css` declares at `:root` and the ones
 * `agent/charts.py` already writes into every spec, so a figure drawn without a
 * document looks exactly as it did before this file existed.
 */
const FALLBACK_THEME: ChartTheme = {
  ink: '#161616',
  muted: '#6f6f6f',
  grid: '#ebebeb',
  surface: '#ffffff',
  accent: '#2272b4',
  second: '#04867d',
  third: '#4299e0',
  fourth: '#445461',
  mono: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

/** The palette `agent/charts.py` assigns, in slot order: `--chart-1`, `-2`, `-3`, `-4`. */
const AGENT_SERIES = ['#2272b4', '#04867d', '#4299e0', '#445461'];

/** `INK` in `agent/charts.py`: the outline it draws around a pale fill, and label text. */
const AGENT_INK = '#161616';

/** The design's line weight. Lighter than Plotly's 2px default and than the spec's. */
const LINE_WIDTH = 1.8;

/** The area under a single time-series line, as a share of the accent colour. */
const AREA_ALPHA = 0.12;

/** A bar that is not the leading one. The design asks for 40-45%. */
const DIM_ALPHA = 0.42;

/** The peak marker's diameter, for the design's 3.5px dot. */
const PEAK_DOT = 7;

/** Tick labels. Small, because the marks are the figure and the axis is the caption. */
const AXIS_LABEL_SIZE = 8;

/** The legend, which Plotly draws and this file only paints. */
const LEGEND_LABEL_SIZE = 9;

const TRANSPARENT = 'rgba(0,0,0,0)';

/** A timestamp a warehouse column comes back as, and nothing looser. */
const TIMESTAMP = /^\d{4}-\d{2}(?:-\d{2})?(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

function styleReader(): ((element: Element) => CSSStyleDeclaration) | null {
  return typeof getComputedStyle === 'function' ? getComputedStyle : null;
}

/**
 * The theme as the document currently paints it.
 *
 * `documentElement` rather than the panel, because that is where `data-theme` lands
 * and where every token in `THEME_TOKENS` is declared. Reading the panel would work
 * and would also make each chart's paint depend on where it happened to be mounted.
 */
export function readChartTheme(root?: Element | null): ChartTheme {
  const element = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  const reader = styleReader();
  if (!element || !reader) return { ...FALLBACK_THEME };
  const computed = reader(element);
  const slots = Object.keys(THEME_TOKENS) as (keyof ChartTheme)[];
  const theme = { ...FALLBACK_THEME };
  for (const slot of slots) {
    const value = computed.getPropertyValue(THEME_TOKENS[slot])?.trim();
    if (value) theme[slot] = value;
  }
  return theme;
}

/** Whether two readings are the same paint, so an unrelated attribute write redraws nothing. */
export function sameChartTheme(one: ChartTheme, other: ChartTheme): boolean {
  return (Object.keys(THEME_TOKENS) as (keyof ChartTheme)[]).every((slot) => one[slot] === other[slot]);
}

/** A deep copy of the JSON a spec is made of. */
function copied<T>(value: T): T {
  if (Array.isArray(value)) return (value as unknown[]).map((item) => copied(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) copy[key] = copied(item);
    return copy as unknown as T;
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One nested object on the copy, created if the spec did not carry it. */
function branch(host: Record<string, unknown>, key: string): Record<string, unknown> {
  const next = record(host[key]);
  host[key] = next;
  return next;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function channels(colour: unknown): [number, number, number] | null {
  if (typeof colour !== 'string') return null;
  const text = colour.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1];
    const [red, green, blue] = [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16));
    return [red, green, blue];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (!rgb) return null;
  return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3]))];
}

/**
 * `colour` at `alpha`, or null for a notation this cannot take apart.
 *
 * Null rather than a guess: every caller has a do-nothing branch, so a token that
 * resolves to a colour space Plotly would not parse leaves the figure alone instead
 * of painting it in something invented.
 */
function withAlpha(colour: unknown, alpha: number): string | null {
  const rgb = channels(colour);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : null;
}

/** The theme's colour for an agent palette slot, or null for anything the model chose. */
function themedSeries(colour: unknown, theme: ChartTheme): string | null {
  const slot = AGENT_SERIES.indexOf(text(colour));
  if (slot < 0) return null;
  return [theme.accent, theme.second, theme.third, theme.fourth][slot];
}

/** A spec field as comparable text, and empty for anything that is not a string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function traceType(trace: Record<string, unknown>): string {
  return text(trace.type) || 'scatter';
}

/** A scatter trace that draws a line, which is what the agent emits for `kind: line`. */
function drawsALine(trace: Record<string, unknown>): boolean {
  if (traceType(trace) !== 'scatter') return false;
  return (text(trace.mode) || 'lines+markers').includes('lines');
}

/** Whether these category values are a strictly increasing run of timestamps. */
function orderedTimestamps(values: unknown): boolean {
  const points = list(values);
  if (points.length < 2) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of points) {
    if (typeof value !== 'string' || !TIMESTAMP.test(value.trim())) return false;
    const at = Date.parse(value.trim().replace(' ', 'T'));
    if (!Number.isFinite(at) || at <= previous) return false;
    previous = at;
  }
  return true;
}

function finiteNumbers(values: unknown): number[] | null {
  const points = list(values);
  if (points.length === 0) return null;
  const numbers: number[] = [];
  for (const value of points) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    numbers.push(value);
  }
  return numbers;
}

/** The index of the one largest value, or -1 when the largest is shared. */
function soleMaximum(values: number[]): number {
  let at = -1;
  let best = Number.NEGATIVE_INFINITY;
  let ties = 0;
  values.forEach((value, index) => {
    if (value > best) {
      best = value;
      at = index;
      ties = 1;
    } else if (value === best) {
      ties += 1;
    }
  });
  return ties === 1 ? at : -1;
}

/** The theme's paint on the figure's frame: text, axes, gridlines, tooltip, legend. */
function paintFrame(layout: Record<string, unknown>, theme: ChartTheme): void {
  // Transparent in both themes, so the panel behind the plot is the surface and a
  // spec that named white does not lay a white slab on the night sky.
  layout.paper_bgcolor = TRANSPARENT;
  layout.plot_bgcolor = TRANSPARENT;
  branch(layout, 'font').color = theme.ink;

  const hover = branch(layout, 'hoverlabel');
  hover.bgcolor = theme.surface;
  hover.bordercolor = theme.grid;
  branch(hover, 'font').color = theme.ink;

  const key = branch(layout, 'legend');
  const keyFont = branch(key, 'font');
  keyFont.color = theme.ink;
  keyFont.size = LEGEND_LABEL_SIZE;

  // Only the axes the spec declared. Adding a pair to a pie's layout would be two
  // keys Plotly ignores and a reader has to work out why they are there.
  for (const name of Object.keys(layout).filter((candidate) => /^[xy]axis\d*$/.test(candidate))) {
    const axis = branch(layout, name);
    axis.gridcolor = theme.grid;
    axis.zerolinecolor = theme.grid;
    axis.linecolor = theme.grid;
    axis.gridwidth = 1;
    const ticks = branch(axis, 'tickfont');
    ticks.color = theme.muted;
    ticks.size = AXIS_LABEL_SIZE;
    ticks.family = theme.mono;
    if (record(axis.title).text !== undefined) branch(branch(axis, 'title'), 'font').color = theme.muted;
  }

  // Whatever the spec already draws over the plot. Retinted rather than replaced: a
  // shape the agent put there is a claim it made, and this file only repaints it.
  for (const shape of list(layout.shapes)) {
    const edge = branch(record(shape), 'line');
    const themed = themedSeries(edge.color, theme);
    if (themed) edge.color = themed;
    else if (typeof edge.color === 'string' && edge.color.trim().toLowerCase() === AGENT_INK) edge.color = theme.ink;
  }
  for (const note of list(layout.annotations)) {
    branch(record(note), 'font').color = theme.ink;
  }
}

/** One trace's series colour, outline and printed text, slot for slot. */
function paintTrace(trace: Record<string, unknown>, theme: ChartTheme): void {
  const stroke = themedSeries(record(trace.line).color, theme);
  if (stroke) branch(trace, 'line').color = stroke;

  const marker = record(trace.marker);
  const dot = themedSeries(marker.color, theme);
  if (dot) branch(trace, 'marker').color = dot;
  // A per-point list is the model pointing at one datum. Its entries are mapped and
  // its length and order are not, so whichever point it pointed at keeps the paint.
  if (Array.isArray(marker.color)) {
    branch(trace, 'marker').color = (marker.color as unknown[]).map((colour) => themedSeries(colour, theme) ?? colour);
  }
  if (Array.isArray(marker.colors)) {
    branch(trace, 'marker').colors = (marker.colors as unknown[]).map(
      (colour) => themedSeries(colour, theme) ?? colour
    );
  }

  if (traceType(trace) === 'pie') {
    // The spec separates adjacent slices with a white hairline, which on the night
    // sky is a rim of glare around every slice. It is the surface's colour, whatever
    // the surface currently is.
    branch(branch(trace, 'marker'), 'line').color = theme.surface;
  } else {
    const outline = record(record(trace.marker).line);
    if (text(outline.color) === AGENT_INK) {
      branch(branch(trace, 'marker'), 'line').color = theme.ink;
    }
  }

  if (record(trace.textfont).color !== undefined) branch(trace, 'textfont').color = theme.ink;
}

/**
 * The design's line treatment, and the two enhancements that are gated on the shape.
 *
 * The stroke weight goes on every line in the figure, because a figure with two
 * weights in it reads as two kinds of claim. The area fill and the peak marker go on
 * ONE case only: a single series, plotted against a strictly increasing run of
 * timestamps, whose values are all numbers. That is the full-window line the spec
 * describes. Two series is a comparison, an unordered x is a scatter, and neither has
 * an "under the line" or a "peak" that means anything.
 */
function enhanceLines(
  data: Record<string, unknown>[],
  layout: Record<string, unknown>,
  kind: string,
  theme: ChartTheme
): void {
  for (const trace of data) {
    if (drawsALine(trace)) branch(trace, 'line').width = LINE_WIDTH;
  }
  if (kind !== 'line' || data.length !== 1) return;
  const trace = data[0];
  if (!drawsALine(trace)) return;
  const values = finiteNumbers(trace.y);
  if (!values || !orderedTimestamps(trace.x)) return;

  const tint = withAlpha(theme.accent, AREA_ALPHA);
  // `fill: 'none'` is the spec saying no, which is a different thing from the spec
  // not saying anything. Anything else already declared keeps its shape and takes
  // the themed tint, since the spec's own tint is mixed from the light-theme blue.
  if (tint && trace.fill === undefined) {
    trace.fill = 'tozeroy';
    trace.fillcolor = tint;
  } else if (tint && trace.fill !== 'none') {
    trace.fillcolor = tint;
  }

  // A figure that already draws over itself has said where to look, so this adds
  // nothing to it. Otherwise the peak is marked only when there is exactly one.
  if (list(layout.shapes).length > 0 || list(layout.annotations).length > 0) return;
  const peak = soleMaximum(values);
  if (peak < 0) return;
  const at = list(trace.x)[peak];
  layout.shapes = [
    {
      type: 'line',
      xref: 'x',
      yref: 'paper',
      x0: at,
      x1: at,
      y0: 0,
      y1: 1,
      line: { color: theme.accent, width: 1, dash: 'dot' },
      layer: 'below',
    },
  ];
  // A marker-only trace rather than a shape, because a shape is sized in data
  // coordinates and a dot has to be 3.5px whatever the values are. It carries no
  // hover of its own: the point underneath it is the one with the reading on it.
  data.push({
    type: 'scatter',
    mode: 'markers',
    x: [at],
    y: [values[peak]],
    marker: { color: theme.accent, size: PEAK_DOT },
    hoverinfo: 'skip',
    showlegend: false,
    cliponaxis: false,
  });
}

/**
 * Drop every bar but the leading one to `DIM_ALPHA`, and only where that is a fact.
 *
 * The design's launch-week panel dims the days before the peak so the last column
 * reads as the arrival. That is only true of a figure whose categories are dates in
 * order and whose last value is the largest -- which is exactly the shape the agent
 * refuses to sort, so the order on screen is the order in the data. Anything else --
 * a ranked breakdown, a comparison across countries, a week whose peak is in the
 * middle -- keeps one weight, because dimming five of six bars there would point at
 * a bar for no reason.
 *
 * It takes no theme: it runs after `paintTrace`, so the colour it dims is already the
 * themed one and there is nothing here to resolve a second time.
 */
function dimTrailingBars(data: Record<string, unknown>[]): void {
  const bars = data.filter((trace) => traceType(trace) === 'bar');
  if (bars.length === 0) return;
  const lead = bars[0];
  const values = finiteNumbers(lead.y);
  if (!values || !orderedTimestamps(lead.x)) return;
  if (soleMaximum(values) !== values.length - 1) return;

  const width = list(lead.x).length;
  for (const bar of bars) {
    // A series over different categories is not on the same days, so it keeps its
    // own weight rather than being dimmed against somebody else's peak.
    if (list(bar.x).length !== width) continue;
    const colour = record(bar.marker).color;
    if (typeof colour !== 'string') continue;
    const dim = withAlpha(colour, DIM_ALPHA);
    if (!dim) continue;
    branch(bar, 'marker').color = Array.from({ length: width }, (_, at) => (at === width - 1 ? colour : dim));
  }
}

/** One chart as the agent stored it. `data` and `layout` are Plotly's own free-form shapes. */
export interface FigureSpec {
  kind: string;
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
}

export interface ThemedFigure {
  data: PlotData[];
  layout: PlotLayout;
}

/**
 * The spec as it should be drawn in the theme currently on screen.
 *
 * Pure, and the copy is the reason: `figure` is the answer's own object, shared with
 * every other surface that draws the same chart.
 */
export function themedFigure(figure: FigureSpec, theme: ChartTheme): ThemedFigure {
  const data = list(copied(figure.data)).map((trace) => record(trace));
  const layout = record(copied(figure.layout));
  const kind = String(figure.kind ?? '')
    .trim()
    .toLowerCase();

  paintFrame(layout, theme);
  for (const trace of data) paintTrace(trace, theme);
  if (kind === 'line' || kind === 'scatter') enhanceLines(data, layout, kind, theme);
  dimTrailingBars(data);

  return { data: data as PlotData[], layout: layout as PlotLayout };
}
