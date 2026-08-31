import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FIGURE_CONFIG, layoutFigure, type ChartTheme, type FigureSpec } from './plotly-config';

const LIGHT: ChartTheme = {
  ink: '#161616',
  muted: '#6f6f6f',
  grid: '#ebebeb',
  surface: '#ffffff',
  accent: '#2272b4',
  second: '#04867d',
  third: '#4299e0',
  fourth: '#445461',
  mono: "'DM Mono', monospace",
};

const DARK: ChartTheme = {
  ink: '#f2f6fa',
  muted: 'rgba(232, 237, 242, 0.68)',
  grid: 'rgba(255, 255, 255, 0.12)',
  surface: '#11171c',
  accent: '#8fc1e8',
  second: '#04867d',
  third: '#6faedd',
  fourth: '#8a9aa3',
  mono: "'DM Mono', monospace",
};

function axis(overrides: Record<string, unknown> = {}) {
  return { title: { text: 'Category' }, ...overrides };
}

function verticalBar(labels: string[], traces = 1): FigureSpec {
  return {
    kind: 'bar',
    data: Array.from({ length: traces }, (_, index) => ({
      type: 'bar',
      name: `Series ${index + 1}`,
      x: labels,
      y: labels.map((_, at) => at + index + 1),
      marker: { color: index === 0 ? '#2272B4' : '#04867D' },
    })),
    layout: { xaxis: axis(), yaxis: axis({ title: { text: 'Players' } }), showlegend: traces > 1 },
  };
}

function horizontalBar(labels: string[]): FigureSpec {
  return {
    kind: 'bar',
    data: [{ type: 'bar', orientation: 'h', name: 'Players', x: labels.map((_, index) => index + 1), y: labels }],
    layout: { xaxis: axis({ title: 'Players' }), yaxis: axis() },
  };
}

function scatter(x: unknown[], kind = 'scatter'): FigureSpec {
  return {
    kind,
    data: [{ type: 'scatter', mode: kind === 'line' ? 'lines' : 'markers', name: 'Players', x, y: x.map((_, i) => i) }],
    layout: { xaxis: axis(), yaxis: axis({ title: { text: 'Players' } }) },
  };
}

function at(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  return value as Record<string, unknown>;
}

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

describe('categorical tick decisions are bounded by labels, count and chart direction', () => {
  it('keeps a few short vertical-bar labels flat and does not manufacture tick text', () => {
    const { layout } = layoutFigure(verticalBar(['North', 'South', 'West']), LIGHT, { width: 620, height: 260 });
    const x = at(layout.xaxis);
    expect(x.automargin).toBe(true);
    expect(x.tickangle).toBe(0);
    expect(x).not.toHaveProperty('ticktext');
    expect(at(x.title).standoff).toBe(12);
  });

  it('wraps a few long vertical-bar labels without replacing their category values', () => {
    const labels = [
      'Sid Meier Dynasty Seven Anniversary Collection',
      'Outfit The Old Country',
      'Velocity Heights Online',
    ];
    const spec = frozen(verticalBar(labels));
    const before = JSON.stringify(spec);
    const { data, layout } = layoutFigure(spec, LIGHT, { width: 620, height: 260 });
    const x = at(layout.xaxis);

    expect(x.tickangle).toBe(0);
    expect(x.tickvals).toEqual(labels);
    expect(x.ticktext).toEqual(expect.arrayContaining([expect.stringContaining('<br>'), expect.stringContaining('…')]));
    expect(at(data[0]).x).toEqual(labels);
    expect(JSON.stringify(spec)).toBe(before);
    expect(layout.height).toBe(284);
  });

  it('samples, truncates and angles many categories only when a narrow axis is crowded', () => {
    const labels = Array.from({ length: 14 }, (_, index) => `Long category label number ${index + 1}`);
    const spec = verticalBar(labels);
    spec.data[0].hovertext = labels.map((label) => `Full tooltip: ${label}`);
    const { data, layout } = layoutFigure(spec, LIGHT, { width: 320, height: 260 });
    const x = at(layout.xaxis);

    expect(x.tickangle).toBe(-45);
    expect((x.tickvals as string[]).length).toBeLessThan(labels.length);
    expect((x.tickvals as string[]).at(-1)).toBe(labels.at(-1));
    expect(x.ticktext).toEqual(expect.arrayContaining([expect.stringContaining('…')]));
    expect(at(data[0]).x).toEqual(labels);
    expect(at(data[0]).hovertext).toEqual(spec.data[0].hovertext);
    expect(layout.height).toBe(302);
  });

  it('keeps horizontal bars flat, bounds left labels, and gives every category a readable row', () => {
    const labels = Array.from({ length: 12 }, (_, index) => `Extremely descriptive game title ${index + 1}`);
    const { data, layout } = layoutFigure(horizontalBar(labels), LIGHT, { width: 320, height: 260 });
    const y = at(layout.yaxis);

    expect(y.tickangle).toBe(0);
    expect(y.tickvals).toEqual(labels);
    expect((y.ticktext as string[]).every((label) => label.length <= 18)).toBe(true);
    expect(at(data[0]).y).toEqual(labels);
    expect(layout.height).toBe(352);
  });
});

describe('line and scatter axes retain scale semantics', () => {
  it('lays out a categorical line axis without changing its points', () => {
    const labels = ['Acquisition campaign', 'Returning audience', 'Organic discovery'];
    const { data, layout } = layoutFigure(scatter(labels, 'line'), LIGHT, { width: 600, height: 260 });
    expect(at(layout.xaxis).tickangle).toBe(0);
    expect(at(layout.xaxis).ticktext).toEqual(expect.arrayContaining([expect.stringContaining('<br>')]));
    expect(at(data[0]).x).toEqual(labels);
  });

  it('leaves numeric and date scales to Plotly while still enabling automargins', () => {
    for (const values of [
      [10, 20, 30],
      ['2026-07-14', '2026-07-15', '2026-07-16'],
    ]) {
      const { layout } = layoutFigure(scatter(values), LIGHT, { width: 320, height: 260 });
      const x = at(layout.xaxis);
      expect(x.automargin).toBe(true);
      expect(x).not.toHaveProperty('tickangle');
      expect(x).not.toHaveProperty('ticktext');
    }
  });

  it('does not honor a fixed model tick angle when the app cannot justify it', () => {
    const spec = scatter([10, 20, 30]);
    spec.layout.xaxis = axis({ tickangle: 90 });
    expect(at(layoutFigure(spec, LIGHT, { width: 320, height: 260 }).layout.xaxis)).not.toHaveProperty('tickangle');
  });

  it('does not change declared scale types, ranges or category order', () => {
    const spec = scatter([1, 10, 100]);
    spec.layout.xaxis = axis({ type: 'log', range: [0, 2], autorange: false });
    spec.layout.yaxis = axis({ range: [0, 5], rangemode: 'tozero' });
    const { layout } = layoutFigure(spec, LIGHT, { width: 320, height: 260 });
    expect(at(layout.xaxis)).toMatchObject({ type: 'log', range: [0, 2], autorange: false });
    expect(at(layout.yaxis)).toMatchObject({ range: [0, 5], rangemode: 'tozero' });

    const ranked = verticalBar(['West', 'North', 'South']);
    ranked.layout.xaxis = axis({ categoryorder: 'total descending' });
    expect(at(layoutFigure(ranked, LIGHT, { width: 320, height: 260 }).layout.xaxis).categoryorder).toBe(
      'total descending'
    );
  });
});

describe('legends, titles and plot area respond to the measured container', () => {
  it('puts a cartesian legend in a bounded top band on mobile', () => {
    const spec = verticalBar(['North', 'South'], 4);
    spec.layout.legend = { traceorder: 'reversed', y: -0.4 };
    const { layout } = layoutFigure(spec, LIGHT, { width: 320, height: 260 });
    const legend = at(layout.legend);

    expect(legend).toMatchObject({
      orientation: 'h',
      yref: 'container',
      y: 1,
      yanchor: 'top',
      entrywidthmode: 'fraction',
      entrywidth: 0.5,
      maxheight: 0.22,
      traceorder: 'reversed',
    });
    expect(layout.height).toBe(288);
  });

  it('moves a pie legend from the right to the top when the container narrows', () => {
    const pie: FigureSpec = {
      kind: 'pie',
      data: [{ type: 'pie', labels: ['North', 'South', 'East'], values: [5, 3, 2] }],
      layout: { showlegend: true, legend: {} },
    };
    const wideFigure = layoutFigure(pie, LIGHT, { width: 700, height: 260 });
    const mobileFigure = layoutFigure(pie, LIGHT, { width: 340, height: 260 });
    const wide = at(wideFigure.layout.legend);
    const mobile = at(mobileFigure.layout.legend);
    expect(wide).toMatchObject({ orientation: 'v', xref: 'container', x: 1, maxheight: 0.9 });
    expect(mobile).toMatchObject({ orientation: 'h', yref: 'container', y: 1, maxheight: 0.22 });
    expect(at(wideFigure.data[0]).automargin).toBe(true);
    expect(at(mobileFigure.data[0]).automargin).toBe(true);
  });

  it('reserves title and automargin growth while guaranteeing a minimum plot area', () => {
    const spec = verticalBar(['North', 'South']);
    spec.layout.title = 'Players by region';
    spec.layout.margin = { l: 500, r: -3, t: 0, b: 90 };
    const { layout } = layoutFigure(spec, LIGHT, { width: 320, height: 260 });
    expect(layout.margin).toMatchObject({ l: 40, r: 8, t: 32, b: 40, autoexpand: true });
    expect(at(layout.title)).toMatchObject({ text: 'Players by region', automargin: true });
    expect(layout.minreducedwidth).toBe(134);
    expect(layout.minreducedheight).toBe(96);
    expect(layout.height).toBe(278);
  });
});

describe('theme, export and resize use the same pure layout', () => {
  it('makes identical geometry decisions in dark and light themes', () => {
    const spec = verticalBar(['A very long north region', 'A very long southern region'], 2);
    const light = layoutFigure(spec, LIGHT, { width: 340, height: 260 });
    const dark = layoutFigure(spec, DARK, { width: 340, height: 260 });
    const geometry = (figure: typeof light) => {
      const legend = at(figure.layout.legend);
      const xaxis = at(figure.layout.xaxis);
      return {
        height: figure.layout.height,
        margin: figure.layout.margin,
        legend: {
          orientation: legend.orientation,
          xref: legend.xref,
          x: legend.x,
          yref: legend.yref,
          y: legend.y,
          maxheight: legend.maxheight,
        },
        xaxis: {
          automargin: xaxis.automargin,
          tickangle: xaxis.tickangle,
          tickvals: xaxis.tickvals,
          ticktext: xaxis.ticktext,
        },
        minreducedwidth: figure.layout.minreducedwidth,
      };
    };
    expect(geometry(dark)).toEqual(geometry(light));
    expect(at(dark.layout.font).color).toBe(DARK.ink);
    expect(at(light.layout.font).color).toBe(LIGHT.ink);
  });

  it('keeps responsive export on the exact layout drawn and never fixes a stale width', () => {
    const { layout } = layoutFigure(verticalBar(['North', 'South'], 2), LIGHT, { width: 320, height: 260 });
    expect(FIGURE_CONFIG.responsive).toBe(true);
    expect(layout.autosize).toBe(true);
    expect(layout).not.toHaveProperty('width');
    const source = readFileSync(new URL('./plotly-config.ts', import.meta.url), 'utf8');
    expect(source).toContain("egressPathAllowed('chart-image')");
  });

  it('recomputes from ResizeObserver width and coalesces container changes without a browser', () => {
    const source = readFileSync(new URL('./PlotlyFigure.tsx', import.meta.url), 'utf8');
    expect(source).toContain('entries[0]?.contentRect.width');
    expect(source).toContain('layoutFigure({ kind, data, layout }, theme, { width: measuredWidth, height })');
    expect(source).toContain('new ResizeObserver(schedule)');
    expect(source).toContain('requestAnimationFrame');
    expect(source.match(/Plotly\.react\(/g)).toHaveLength(1);
  });
});
