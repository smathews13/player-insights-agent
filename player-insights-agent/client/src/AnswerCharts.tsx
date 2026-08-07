import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from './ui';
import { BarChart3 } from 'lucide-react';

/**
 * One Plotly panel from the agent's `new_plot` tool.
 *
 * Mirrors `Chart` in agent/contracts.py and `ChartSchema` in
 * server/routes/insights-routes.ts. `data` and `layout` are Plotly's own free-form
 * shapes, validated as objects at the route and carried here untouched. The agent has
 * already applied the brand palette and layout, so this file adds no styling of its own
 * beyond the card around the plot.
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

const CHART_HEIGHT = 320;

/** What the agent's derived `kind` should be called in the badge. */
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
      return (<p className="text-sm text-muted-foreground">
          This chart could not be displayed. The figures and generated SQL below are unaffected.
        </p>
      );
    }
    return this.props.children;
  }
}

function ChartCard({ chart }: { chart: Chart }) {
  return (<Card className="chart-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{chart.title || kindLabel(chart.kind)}</CardTitle>
            <CardDescription>Hover for values, drag to zoom, double-click to reset</CardDescription>
          </div>
          <Badge variant="outline">
            <BarChart3 /> {kindLabel(chart.kind)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <ChartBoundary>
          {/* The fallback is the plot's own height so the transcript does not jump when
              the chunk lands. */}
          <Suspense fallback={<Skeleton style={{ height: CHART_HEIGHT }} className="w-full" />}>
            <PlotlyFigure
              data={chart.data}
              layout={chart.layout}
              title={chart.title || kindLabel(chart.kind)}
              height={CHART_HEIGHT}
            />
          </Suspense>
        </ChartBoundary>
      </CardContent>
    </Card>
  );
}

/**
 * The charts an answer returned, or nothing at all.
 *
 * `charts` is optional because it is optional on the wire: an answer served from the
 * representative fallback has no charts, and neither does one from an endpoint still
 * running an agent that predates the tool.
 */
export function AnswerCharts({ charts }: { charts?: Chart[] }) {
  if (!charts?.length) return null;
  // `chart-card` and the spacing utilities are the app's existing vocabulary, so a chart
  // panel sits in the same card treatment as the figure breakdown beneath it without
  // adding styles that would then have to be kept in step with the brand tokens.
  return (<div className="grid gap-4">
      {charts.map((chart) => (<ChartCard chart={chart} key={chart.id} />
      ))}
    </div>
  );
}
