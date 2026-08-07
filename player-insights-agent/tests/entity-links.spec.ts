import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * The tables an answer names, as links to where the app tracks them.
 */

const SHOTS = join(import.meta.dirname, '..', '.ui-test-artifacts', 'entity-links');

const SCHEMA = '<your_catalog>.<your_schema>';
const DAILY = `${SCHEMA}.gold_title_daily_summary`;
const PURCHASES = `${SCHEMA}.silver_purchases`;
/** A table whose bare name is an ordinary English word, which is the trap. */
const SESSIONS = `${SCHEMA}.sessions`;

function tableCheck(name: string, status = 'ok') {
  return {
    id: `table-${name}`,
    kind: 'table',
    name,
    label: `Table · ${name}`,
    status,
    detail: 'Metadata is readable and a single row was selected successfully.',
    checked_with: 'tables.get() + SELECT 1 ... LIMIT 1',
    duration_ms: 41,
    error: '',
    remedy: null,
  };
}

const PREFLIGHT = {
  checked_at: '2026-08-05T02:40:31.745Z',
  status: 'ok',
  principal: 'player-insights-serving-sp',
  principal_resolved: true,
  table_source: 'declared',
  checks: [tableCheck(DAILY), tableCheck(PURCHASES), tableCheck(SESSIONS)],
  assumptions: [],
  counts: { ok: 3, failed: 0, unverified: 0 },
  source: 'agent',
};

/**
 * Modelled on a real answer, including the parts that must NOT become links:
 * three column names, a table this deployment does not track, and a sentence
 * that opens with the word a table happens to be named after.
 */
const NARRATIVE =
  'Source: gold_title_daily_summary (published rollup), all available event dates, refunds already ' +
  'netted into both net_bookings_usd and recurrent_consumer_spending_usd. Full-game net bookings is ' +
  'derived as net_bookings_usd minus recurrent_consumer_spending_usd, consistent with the data ' +
  'dictionary definition of is_recurrent_consumer_spending. Sessions were flat over the window, and ' +
  'nothing here reads gold_title_weekly_rollup.';

const ANSWER = {
  type: 'answer',
  id: 'msg-entity-links',
  mode: 'live',
  takeaway: 'Full-game net bookings held steady across the window.',
  narrative: NARRATIVE,
  figures: [],
  charts: [],
  sources: [
    { name: DAILY, freshness: 'Read during this run' },
    { name: SESSIONS, freshness: 'Read during this run' },
    { name: 'Player Insights Data Dictionary Genie', freshness: 'Current demo seed' },
  ],
  // silver_purchases is tracked by the app but was NOT read for this answer, so
  // it is the case that separates "the app knows this table" from "this run
  // used it". It must stay plain text.
  caveats: [
    'Refunds are already netted into the figures read from gold_title_daily_summary; ' +
      'silver_purchases was not read for this answer.',
  ],
  sql: 'SELECT 1',
  trace: { id: 'trace-entity-links', totalMs: 900, toolCalls: 3, stages: [] },
};

async function askAndGetAnswer(page: Page) {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', (route) => route.fulfill({ json: ANSWER }));
  await page.route('**/api/preflight', (route) => route.fulfill({ json: PREFLIGHT }));

  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('How did full-game net bookings move?');
  await page.getByRole('button', { name: /Ask PIA/ }).click();
  await expect(page.getByText(ANSWER.takeaway)).toBeVisible();
}

test('a table the answer declared becomes a link; nothing else does', async ({ page }) => {
  await askAndGetAnswer(page);

  // Twice: once in the narrative, once in the caveat beneath it.
  const link = page.getByRole('link', { name: 'gold_title_daily_summary', exact: true });
  await expect(link).toHaveCount(2);
  await expect(link.first()).toHaveAttribute('href', `/connections?entity=${encodeURIComponent(DAILY)}`);

  // The source chip below the answer names the same table and is the same link.
  await expect(page.locator(`.source-strip a[data-entity="${DAILY}"]`)).toBeVisible();

  // Tracked by the app, but this run did not read it. Linking it would put
  // provenance on screen that the answer never claimed.
  await expect(page.getByText('silver_purchases was not read')).toBeVisible();
  await expect(page.getByRole('link', { name: 'silver_purchases', exact: true })).toHaveCount(0);

  // Columns. The Connections page documents none, so a link to one would go nowhere.
  for (const column of ['net_bookings_usd', 'recurrent_consumer_spending_usd', 'is_recurrent_consumer_spending']) {
    await expect(page.getByRole('link', { name: column, exact: true })).toHaveCount(0);
  }

  // A table this deployment does not track. Present as text, absent as a link.
  await expect(page.getByText('gold_title_weekly_rollup')).toBeVisible();
  await expect(page.getByRole('link', { name: 'gold_title_weekly_rollup', exact: true })).toHaveCount(0);

  // The trap: `sessions` is declared AND tracked, and the sentence opens with
  // the word. A bare name with no underscore in it is never matched in prose,
  // so the English word stays plain, which is what makes the links above
  // worth trusting.
  await expect(page.getByRole('link', { name: /^Sessions$/i })).toHaveCount(0);

  await page.locator('.answer-card').first().screenshot({ path: join(SHOTS, 'answer-with-links.png') });
});

test('following a link lands on that entry, highlighted', async ({ page }) => {
  await askAndGetAnswer(page);

  await page.getByRole('link', { name: 'gold_title_daily_summary', exact: true }).first().click();

  await expect(page).toHaveURL(new RegExp(`/connections\\?entity=${encodeURIComponent(DAILY).replace(/\./g, '\\.')}`));
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();

  // The row itself, not merely the page: arriving at a list to scan is the
  // behaviour this replaces. The table matrix is collapsed by default now that
  // it shares a page with eighteen connection rows, so an arriving deep link
  // has to open it as well as scroll to it; a reader who had to find and click
  // "Unity Catalog tables" first would have been sent to a page, not an entry.
  const row = page.locator(`tr[data-entity="${DAILY}"]`);
  await expect(row).toHaveAttribute('data-highlighted', 'true');
  await expect(row).toBeInViewport();
  await expect(row).toContainText(DAILY);
  await expect(row).toContainText('Reachable');

  // Exactly one row is highlighted; the other tracked tables are not.
  await expect(page.locator('tr[data-highlighted="true"]')).toHaveCount(1);

  await page.locator('.connections-page').screenshot({ path: join(SHOTS, 'connections-entry-highlighted.png') });
});

/**
 * Every answer this deployment has ever stored links to `/sources?entity=…`, and
 * those links are in Lakebase rows nobody is going to rewrite. The redirect has
 * to carry the query string: dropping it lands the reader on a page of eighteen
 * collapsed rows with no indication of which entry they asked for, which is
 * indistinguishable from the link having been wrong.
 */
test('an older link to /sources still lands on the entry it named', async ({ page }) => {
  await page.route('**/api/preflight', (route) => route.fulfill({ json: PREFLIGHT }));

  await page.goto(`/sources?entity=${encodeURIComponent(DAILY)}`);

  await expect(page).toHaveURL(new RegExp(`/connections\\?entity=${encodeURIComponent(DAILY).replace(/\./g, '\\.')}`));
  const row = page.locator(`tr[data-entity="${DAILY}"]`);
  await expect(row).toHaveAttribute('data-highlighted', 'true');
  await expect(row).toBeInViewport();
});

test('a link to an entry the report no longer has says so', async ({ page }) => {
  // Links are only drawn for tracked tables, so this state is reachable only by
  // a report changing between the answer and the click: a stale bookmark, or a
  // preflight that has since failed. Landing on an unhighlighted page with no
  // explanation would read as the reader having misremembered the answer.
  await page.route('**/api/preflight', (route) =>
    route.fulfill({ json: { ...PREFLIGHT, checks: [tableCheck(PURCHASES)], counts: { ok: 1, failed: 0, unverified: 0 } } })
  );

  await page.goto(`/sources?entity=${encodeURIComponent(DAILY)}`);
  await expect(page.getByText(`No entry here for ${DAILY}`)).toBeVisible();
  await expect(page.locator('tr[data-highlighted="true"]')).toHaveCount(0);
});

test('prose renders unchanged when the tracked set cannot be read', async ({ page }) => {
  // The preflight route is not cheap and can fail. Failing closed means the
  // answer reads exactly as it did before this feature existed.
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', (route) => route.fulfill({ json: ANSWER }));
  await page.route('**/api/preflight', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }));

  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('How did full-game net bookings move?');
  await page.getByRole('button', { name: /Ask PIA/ }).click();

  await expect(page.getByText(ANSWER.takeaway)).toBeVisible();
  await expect(page.getByText('gold_title_daily_summary').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'gold_title_daily_summary', exact: true })).toHaveCount(0);
});
