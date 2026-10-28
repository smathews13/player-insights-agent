import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { chartFlipDecision, FIGURE_CONFIG, layoutFigure, type ChartTheme, type FigureSpec } from './plotly-config';

const LIGHT: ChartTheme = {
  ink: '#161616',
  muted: '#6f6f6f',
  grid: '#ebebeb',
  surface: '#ffffff',
  accent: '#2272b4',
  second: '#04867d',
  third: '#4299e0',
  other: '#445461',
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
  other: '#8a9aa3',
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
    // Short names, so the chart stays upright: long ones are turned sideways instead.
    const labels = Array.from({ length: 40 }, (_, index) => `Cohort ${index + 1}`);
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

  it('breaks a long hyphenated name after a hyphen, not in the middle of a word', () => {
    const labels = Array.from({ length: 8 }, (_, index) => `free-to-play-weekend-tournament-finals-${index + 1}`);
    const { layout } = layoutFigure(horizontalBar(labels), LIGHT, { width: 320, height: 260 });
    const rows = String((at(layout.yaxis).ticktext as string[])[0]).split('<br>');
    expect(rows).toEqual(['free-to-play-', 'weekend-', 'tournament-finals…']);
    expect(rows.slice(0, -1).every((row) => row.endsWith('-'))).toBe(true);
  });

  it('keeps horizontal bars flat, bounds left labels, and gives every category a readable row', () => {
    const labels = Array.from({ length: 12 }, (_, index) => `Extremely descriptive game title ${index + 1}`);
    const { data, layout } = layoutFigure(horizontalBar(labels), LIGHT, { width: 320, height: 260 });
    const y = at(layout.yaxis);

    expect(y.tickangle).toBe(0);
    expect(y.tickvals).toEqual(labels);
    const lines = (y.ticktext as string[]).flatMap((label) => label.split('<br>'));
    expect(lines.every((line) => line.length <= 18)).toBe(true);
    expect((y.ticktext as string[]).join('')).not.toContain('…');
    expect(at(data[0]).y).toEqual(labels);
    expect(layout.height).toBe(480);
  });

  it('turns ten long-named vertical bars sideways, every name whole, under the whole title', () => {
    const labels = Array.from({ length: 10 }, (_, index) => `Velocity Heights Online weekly event ${index + 1}`);
    const title = 'Weekly active players by live event across every platform in the last quarter';
    const spec = frozen({ ...verticalBar(labels), layout: { ...verticalBar(labels).layout, title: { text: title } } });
    const { data, layout } = layoutFigure(spec, LIGHT, { width: 620, height: 320 });

    expect(at(data[0]).orientation).toBe('h');
    expect(at(data[0]).y).toEqual(labels);
    expect(at(data[0]).x).toEqual(labels.map((_, at) => at + 1));
    expect(at(at(layout.xaxis).title).text).toBe('Players');
    expect(at(layout.yaxis).autorange).toBe('reversed');
    const ticks = at(layout.yaxis).ticktext as string[] | undefined;
    if (ticks) expect(ticks.join('')).not.toContain('…');
    const drawnTitle = String(at(layout.title).text);
    expect(drawnTitle.replace(/<br>/g, ' ')).toBe(title);
    expect(drawnTitle).not.toContain('…');
    expect(at(layout.xaxis).nticks).toBeGreaterThanOrEqual(5);
  });

  it('leaves a few long-named bars upright, and a bar chart with notes pinned to it alone', () => {
    const few = layoutFigure(
      verticalBar(['Velocity Heights Online', 'Iron Frontier Online', 'Outfit The Old Country']),
      LIGHT,
      {
        width: 620,
        height: 320,
      }
    );
    expect(at(few.data[0]).orientation).toBeUndefined();

    const labels = Array.from({ length: 10 }, (_, index) => `Velocity Heights Online weekly event ${index + 1}`);
    const pinned = verticalBar(labels);
    pinned.layout.annotations = [{ x: labels[0], y: 1, text: 'Launch' }];
    expect(at(layoutFigure(pinned, LIGHT, { width: 620, height: 320 }).data[0]).orientation).toBeUndefined();
  });

  it('turns every view of a chart the same way, so switching views never swaps the axes', () => {
    const long = verticalBar(
      Array.from({ length: 10 }, (_, index) => `Velocity Heights Online weekly event ${index + 1}`)
    );
    const short = verticalBar(['PC', 'PS5', 'Xbox']);
    const draw = (spec: FigureSpec, flip: boolean) =>
      at(layoutFigure({ ...spec, flip }, LIGHT, { width: 620, height: 320 }).data[0]).orientation;

    expect(chartFlipDecision([short, long])).toBe(true);
    expect(draw(short, true)).toBe('h');
    expect(draw(long, true)).toBe('h');

    const pinned = verticalBar(['PC', 'PS5', 'Xbox']);
    pinned.layout.annotations = [{ x: 'PC', y: 1, text: 'Launch' }];
    expect(chartFlipDecision([pinned, long])).toBe(false);
    expect(draw(long, false)).toBeUndefined();
    expect(draw(pinned, true)).toBeUndefined();
    expect(chartFlipDecision([short, verticalBar(['PS5', 'PC'])])).toBe(false);
  });

  it('leaves bars on a second axis upright', () => {
    const labels = Array.from({ length: 10 }, (_, index) => `Velocity Heights Online weekly event ${index + 1}`);
    const spec = verticalBar(labels);
    spec.data[0].yaxis = 'y2';
    expect(at(layoutFigure(spec, LIGHT, { width: 620, height: 320 }).data[0]).orientation).toBeUndefined();
  });

  it('never thins the ticks of an axis that carries names', () => {
    const spec: FigureSpec = {
      kind: 'box',
      data: [{ type: 'box', x: ['PC', 'PS5', 'Xbox'], y: [1, 2, 3] }],
      layout: { xaxis: axis(), yaxis: axis({ title: { text: 'Hours' } }) },
    };
    const { layout } = layoutFigure(spec, LIGHT, { width: 620, height: 320 });
    expect(at(layout.xaxis).nticks).toBeUndefined();
    expect(at(layout.yaxis).nticks).toBeGreaterThanOrEqual(5);
  });

  it('swaps axis references in a hover template when it turns bars sideways', () => {
    const labels = Array.from({ length: 10 }, (_, index) => `Velocity Heights Online weekly event ${index + 1}`);
    const spec = verticalBar(labels);
    spec.data[0].hovertemplate = '%{x}: %{y:,.0f} players<extra></extra>';
    expect(at(layoutFigure(spec, LIGHT, { width: 620, height: 320 }).data[0]).hovertemplate).toBe(
      '%{y}: %{x:,.0f} players<extra></extra>'
    );
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
    expect(source).toContain('layoutFigure({ kind, data, layout, flip }, theme, { width: measuredWidth, height })');
    expect(source).toContain('new ResizeObserver(schedule)');
    expect(source).toContain('requestAnimationFrame');
    expect(source.match(/Plotly\.react\(/g)).toHaveLength(1);
  });
});
