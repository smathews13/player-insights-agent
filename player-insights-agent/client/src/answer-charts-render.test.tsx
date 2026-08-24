import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AnswerCharts, type Chart } from './AnswerCharts';
import { partial, partialNames } from './styles/stylesheet';

/**
 * The charted variant's panels, as markup and as the rules that paint them.
 *
 * Plotly is 1.4 MB of browser code and this suite runs in node, so the plot itself is
 * never drawn here: `lazy` suspends and the panel renders its skeleton, which is the
 * state every chart passes through first anyway. What that leaves is exactly what this
 * file is for -- the panel around the plot. The head, the surface, the fact that as
 * many panels arrive as the answer carried, and the fact that the skeleton reserves the
 * height the plot will take.
 *
 * WHAT IS NOT VERIFIED HERE, and cannot be without a browser: how any of it looks, and
 * whether two panels actually sit side by side at the width a reader has. The
 * stylesheet assertions are the same trade the rest of this repo's style tests make --
 * they prove the rules exist and say what the spec says, not that the result has been
 * seen.
 */

// The panel imports PlotlyFigure through `lazy`, and a resolved chunk would pull the
// whole library into a node process. Stubbed for the same reason as in
// chart-read-only.test.ts.
vi.mock('plotly.js-cartesian-dist-min', () => ({
  default: { react: vi.fn(), purge: vi.fn() },
  react: vi.fn(),
  purge: vi.fn(),
}));

const CSS = partial('answer-charts.css');

function chart(over: Partial<Chart> = {}): Chart {
  return {
    id: 'chart-1',
    title: 'Sessions per day',
    kind: 'line',
    data: [{ type: 'scatter', mode: 'lines', x: ['2026-07-14'], y: [118] }],
    layout: { xaxis: {} },
    ...over,
  };
}

function render(charts?: Chart[]): string {
  return renderToStaticMarkup(<AnswerCharts charts={charts} />);
}

/** The body of the rule whose selector list starts a line with `selector`. */
function ruleFor(selector: string): string {
  const at = CSS.indexOf(`\n${selector}`);
  expect(at, `${selector} is declared`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

describe('a chart panel heads itself with an eyebrow and nothing else', () => {
  it('draws the agent’s title as the panel’s eyebrow', () => {
    const markup = render([chart()]);
    expect(markup).toContain('answer-chart-eyebrow');
    expect(markup).toContain('Sessions per day');
    // A figcaption rather than a heading: the answer's takeaway is the heading on
    // this card, and a chart panel sits several blocks under it.
    expect(markup).toMatch(/<figcaption class="answer-chart-eyebrow">Sessions per day<\/figcaption>/);
  });

  it('carries no chart-kind badge, on any panel', () => {
    // It named the shape a reader can see, and it was the widest thing in a head
    // that now has to fit in a half-width panel.
    const markup = render([chart(), chart({ id: 'chart-2', kind: 'bar', title: 'Sessions by country' })]);
    expect(markup).not.toContain('Line chart');
    expect(markup).not.toContain('Bar chart');
    expect(markup).not.toContain('data-slot="badge"');
  });

  it('falls back to the shape’s name when the agent titled the chart with nothing', () => {
    // A headless panel is worse than a generic head: the eyebrow is also the
    // plot's accessible name, and a plot announcing itself as "" is a plot with
    // no name at all.
    const markup = render([chart({ title: '   ' })]);
    expect(markup).toContain('Line chart');
  });

  it('sets the eyebrow at 10px tracked caps in the secondary rung', () => {
    const rule = ruleFor('.answer-chart-eyebrow {');
    expect(rule).toContain('font-size: 10px');
    expect(rule).toContain('font-weight: 700');
    expect(rule).toContain('letter-spacing: var(--ast-tracking-eyebrow)');
    expect(rule).toContain('text-transform: uppercase');
    expect(rule).toContain('color: var(--ast-text-secondary)');
  });
});

describe('the panel is a tinted surface, not the card recipe', () => {
  it('takes 12px of padding on a 5% wash of the foreground', () => {
    const rule = ruleFor('.answer-chart-panel {');
    expect(rule).toContain('padding: 12px');
    // ONE DECLARATION FOR BOTH THEMES. `--foreground` is ink on the light theme
    // and near-white on the night sky, so 5% of it is a faint ink wash in one and
    // the spec's 5% white in the other -- and it stays translucent in both, which
    // is what keeps the card's own sheet from showing as a seam around the panel.
    expect(rule).toContain('background: color-mix(in srgb, var(--foreground) 5%, transparent)');
    expect(rule).toContain('border-radius: var(--ast-radius-card)');
  });

  /** The rules alone, so a recipe discussed in prose is not read as one in use. */
  const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('writes no colour by hand and no second theme block', () => {
    // palette.test.ts makes the first claim across the whole stylesheet; it is
    // repeated here because this is a new partial and a chart is where a
    // hand-written series colour would look most reasonable. The second claim is
    // the point of reading `--foreground`: a `data-theme` block here would be the
    // theme mapping stated twice.
    expect(RULES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(RULES).not.toMatch(/rgba?\(/);
    expect(RULES).not.toContain('data-theme');
  });

  it('does not restate the card panel’s structure', () => {
    // `.chart-card` in answer-body.css is still the figure breakdown's recipe --
    // a hairline, an 8px radius and 16px of padding. Composing the two would be
    // two files arguing over one box.
    expect(RULES).not.toContain('.chart-card');
    expect(RULES).not.toContain("[data-slot='card");
  });

  it('is imported, so these rules reach the sheet the app ships', () => {
    // partial() reads a file directly; the import list is the cascade. A partial
    // on disk and absent from that list is a file the app does not have, and
    // every assertion above passes for the wrong reason.
    expect(partialNames()).toContain('answer-charts.css');
    // After the answer body, so a later change to the card's shared panel rules
    // still reaches these.
    const order = partialNames();
    expect(order.indexOf('answer-charts.css')).toBeGreaterThan(order.indexOf('answer-body.css'));
  });
});

describe('the list is as long as the answer’s own chart list', () => {
  it('renders a panel for every chart, with no cap of its own', () => {
    // The agent bounds how many panels an answer may carry, because that is a
    // decision about what an answer should say. A second, lower cap here would
    // silently drop a panel the answer had already committed to.
    const charts = [1, 2, 3, 4].map((n) => chart({ id: `chart-${n}`, title: `Panel ${n}` }));
    const markup = render(charts);
    for (const one of charts) expect(markup).toContain(one.title);
    expect(markup.match(/answer-chart-panel/g)).toHaveLength(4);
  });

  it('lays the panels out without a width query, because the column is not the window', () => {
    // The transcript column is the window less two rails, two page insets and
    // two card insets, any of which can be absent, so two readers at the same
    // window width get different room here. `auto-fit` asks how much width the
    // row actually got; a media query would be measuring the wrong box.
    const rule = ruleFor('.answer-charts {');
    expect(rule).toContain('grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr))');
    expect(rule).toContain('gap: 12px');
    expect(CSS).not.toContain('@media');
  });

  it('draws nothing at all for an answer that carried no charts', () => {
    // Every representative answer, and every answer from an endpoint predating
    // the tool. An empty grid would still take its gap.
    expect(render(undefined)).toBe('');
    expect(render([])).toBe('');
  });

  it('reserves the plot’s height while the chunk is in flight', () => {
    // The skeleton and the plot share one constant, so the transcript does not
    // jump when 1.4 MB lands.
    expect(render([chart()])).toContain('height:260px');
  });
});
