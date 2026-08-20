import { useEffect, useRef } from 'react';
import Plotly, { type PlotData, type PlotLayout } from 'plotly.js-cartesian-dist-min';
import { FIGURE_CONFIG } from './plotly-config';

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
  /** Used for the accessible name, since a canvas-like plot has no readable text. */
  title: string;
  height: number;
}

export default function PlotlyFigure({ data, layout, title, height }: PlotlyFigureProps) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    // `react` rather than `newPlot`: it diffs against what is already drawn, so a
    // re-render from a parent state change does not tear the chart down and rebuild it.
    void Plotly.react(element, data, { ...layout, autosize: true, height }, FIGURE_CONFIG);

    // `responsive: true` only listens for window resizes. The answer column also changes
    // width when the conversation rail opens or the viewport rotates, neither of which
    // fires one, so the container is observed directly.
    const observer = new ResizeObserver(() => {
      void Plotly.react(element, data, { ...layout, autosize: true, height }, FIGURE_CONFIG);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      // Plotly attaches listeners and a WebGL-free canvas stack outside React's tree, so
      // dropping the node without purging leaks both.
      Plotly.purge(element);
    };
  }, [data, layout, height]);

  // `role="img"` with the chart's own title: Plotly draws into SVG whose text nodes read
  // as a stream of disconnected axis labels, so the panel announces itself once instead.
  return <div ref={host} role="img" aria-label={title} className="w-full" style={{ height }} />;
}
