import { useEffect, useRef } from 'react';
import Plotly, { type PlotConfig, type PlotData, type PlotLayout } from 'plotly.js-cartesian-dist-min';

/**
 * The only module that imports Plotly, and the reason it is a module of its own.
 */

/**
 * Everything interactive the notebook has, and nothing that fights a chat transcript.
 */
const CONFIG: PlotConfig = {
  displaylogo: false,
  displayModeBar: 'hover',
  responsive: true,
  scrollZoom: false,
  doubleClick: 'reset',
  // Selection tools produce no result here. Nothing downstream consumes a selection,
  // and spike lines duplicate what the unified tooltip already shows.
  modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines', 'autoScale2d'],
};

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
    void Plotly.react(element, data, { ...layout, autosize: true, height }, CONFIG);

    // `responsive: true` only listens for window resizes. The answer column also changes
    // width when the conversation rail opens or the viewport rotates, neither of which
    // fires one, so the container is observed directly.
    const observer = new ResizeObserver(() => {
      void Plotly.react(element, data, { ...layout, autosize: true, height }, CONFIG);
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
