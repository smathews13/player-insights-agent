import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read rather than imported: Playwright's loader wants an import attribute for JSON, and
// a plain read keeps this file working whichever module resolution it runs under.
const liveCharts = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'live-charts.json'), 'utf-8')
) as Record<string, Record<string, unknown>>;

/**
 * The chart panels, driven by specs the deployed agent actually produced.
 */

// Playwright's own Chromium download is blocked on this machine, so these run against
// installed Chrome. Scoped to this file rather than set in playwright.config.ts, which
// other suites share.
test.use({ channel: 'chrome' });

const SHAPES = ['single series', 'multiple series', 'time series', 'categorical breakdown'] as const;

const answer = {
  type: 'answer',
  id: 'msg-charts',
  mode: 'live',
  takeaway: 'Four result shapes, four charts.',
  narrative: 'Each panel below came back from a separate live question.',
  figures: [],
  charts: SHAPES.map((shape, index) => ({ ...liveCharts[shape], id: `chart-${index + 1}` })),
  sources: [{ name: '<your_catalog>.<your_schema>.gold_title_daily_summary', freshness: 'Current' }],
  caveats: [],
  sql: 'SELECT 1',
  trace: { id: 'trace-charts', totalMs: 1000, toolCalls: 5, stages: [] },
};

/** Puts the four-chart answer on screen and returns the panels, in order. */
async function askAndGetPanels(page: import('@playwright/test').Page) {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', (route) => route.fulfill({ json: answer }));

  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('Show me every shape at once.');
  await page.getByRole('button', { name: /Ask PIA/ }).click();
  await expect(page.getByText(answer.takeaway)).toBeVisible();

  // Plotly puts `js-plotly-plot` on the container it is handed, so the panel and the plot
  // are the same node: the one PlotlyFigure renders with the chart's title as its
  // accessible name.
  const panels = page.locator('[role="img"][aria-label].js-plotly-plot');
  await expect(panels).toHaveCount(SHAPES.length, { timeout: 30_000 });
  return panels;
}

test('all four live result shapes render as Plotly panels', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const panels = await askAndGetPanels(page);

  // The badge reads the agent's derived `kind`, so this also asserts the four questions
  // came back as four different shapes rather than four bar charts.
  // `exact` matters here: an agent-written title legitimately contains the words the badge
  // uses, and a substring match would count the heading too.
  await expect(page.getByText('Bar chart', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Line chart', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Share of total', { exact: true })).toHaveCount(1);

  for (let index = 0; index < SHAPES.length; index += 1) {
    const panel = panels.nth(index);
    // Plotly draws into SVG. Marks present means it got real numbers rather than drawing
    // an empty frame, which is what a chart with a valid spec and no data looks like.
    const marks = await panel.locator('g.point, g.slice, path.js-line').count();
    expect(marks, `${SHAPES[index]} drew marks`).toBeGreaterThan(0);
    // The title travels as the accessible name, since the SVG's own text is a stream of
    // disconnected axis labels.
    await expect(panel).toHaveAttribute('aria-label', /\S/);
  }

  // Labels are the agent's, read off the result set. Asserted as "came from the data",
  // not as specific strings. The dataset is being replaced and these will change.
  await expect(page.getByText('Active Players', { exact: true })).toBeVisible();
  await expect(page.getByText('Paying Players', { exact: true })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test('the palette is the brand palette, and gold never draws a line', async ({ page }) => {
  const panels = await askAndGetPanels(page);

  const RED = 'rgb(228, 0, 43)';
  const INK = 'rgb(17, 17, 17)';
  const GOLD = 'rgb(252, 175, 23)';

  // Fills, where gold is legitimate: it is a slice on the part-of-whole chart.
  const sliceFills = await panels
    .nth(3)
    .locator('g.slice path.surface')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fill));
  expect(sliceFills).toContain(GOLD);
  expect(sliceFills[0]).toBe(RED);

  // Strokes, where it is not. Gold is 1.86:1 on white. A gold line is a chart that
  // reports success and shows nothing, so it must not appear as one on any panel.
  const strokes = await panels.evaluateAll((nodes) =>
    nodes
      .flatMap((node) => Array.from(node.querySelectorAll('path.js-line')))
      .map((line) => getComputedStyle(line).stroke)
  );
  expect(strokes.length).toBeGreaterThan(0);
  expect(strokes).not.toContain(GOLD);
  expect(strokes).toContain(RED);

  // Two series on one panel have to be tellable apart, and by more than a shade.
  const barColours = await panels
    .nth(1)
    .locator('g.trace.bars g.point path')
    .evaluateAll((nodes) => [...new Set(nodes.map((node) => getComputedStyle(node).fill))]);
  expect(barColours.sort()).toEqual([INK, RED].sort());
});

test('hover, zoom, and legend toggling all work', async ({ page }) => {
  const panels = await askAndGetPanels(page);
  const grouped = panels.nth(1);

  // The transcript scrolls to its newest message, which can leave a panel above the
  // viewport. Synthetic mouse events are in viewport coordinates, so measuring before
  // scrolling produces a negative y and every gesture below silently misses.
  await grouped.scrollIntoViewIfNeeded();

  // ── Legend ───────────────────────────────────────────────────────────────
  // Scoped to the info layer, because a unified hover tooltip is itself drawn as a legend
  // group inside the hover layer and would otherwise be counted as a second one.
  const legendEntries = grouped.locator('g.infolayer g.legend g.traces');
  await expect(legendEntries).toHaveCount(2);
  // Counting drawn bars rather than trace groups: Plotly keeps the group and empties it.
  const drawnBars = () => grouped.locator('g.trace.bars g.point').count();
  expect(await drawnBars()).toBe(10);
  await legendEntries.first().click();
  // Clicking an entry hides its series, which is Plotly's own behaviour and a large part
  // of why this renders the real library instead of drawing the SVG by hand.
  await expect.poll(drawnBars).toBe(5);
  await legendEntries.first().click();
  await expect.poll(drawnBars).toBe(10);

  // ── Hover ────────────────────────────────────────────────────────────────
  // Aimed at the drag layer, not at a bar. Plotly's hit-testing listens there and the
  // layer sits over the marks, so hovering a bar directly never reaches it.
  const plotArea = (await grouped.locator('.draglayer .nsewdrag').boundingBox())!;
  await page.mouse.move(plotArea.x + plotArea.width * 0.1, plotArea.y + plotArea.height * 0.5, { steps: 5 });

  // Both series in one tooltip: the agent set `hovermode: "x unified"` because several
  // series share the axis, and one tooltip per bar would be four to read instead of one.
  const hover = grouped.locator('g.hoverlayer');
  await expect(hover).toContainText(/Active Players/);
  await expect(hover).toContainText(/Paying Players/);
  // Thousands separators rather than 52.642k, which is the axis format the tool applies.
  await expect(hover).toContainText(/\d{1,3},\d{3}/);

  // ── Zoom ─────────────────────────────────────────────────────────────────
  // Read off the live plot object: the rendered axis range is the thing a zoom actually
  // changes, and asserting on it means a mode bar that looks right but does nothing fails.
  const readRange = () =>
    grouped.evaluate((node) => JSON.stringify((node as unknown as { layout?: { yaxis?: { range?: number[] } } }).layout?.yaxis?.range)
    );
  const before = await readRange();
  expect(before).not.toBe('undefined');

  const box = plotArea;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.8, { steps: 12 });
  await page.mouse.up();
  await expect.poll(readRange).not.toBe(before);

  // Double-click restores it, which is the escape hatch that makes drag-zoom safe to
  // leave enabled inside a scrolling transcript.
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(readRange).toBe(before);
});

test('Plotly is fetched only once an answer has a chart', async ({ page }) => {
  // The whole reason PlotlyFigure is a module of its own. If this fails, 1.4 MB moved
  // into the entry bundle and every visitor pays for it on first paint.
  const chunks: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\.js(\?|$)/.test(url)) chunks.push(url);
  });

  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', (route) => route.fulfill({ json: answer }));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /What would you like to understand/ })).toBeVisible();
  expect(chunks.some((url) => /PlotlyFigure|plotly/i.test(url))).toBe(false);

  await page.getByPlaceholder(/Ask about player behavior/).fill('Now give me a chart.');
  await page.getByRole('button', { name: /Ask PIA/ }).click();
  await expect(page.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 20_000 });
  expect(chunks.some((url) => /PlotlyFigure|plotly/i.test(url))).toBe(true);
});

test('an answer with no charts renders exactly as it did before', async ({ page }) => {
  // Every representative answer is this case, and so is every answer from an endpoint
  // still running an agent that predates the tool.
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', (route) =>
    route.fulfill({ json: { ...answer, charts: undefined, takeaway: 'No charts on this one.' } })
  );

  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('Just the number, please.');
  await page.getByRole('button', { name: /Ask PIA/ }).click();

  await expect(page.getByText('No charts on this one.')).toBeVisible();
  await expect(page.locator('.js-plotly-plot')).toHaveCount(0);
});
