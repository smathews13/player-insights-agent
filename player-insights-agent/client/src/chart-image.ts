import Plotly from 'plotly.js-cartesian-dist-min';
import { layoutFigure, readChartTheme, type FigureViewport } from './plotly-config';
import type { Chart } from './AnswerCharts';

/**
 * A chart as a still picture, for a document that leaves the app.
 *
 * WHY A RASTER AND NOT THE LIVE PLOT. An exported file is read where this app is
 * not: an email, a wiki, a Markdown viewer with no JavaScript. A Plotly figure is
 * a script and a 1.4 MB library, neither of which survives that trip, so the
 * export carries what the reader saw -- a PNG -- rather than the machinery that
 * drew it. The JSON export keeps the live spec for a reader who wants to redraw
 * it; see `serializeAnswerJson`.
 *
 * WHY IT GOES THROUGH plotly-config. `layoutFigure` is the same presentation pass
 * every on-screen chart is drawn with: it themes a COPY of the spec and applies
 * the supported geometry, and it invents no fact. Rendering the raw spec instead
 * would hand the reader a picture that does not match the one on the card -- a
 * light-theme frame, unfitted tick labels, the fourth series in a colour the app
 * moved. Reading the theme here means an export made from the night sky looks like
 * the night sky.
 *
 * WHY IT IS ITS OWN MODULE. It imports Plotly by value, which is the 1.4 MB chunk,
 * so it stays behind the same dynamic-import boundary PlotlyFigure sits behind and
 * is reached only when a download actually runs. See PlotlyFigure.tsx.
 */

/**
 * The pixel box a chart is rendered into for a document.
 *
 * Wider and a little taller than the on-screen panel (260px): an export is read at
 * document width, not in a half-width answer column, and `scale` doubles the raster
 * so it stays crisp when a viewer zooms. `layoutFigure` may still grow the height
 * for a wrapped or angled axis, and the render honours whatever it settles on.
 */
const EXPORT_VIEWPORT: FigureViewport = { width: 760, height: 340 };

/** The raster's pixel density. Two device pixels per CSS pixel, so it does not blur when enlarged. */
const EXPORT_SCALE = 2;

/**
 * One chart as a `data:image/png;base64,...` URL, themed and laid out as on screen.
 *
 * Pure of the DOM in the sense that matters: `toImage` mounts and tears down its own
 * offscreen node, so nothing has to be rendered in the transcript for a download to
 * carry the figure.
 */
export async function chartPngDataUrl(chart: Chart, viewport: FigureViewport = EXPORT_VIEWPORT): Promise<string> {
  const theme = readChartTheme();
  const figure = layoutFigure({ kind: chart.kind, data: chart.data, layout: chart.layout }, theme, viewport);
  const height = typeof figure.layout.height === 'number' ? figure.layout.height : viewport.height;
  return Plotly.toImage(
    { data: figure.data, layout: figure.layout },
    { format: 'png', width: viewport.width, height, scale: EXPORT_SCALE }
  );
}

/**
 * Every chart as a PNG, keyed by chart id, with any that will not render dropped.
 *
 * A spec Plotly refuses must not fail the whole export: the reader still gets the
 * prose, the tables and the charts that did draw, exactly as a chart that fails on
 * screen costs one panel and not the answer. A dropped id is simply absent from the
 * map, and the serializers fall back to the chart's title where its picture is
 * missing.
 */
export async function chartPngDataUrls(charts: readonly Chart[]): Promise<Map<string, string>> {
  const rendered = await Promise.all(
    charts.map(async (chart) => {
      try {
        return [chart.id, await chartPngDataUrl(chart)] as const;
      } catch (error) {
        console.error('[export] A chart could not be rendered to an image:', error);
        return null;
      }
    })
  );
  return new Map(rendered.filter((entry): entry is readonly [string, string] => entry !== null));
}
