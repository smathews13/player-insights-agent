import { useEffect, useRef, useState } from 'react';
import Plotly, { type PlotData, type PlotLayout } from 'plotly.js-cartesian-dist-min';
import {
  CHART_THEME_ATTRIBUTE,
  FIGURE_CONFIG,
  readChartTheme,
  sameChartTheme,
  themedFigure,
  type ChartTheme,
} from './plotly-config';

/**
 * The only module that imports Plotly, and the reason it is a module of its own.
 */

/**
 * Everything interactive the notebook has, and nothing that fights a chat transcript.
 *
 * Exported because the read-only half of it is the point and not a detail. An answer
 * is a record of what the agent found, and a figure whose labels can be typed over is
 * not evidence of anything. `chart-read-only.test.ts` asserts this object, so the
 * guarantee survives a rewrite of how the plot is mounted.
 *
 * Config is also the whole of the control surface: which parts of a figure accept a
 * keystroke lives on Plotly's context, never in `layout`, so nothing the agent sends
 * can reopen what is closed here.
 */
export interface PlotlyFigureProps {
  data: PlotData[];
  layout: PlotLayout;
  /**
   * The agent's derived shape -- `line`, `bar`, `pie` and so on. Read only by the
   * presentation pass in plotly-config.ts, which gates the line treatment on it.
   */
  kind: string;
  /** Used for the accessible name, since a canvas-like plot has no readable text. */
  title: string;
  height: number;
}

export default function PlotlyFigure({ data, layout, kind, title, height }: PlotlyFigureProps) {
  const host = useRef<HTMLDivElement | null>(null);
  /**
   * The paint, read from the document rather than passed down.
   *
   * A spec's colours are the light theme's, written when the answer was produced, so
   * something has to resolve the current theme at draw time -- see plotly-config.ts.
   * Held in state rather than read inside the draw effect so that a theme change is a
   * render, which is what makes it a dependency the effect can be keyed on.
   */
  const [theme, setTheme] = useState<ChartTheme>(readChartTheme);

  useEffect(() => {
    // Settings > Appearance flips the scheme by writing `data-theme` on <html>, and
    // it does it in place: no fetch, no route change, nothing React re-renders from.
    // A plot already on screen would therefore keep the paint it was mounted with
    // while every surface around it changed, which is what makes the preview look
    // broken. So the attribute itself is what is watched.
    const root = document.documentElement;
    const follow = () => {
      const next = readChartTheme(root);
      setTheme((current) => (sameChartTheme(current, next) ? current : next));
    };
    // Once on mount as well: the first paint happens before the saved scheme is
    // applied, so the initial reading can be the default rather than the choice.
    follow();
    const watcher = new MutationObserver(follow);
    watcher.observe(root, { attributes: true, attributeFilter: [CHART_THEME_ATTRIBUTE] });
    return () => watcher.disconnect();
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    // A copy, themed. The answer's own `data` and `layout` are never written to; see
    // plotly-config.ts for why that matters when the same chart is drawn twice.
    const figure = themedFigure({ kind, data, layout }, theme);
    // `react` rather than `newPlot`: it diffs against what is already drawn, so a
    // re-render from a parent state change does not tear the chart down and rebuild it.
    // One call site, so the reviewed config object cannot be bypassed by a second one.
    const paint = () =>
      void Plotly.react(element, figure.data, { ...figure.layout, autosize: true, height }, FIGURE_CONFIG);

    paint();

    // `responsive: true` only listens for window resizes. The answer column also changes
    // width when the conversation rail opens or the viewport rotates, neither of which
    // fires one, so the container is observed directly.
    const observer = new ResizeObserver(paint);
    observer.observe(element);

    return () => {
      observer.disconnect();
      // Plotly attaches listeners and a WebGL-free canvas stack outside React's tree, so
      // dropping the node without purging leaks both.
      Plotly.purge(element);
    };
  }, [data, layout, kind, height, theme]);

  // `role="img"` with the chart's own title: Plotly draws into SVG whose text nodes read
  // as a stream of disconnected axis labels, so the panel announces itself once instead.
  return <div ref={host} role="img" aria-label={title} className="w-full" style={{ height }} />;
}
