import { test, expect, type Page } from '@playwright/test';

// The wording of a status comes from the app's own label function rather than
// being spelt out again here. A test that repeats the string is a second copy to
// keep in step, which is the exact defect this suite exists to prevent, and it
// broke once already when the `partial` wording was revised.
import { benchmarkStatusLabel } from '../client/src/benchmark-summary';

/**
 * Covers the findings that would have ended a demo, none of which had any test.
 *
 *  - crashes: an answer missing a field took down the whole application
 *  - fiction: screens presenting invented numbers as measurements
 *  - state:   one answer's rating appearing on another
 */

/** A complete answer. Individual tests delete from this to model a looser wire. */
function fullAnswer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-probe',
    mode: 'live',
    takeaway: 'Titan Fall leads 30-day actives at 61%.',
    narrative: 'Titan Fall holds the largest 30-day active base of the three governed titles.',
    figures: [{ label: 'Titan Fall', value: 61, display: '61%', comparison: '+4pp' }],
    sources: [{ name: 'players.activity_30d', freshness: 'Refreshed 2h ago' }],
    caveats: ['Synthetic demo data.'],
    sql: 'SELECT title, actives FROM players.activity_30d',
    trace: {
      id: 'tr-9f2a1c',
      totalMs: 4200,
      toolCalls: 3,
      stages: [
        {
          id: 's1',
          name: 'Chose the next step',
          kind: 'agent',
          start: 0,
          duration: 640,
          status: 'complete',
          calls: 1,
          input: 'q',
          output: 'plan',
        },
        {
          id: 's2',
          name: 'Called genie_query',
          kind: 'tool',
          start: 640,
          duration: 2400,
          status: 'complete',
          calls: 2,
          input: 'sql',
          output: 'rows',
          depth: 1,
          parent_id: 's1',
        },
      ],
    },
    ...overrides,
  };
}

async function askWith(page: Page, answer: unknown, question = 'Compare active players by title.') {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', (route) => route.fulfill({ json: answer }));
  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill(question);
  await page.getByRole('button', { name: /^Ask PIA$/ }).click();
}

// ── Crash safety ────────────────────────────────────────────────────────────

/**
 * The server's response schemas are loose by design, but the client cast payloads
 * into an interface declaring these fields non-optional and read straight through
 * them. A missing one threw during render, and because React Router's per-route
 * boundary catches before the app's own, the entire application was replaced by a
 * stack trace addressed to "Hey developer".
 */
const missingFields = [
  ['sources', { sources: undefined }],
  ['a null trace', { trace: null }],
  ['figures', { figures: undefined }],
  ['caveats', { caveats: undefined }],
  [
    'almost every field',
    { takeaway: undefined, figures: undefined, sources: undefined, caveats: undefined, trace: null },
  ],
] as const;

for (const [label, overrides] of missingFields) {
  test(`an answer missing ${label} still renders`, async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));

    await askWith(page, fullAnswer(overrides as Record<string, unknown>));

    await expect(page.locator('.answer-card').first()).toBeVisible({ timeout: 15_000 });
    // Neither the router's developer page nor our own fallback: it simply renders.
    await expect(page.getByText(/Hey developer|Unexpected Application Error/i)).toHaveCount(0);
    await expect(page.getByText(/This view could not be displayed/i)).toHaveCount(0);
    expect(crashes).toEqual([]);
  });
}

test('a route that throws degrades to something a stakeholder can read', async ({ page }) => {
  // Forces the boundary by making the runs list itself unparseable.
  await page.route('**/api/runs', (route) => route.fulfill({ status: 200, body: 'not json at all' }));
  await page.goto('/runs');
  // Whatever happens, the shell survives and the wording is for a person.
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Ask PIA' }).first()).toBeVisible();
  await expect(page.getByText(/Hey developer/i)).toHaveCount(0);
});

// ── The progress bar and the trace rail ─────────────────────────────────────

test('the trace rail is empty until something has been asked', async ({ page }) => {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.goto('/');

  const rail = page.locator('.trace-inspector');
  await expect(rail.getByText('No run yet')).toBeVisible();
  // It used to show a finished four-stage run, including a red "partial" failure,
  // before anyone had asked anything.
  await expect(rail.locator('.dag-node')).toHaveCount(0);
  await expect(rail.locator('.dag-node.partial')).toHaveCount(0);
});

test('a slow request counts up instead of freezing a full bar', async ({ page }) => {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', async (route) => {
    // Long enough to pass the point the old bar filled and stopped, which was 2.6s.
    await new Promise((resolve) => setTimeout(resolve, 9_000));
    await route.fulfill({ json: fullAnswer() });
  });
  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('A slow question.');
  await page.getByRole('button', { name: /^Ask PIA$/ }).click();

  const card = page.locator('.answer-card').first();
  // Indeterminate is the honest state: the ask route returns the whole answer in
  // one response, so the client cannot know how far along the agent is.
  await expect(card.locator("[data-slot='progress'][data-state='indeterminate']")).toBeVisible();
  await expect(card.getByText(/Working… [3-9]s/)).toBeVisible({ timeout: 12_000 });
  // The count moves, which is what says "slow" rather than "hung".
  await expect(card.getByText(/Working… [6-9]s/)).toBeVisible({ timeout: 12_000 });
  // None of the four invented stage names survive.
  await expect(page.getByText(/Finding the right data|Checking field definitions|Analyzing players/)).toHaveCount(0);
});

test('the rail reports the run that happened, and its slowest real stage', async ({ page }) => {
  await askWith(page, fullAnswer());
  const rail = page.locator('.trace-inspector');
  // Named twice on purpose (once as a stage in the graph, once as the slowest
  // stage in the metrics row), so this matches both.
  await expect(rail.getByText('Called genie_query').first()).toBeVisible({ timeout: 15_000 });
  // "Slowest" was the hardcoded word "Analysis"; the longest stage here is the tool call.
  await expect(rail.getByText('Analysis', { exact: true })).toHaveCount(0);
  await expect(rail.locator('.metric-row')).toContainText('Called genie_query');
});

test('an answer with no trace says so rather than reporting zero', async ({ page }) => {
  await askWith(page, fullAnswer({ trace: null }));
  const rail = page.locator('.trace-inspector');
  await expect(rail.locator('.metric-row')).toContainText('Not recorded');
  // 0.0s reads as a run that was measured and took no time.
  await expect(rail.locator('.metric-row')).not.toContainText('0.0s');
});

// ── Benchmark Lab ───────────────────────────────────────────────────────────

test('the Benchmark Lab invents nothing when the store is empty', async ({ page }) => {
  await page.route('**/api/runs', (route) => route.fulfill({ json: [] }));
  await page.goto('/benchmarks');

  await expect(page.getByText('Nothing has been benchmarked yet')).toBeVisible();
  // The exact fictions that used to be on this page.
  for (const fiction of ['8 of 10', '8 / 10', '6.2s', '92%', '4.6', '12 ratings']) {
    await expect(page.getByText(fiction, { exact: false })).toHaveCount(0);
  }
  await expect(page.getByText('Not reported').first()).toBeVisible();
});

test('a partly failed suite reports its denominators and its own outcome', async ({ page }) => {
  await page.route('**/api/runs', (route) =>
    route.fulfill({
      json: [
        {
          id: 'bench-1',
          kind: 'benchmark',
          prompt: 'Benchmark suite: poc-benchmark',
          stakeholder: null,
          status: 'partial',
          duration_ms: 268_000,
          rating: null,
          created_at: new Date().toISOString(),
        },
      ],
    })
  );
  await page.route('**/api/runs/bench-1/trace', (route) =>
    route.fulfill({
      json: {
        runId: 'bench-1',
        kind: 'benchmark',
        state: 'no-trace',
        mode: null,
        conversationId: null,
        createdAt: new Date().toISOString(),
        prompt: null,
        stakeholder: null,
        takeaway: '',
        narrative: '',
        sql: '',
        sources: [],
        trace: null,
        toolStages: [],
        mlflow: null,
        benchmark: {
          suiteId: 'poc-benchmark',
          passed: 3,
          total: 6,
          groundedness: 0.83,
          relevance: 0.79,
          guidelines: 1,
          durationMs: 268_000,
          counts: { total: 6, attempted: 6, passed: 3, failed: 1, errored: 2 },
          // The denominators the runner carries. Guidelines applies to two of the
          // six cases, so it must not be reported over all six.
          judgeRates: {
            groundedness: { rate: 0.83, scored: 6, yes: 5, no: 1 },
            relevance_to_context: { rate: 0.79, scored: 6, yes: 5, no: 1 },
            guidelines: { rate: 1, scored: 2, yes: 2, notApplicable: 4 },
          },
        },
        note: '',
        undeclaredKeys: [],
      },
    })
  );
  await page.goto('/benchmarks');

  // A fraction of everything attempted, so three errored cases can never be
  // reported as a score out of the three that answered.
  await expect(page.getByText('3 of 6')).toBeVisible();
  // Each rubric over the cases its own judge reached a verdict on. Guidelines
  // applied to two, so it reads 2 of 2 and says what became of the other four,
  // a judge that did not apply is never counted as a judge that said no.
  await expect(page.getByText('5 of 6 scored').first()).toBeVisible();
  await expect(page.getByText('2 of 2 scored')).toBeVisible();
  await expect(page.getByText('4 did not apply, not counted as failures')).toBeVisible();
  // Errored and failed named separately: averaging them hides a broken endpoint.
  await expect(page.getByText('2 errored')).toBeVisible();
  // Partial failure is its own outcome, not a variety of success or of failure.
  await expect(page.getByText(benchmarkStatusLabel('partial')).first()).toBeVisible();
  expect(benchmarkStatusLabel('partial')).not.toBe(benchmarkStatusLabel('failed'));
  // A minute-scale suite is readable as minutes.
  await expect(page.getByText('4m 28s').first()).toBeVisible();
  // An unrated run is a normal state, said in words: an empty star reads as zero.
  await expect(page.getByText('Not rated yet')).toBeVisible();
});

test('a suite whose numbers contradict each other is reported, not rendered', async ({ page }) => {
  await page.route('**/api/runs', (route) =>
    route.fulfill({
      json: [
        {
          id: 'bench-x',
          kind: 'benchmark',
          prompt: 'Benchmark suite: poc-benchmark',
          stakeholder: null,
          status: 'complete',
          duration_ms: 7_340,
          rating: null,
          created_at: new Date().toISOString(),
        },
      ],
    })
  );
  await page.route('**/api/runs/bench-x/trace', (route) =>
    route.fulfill({
      json: {
        runId: 'bench-x',
        kind: 'benchmark',
        state: 'no-trace',
        mode: null,
        conversationId: null,
        createdAt: new Date().toISOString(),
        prompt: null,
        stakeholder: null,
        takeaway: '',
        narrative: '',
        sql: '',
        sources: [],
        trace: null,
        toolStages: [],
        mlflow: null,
        benchmark: { suiteId: 'poc', passed: 12, total: 10, groundedness: 0.9, relevance: 0.9, guidelines: null, durationMs: 7_340 },
        note: '',
        undeclaredKeys: [],
      },
    })
  );
  await page.goto('/benchmarks');

  await expect(page.getByText(/contradict each other/i)).toBeVisible();
  await expect(page.getByText('12 of 10')).toHaveCount(0);
});

// ── Feedback scoping ────────────────────────────────────────────────────────

test("one answer's rating never lands on another", async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  let asked = 0;

  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/feedback', async (route) => {
    posted.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/insights/ask', (route) => {
    asked += 1;
    return route.fulfill({ json: fullAnswer({ id: `msg-${asked}`, takeaway: `Answer number ${asked}.` }) });
  });

  await page.goto('/');
  const composer = page.getByPlaceholder(/Ask about player behavior/);

  await composer.fill('First question.');
  await page.getByRole('button', { name: /^Ask PIA$/ }).click();
  await expect(page.getByText('Answer number 1.')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Thumbs down' }).click();
  await page.getByRole('textbox', { name: /What could be better/i }).fill('Missed the segment split.');
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText('Feedback saved')).toBeVisible();

  await composer.fill('Second question.');
  await page.getByRole('button', { name: /^Ask PIA$/ }).click();
  await expect(page.getByText('Answer number 2.')).toBeVisible({ timeout: 15_000 });

  // The bug: both of these followed whichever card rendered last, so answer two
  // looked rated and answer one's comment was posted against answer two's id.
  await expect(page.getByText('Feedback saved')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /What could be better/i })).toHaveCount(0);

  await page.getByRole('button', { name: 'Thumbs up' }).click();
  await expect(page.getByText('Feedback saved')).toBeVisible();

  expect(posted).toHaveLength(2);
  expect(posted[0]).toMatchObject({ messageId: 'msg-1', usefulness: 2, comment: 'Missed the segment split.' });
  expect(posted[1]).toMatchObject({ messageId: 'msg-2', usefulness: 5, comment: '' });
});

test('a rating that fails to save does not claim it saved', async ({ page }) => {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/feedback', (route) => route.fulfill({ status: 500, json: { error: 'nope' } }));
  await page.route('**/api/insights/ask', (route) => route.fulfill({ json: fullAnswer() }));

  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('A question.');
  await page.getByRole('button', { name: /^Ask PIA$/ }).click();
  await expect(page.locator('.answer-card').first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Thumbs up' }).click();
  // The usefulness figure is computed from the ratings table, so a write that
  // never landed must not look recorded.
  await expect(page.getByText(/was not recorded/i)).toBeVisible();
  await expect(page.getByText('Feedback saved')).toHaveCount(0);
});

// ── Navigation and layout ───────────────────────────────────────────────────

test('the browser Back button moves between conversations', async ({ page }) => {
  const conversations = [
    { id: 'conv-alpha', title: 'Alpha actives by title', updated_at: new Date().toISOString() },
    { id: 'conv-beta', title: 'Beta churn by cohort', updated_at: new Date(Date.now() - 6e5).toISOString() },
  ];
  await page.route('**/api/conversations', (route) => route.fulfill({ json: conversations }));
  for (const conversation of conversations) {
    const label = conversation.id === 'conv-alpha' ? 'ALPHA' : 'BETA';
    await page.route(`**/api/conversations/${conversation.id}/messages`, (route) =>
      route.fulfill({
        json: [
          { id: `${conversation.id}-u`, role: 'user', content: `Question in ${label}` },
          {
            id: `${conversation.id}-a`,
            role: 'assistant',
            content: `${label} narrative`,
            response_json: fullAnswer({ id: `${conversation.id}-a`, takeaway: `${label} takeaway.` }),
          },
        ],
      })
    );
    await page.route(`**/api/conversations/${conversation.id}/attachments`, (route) => route.fulfill({ json: [] }));
  }

  await page.goto('/');
  await page.getByRole('button', { name: /Alpha actives by title/ }).click();
  await expect(page.getByText('ALPHA takeaway.')).toBeVisible();

  await page.getByRole('button', { name: /Beta churn by cohort/ }).click();
  await expect(page.getByText('BETA takeaway.')).toBeVisible();

  // Selecting a conversation used to change state only, leaving the URL at "/", so
  // Back left the application entirely and the conversation was gone.
  await page.goBack();
  await expect(page.getByText('ALPHA takeaway.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Player Insights Agent' })).toBeVisible();

  await page.goForward();
  await expect(page.getByText('BETA takeaway.')).toBeVisible();

  // And it survives a reload, which is what makes it shareable.
  await page.reload();
  await expect(page.getByText('BETA takeaway.')).toBeVisible();
});

test('a run deep link that misses says so instead of showing another run', async ({ page }) => {
  await page.goto('/runs?run=no-such-run-1234');
  await expect(page.getByText(/no-such-run-1234/)).toBeVisible();
  await expect(page.getByText(/is not in the store/i)).toBeVisible();
});

/**
 * The banner was the whole of the fix, and it was not enough. Underneath it the
 * list still auto-selected its first row, so the Overview, Agent map, Timeline
 * and Details panes filled with a real run's takeaway, SQL, sources and timings
 *: a different person's question, under a URL naming yours. In a product whose
 * subject is where an answer came from, reading one run's provenance while
 * believing it is another's is the worst thing this page can do.
 */
test('a run deep link that misses selects nothing, rather than a neighbour', async ({ page }) => {
  // Both ids below are invented, and must stay so. They were real row keys from
  // our own demo database, copied out of a post-deploy capture, and this file
  // publishes: what the test needs is two distinct well-formed `msg-<hex>` ids,
  // which is all these are.
  const other = {
    id: 'msg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'conversation',
    conversation_id: 'conv-someone-else',
    prompt: 'follow up question, what within the Contoso label has the highest player counts',
    stakeholder: 'someone@acme.com',
    status: 'complete',
    duration_ms: 4200,
    rating: null,
    created_at: new Date().toISOString(),
  };
  await page.route('**/api/runs', (route) => route.fulfill({ json: [other] }));

  await page.goto('/runs?run=msg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await expect(page.getByText(/msg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/)).toBeVisible();

  // The detail pane names the run it is showing, so its id appearing anywhere
  // means a run nobody asked for is on screen.
  await expect(page.getByText(other.id)).toHaveCount(0);
  await expect(page.getByText('Select a run')).toBeVisible();
  await expect(page.getByText('Pick a run from the list to inspect its trace.')).toBeVisible();
  await expect(page.getByText(/nothing is selected/i)).toHaveCount(1);
  // Present once, in the list it belongs to, not a second time as a heading.
  await expect(page.getByText(other.prompt)).toHaveCount(1);

  // And choosing a run by hand still works: refusing to guess is not refusing.
  await page.getByRole('button', { name: new RegExp(other.prompt.slice(0, 30)) }).click();
  await expect(page.getByText(other.id)).toHaveCount(1);

  // The banner outlives the state it described: `?run=` stays in the URL, so it
  // is still on screen with four panes now populated underneath it. It has to
  // stop claiming the page is empty. This assertion is the one that was missing
  //, selecting a run was proved to work while the banner went on saying it had
  // not happened, and a reader told the screen is empty while looking at a run
  // learns to discount everything else this app reports.
  await expect(page.getByText(/is not in the store/i)).toBeVisible();
  await expect(page.getByText(/nothing is selected/i)).toHaveCount(0);
});

/**
 * The other half of the same failure. `POST /api/insights/ask` wrote the answer
 * through a helper whose contract is that a failed write does not change the
 * response, so a Lakebase failure on that one statement returned a complete
 * answer with a run id behind which there was no row. The panel offered to
 * explore it, and the Run Explorer could not find it.
 */
test('an answer the store did not keep does not offer to open a run that is not there', async ({ page }) => {
  await askWith(page, { type: 'answer', ...fullAnswer(), runStored: false });

  await expect(page.locator('.answer-card').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /Explore full run/ })).toHaveCount(0);
  await expect(page.getByText(/not stored/i).first()).toBeVisible();
});

test('an answer that was stored links to its own run', async ({ page }) => {
  await askWith(page, { type: 'answer', ...fullAnswer(), runStored: true });

  await expect(page.locator('.answer-card').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /Explore full run/ })).toHaveAttribute('href',
    '/runs?run=msg-probe'
  );
});

// ── The state a customer's first run is in ───────────────────────────────────

test('the nav is unambiguous in the empty store that used to break the smoke test', async ({ page }) => {
  // The storage banner links to the same page as the nav, so an unscoped
  // by-name query for that page matched two links and failed on strict mode. It
  // only did so with an empty store, so the suite passed on any machine that had
  // asked a question, and failed on a customer's first run. The page is now
  // Connections rather than Sources & Capabilities; the collision is unchanged,
  // because the banner still links to wherever dependency state is reported.
  await page.route('**/api/storage', (route) =>
    route.fulfill({
      json: {
        state: 'ok',
        since: new Date().toISOString(),
        last_ok_at: new Date().toISOString(),
        last_error: null,
        content: 'empty',
      },
    })
  );
  await page.goto('/');

  // The condition that caused it: the banner is up, and its link is real.
  await expect(page.getByText('Nothing stored yet.')).toBeVisible();
  expect(await page.getByRole('link', { name: 'Connections' }).count()).toBeGreaterThan(1);

  // Scoped to the visible nav, the smoke test's query resolves and clicks.
  const navLink = page.getByRole('navigation').getByRole('link', { name: 'Connections' }).first();
  await expect(navLink).toBeVisible();
  await navLink.click();
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
});

test('long unbroken strings do not push the layout sideways', async ({ page }) => {
  const longSource = 'main_prod_catalog.player_engagement_gold.player_activity_daily_aggregated_by_title_and_region_v3';
  const longLabel = 'Titan_Fall_Weekly_Active_Players_North_America_Region_Segment_Console_And_PC_Combined';

  await askWith(page,
    fullAnswer({
      takeaway: longLabel,
      figures: [{ label: longLabel, value: 61, display: '61%', comparison: '+4pp' }],
      sources: [{ name: longSource, freshness: 'Refreshed 2h ago' }],
      caveats: [longLabel],
    })
  );
  await expect(page.locator('.answer-card').first()).toBeVisible({ timeout: 15_000 });

  // A fully-qualified table name is the most ordinary thing this app displays, and
  // it used to give the whole page a horizontal scrollbar.
  const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(scrolls).toBe(false);
});
