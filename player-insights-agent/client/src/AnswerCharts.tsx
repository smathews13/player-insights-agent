import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Skeleton } from './ui';

/**
 * One Plotly panel from the agent's `new_plot` tool.
 *
 * Mirrors `Chart` in agent/contracts.py and `ChartSchema` in
 * server/routes/insights-routes.ts. `data` and `layout` are Plotly's own free-form
 * shapes, validated as objects at the route and carried here untouched.
 *
 * UNTOUCHED IS LITERAL AND IT IS WHY THIS FILE STILL DECLARES NO COLOUR. The agent
 * writes the palette into the spec, and the spec is stored, so its colours are the
 * light theme's whatever theme is on screen when it is read back. Resolving that is a
 * pure pass over a COPY of the spec, in plotly-config.ts, applied by PlotlyFigure at
 * draw time -- not a second palette written into the panel here, and not an edit to
 * the answer object the transcript and the Run Explorer both hold.
 *
 * What this file owns is the panel: a surface, a compact eyebrow title, and the
 * boundary that keeps a chart which will not draw from taking the answer with it.
 * Everything inside the plot, the series key included, is Plotly's.
 */
export interface Chart {
  id: string;
  title: string;
  kind: string;
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
}

// The import boundary. Plotly is 1.4 MB, so it must not be reachable from App.tsx's
// eager graph; `lazy` turns this into a separate chunk fetched only once an answer
// actually carries a chart. See PlotlyFigure.tsx.
const PlotlyFigure = lazy(() => import('./PlotlyFigure'));

/**
 * The plot's height, and the skeleton's.
 *
 * ONE CONSTANT FOR BOTH, so the transcript does not jump when the chunk lands. Down
 * from 320: the panel is 12px of padding and an eyebrow now rather than a card
 * header, a hairline and 16px, and the charted variant puts two of these side by side
 * where the table it replaces was one block. At 320 a pair of them was taller than
 * the answer above it.
 */
const CHART_HEIGHT = 260;

/**
 * What the agent's derived `kind` should be called.
 *
 * No longer a badge -- the panel head is the title and nothing else. It is kept for
 * the two jobs a badge was never needed for: the accessible name of a plot whose SVG
 * reads as disconnected axis labels, and the eyebrow of a chart the agent titled with
 * an empty string.
 */
const KIND_LABELS: Record<string, string> = {
  bar: 'Bar chart',
  line: 'Line chart',
  scatter: 'Scatter plot',
  pie: 'Share of total',
  histogram: 'Distribution',
  box: 'Distribution',
  combo: 'Combined chart',
};

function kindLabel(kind: string) {
  return KIND_LABELS[kind] ?? 'Chart';
}

/**
 * Keeps a chart that will not draw from taking the answer with it.
 *
 * Anything reached through `lazy` can fail at fetch time (a chunk that 404s after a
 * redeploy is the common case), and Plotly itself throws on a spec that survived
 * validation but that it still will not accept. Either one thrown into the transcript
 * would blank every answer on screen, so it is caught per panel and the rest of the
 * answer stands.
 */
class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[charts] A chart could not be rendered:', error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="text-sm text-muted-foreground">
          This chart could not be displayed. The rest of this answer is unaffected.
        </p>
      );
    }
    return this.props.children;
  }
}

function ChartPanel({ chart }: { chart: Chart }) {
  const name = chart.title.trim() || kindLabel(chart.kind);
  return (
    <figure className="answer-chart-panel">
      {/* An eyebrow, not a heading: the answer's takeaway is the heading on this card
          and a chart panel sits several blocks under it. The chart-kind badge that
          used to sit opposite is gone -- it named the shape a reader can see, and it
          was the widest thing in a head that now has to fit in a half-width panel. */}
      <figcaption className="answer-chart-eyebrow">{name}</figcaption>
      <ChartBoundary>
        {/* The fallback is the plot's own height so the transcript does not jump when
            the chunk lands. */}
        <Suspense fallback={<Skeleton style={{ height: CHART_HEIGHT }} className="w-full" />}>
          <PlotlyFigure kind={chart.kind} data={chart.data} layout={chart.layout} title={name} height={CHART_HEIGHT} />
        </Suspense>
      </ChartBoundary>
    </figure>
  );
}

/**
 * The charts an answer returned, or nothing at all.
 *
 * `charts` is optional because it is optional on the wire: an answer served from the
 * representative fallback has no charts, and neither does one from an endpoint still
 * running an agent that predates the tool.
 *
 * EVERY CHART, AND NO CAP HERE. The agent bounds how many panels one answer may
 * carry (`MAX_CHARTS` in agent/charts.py) because that is a decision about what an
 * answer should say. A second, lower cap at this end would silently drop a panel the
 * answer had already committed to -- a fact deleted for layout, which is the one
 * thing the answer-card rules forbid outright. The list lays out in as many rows as
 * it needs.
 */
export function AnswerCharts({ charts }: { charts?: Chart[] }) {
  if (!charts?.length) return null;
  return (
    <div className="answer-charts">
      {charts.map((chart) => (
        <ChartPanel chart={chart} key={chart.id} />
      ))}
    </div>
  );
}
