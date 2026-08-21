import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `inNav` is whether the page is ADVERTISED, which is not the same as whether it
 * loads. The Benchmark Lab is behind an experimental toggle in App settings and
 * has no nav entry until somebody switches it on, while its route stays
 * registered so a bookmark still opens it. Asserting a link for it here is what
 * would break, and the page loading is still worth smoking.
 */
const routes = [
  { label: 'Ask', path: '/', heading: 'What would you like to understand about your players?', inNav: true },
  { label: 'Benchmark Lab', path: '/benchmarks', heading: 'Benchmark Lab', inNav: false },
  { label: 'Run Explorer', path: '/runs', heading: 'Run Explorer', inNav: true },
  // Sources & Capabilities merged into Connections. `/sources` still resolves,
  // as a redirect, but it is no longer a nav entry and has no heading of its own.
  { label: 'Connections', path: '/connections', heading: 'Connections', inNav: true },
];

const savedAnswer = {
  id: 'msg-saved',
  mode: 'live',
  takeaway: 'Saved conversation restored from Lakebase.',
  narrative: 'This answer proves that selecting a conversation restores its persisted response.',
  figures: [],
  sources: [{ name: '<your_catalog>.<your_schema>.gold_title_daily_summary', freshness: 'Current' }],
  caveats: ['Synthetic demo data.'],
  sql: 'SELECT 1',
  trace: {
    id: 'trace-saved',
    totalMs: 1200,
    toolCalls: 1,
    stages: [
      {
        id: 'plan',
        name: 'Interpreted the question',
        kind: 'agent',
        start: 0,
        duration: 1200,
        status: 'complete',
        calls: 1,
        input: 'Saved question',
        output: 'Saved answer',
      },
    ],
  },
};

// ── Tests ───────────────────────────────────────────────────────────────────

let testArtifactsDir: string;
let consoleLogs: string[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let failedRequests: string[] = [];

test('smoke test - Ask route reports a question it could not answer', async ({ page }) => {
  // The live endpoint may answer directly or propose a plan first, so force the
  // failure path. This used to cover a fallback answer built from a stored demo
  // response; there is no longer one to fall back to on any deployment, so what
  // is covered is the refusal and that nothing was invented in its place.
  await page.route('**/api/insights/ask', (route) =>
    route.fulfill({
      status: 503,
      json: {
        kind: 'unavailable',
        type: 'unavailable',
        code: 'DEPENDENCY_UNAVAILABLE',
        layer: 'dependency',
        retryable: true,
        message: 'The serving endpoint is unavailable.',
        request_id: 'req-smoke-unavailable',
        last_verified_at: null,
      },
    })
  );

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Player Insights Agent' })).toBeVisible();
  await expect(page.getByRole('heading', { name: routes[0].heading })).toBeVisible();
  // Scope to the welcome suggestions: saved conversations in the rail can carry the same title.
  await page
    .locator('.prompt-grid')
    .getByRole('button', { name: /Compare active players by title/ })
    .click();

  // What the reader is owed, in the order they read it: that the question went
  // unanswered, then that the blank space is not an answer.
  await expect(page.getByText('This question was not answered')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/serving endpoint is unavailable/)).toBeVisible();
  await expect(page.getByText(/rather than completing it with figures nobody queried/)).toBeVisible();
  await expect(page.getByText('Correlation ID: req-smoke-unavailable')).toBeVisible();
  // The half that would be the worse regression: no answer card underneath the
  // refusal, so there is nothing on the page for a question that never ran.
  await expect(page.locator('.answer-card')).toHaveCount(0);
});

test('conversation controls restore history and start a new chat', async ({ page }) => {
  await page.route('**/api/conversations', async (route) => {
    await route.fulfill({
      json: [
        { id: 'conv-saved', title: 'Saved player analysis', updated_at: new Date().toISOString() },
        {
          id: 'conv-quality',
          title: 'Player activity data quality',
          updated_at: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
    });
  });
  await page.route('**/api/conversations/conv-saved/messages', async (route) => {
    await route.fulfill({
      json: [
        { id: 'user-1', role: 'user', content: 'Restore my saved question' },
        { id: 'msg-saved', role: 'assistant', content: savedAnswer.narrative, response_json: savedAnswer },
      ],
    });
  });
  await page.route('**/api/conversations/conv-quality/messages', async (route) => {
    await route.fulfill({
      json: [
        { id: 'user-2', role: 'user', content: 'Check data quality' },
        {
          id: 'msg-quality',
          role: 'assistant',
          content: 'Quality answer',
          response_json: { ...savedAnswer, id: 'msg-quality', takeaway: 'Quality conversation restored.' },
        },
      ],
    });
  });

  await page.goto('/');

  // The app opens on a fresh chat, with saved conversations listed in the rail.
  await expect(page.getByRole('heading', { name: routes[0].heading })).toBeVisible();
  await expect(page.getByRole('button', { name: /Saved player analysis/ })).toBeVisible();

  await page.getByRole('button', { name: /Saved player analysis/ }).click();
  await expect(page.getByText('Saved conversation restored from Lakebase.')).toBeVisible();

  await page.getByRole('button', { name: /Player activity data quality/ }).click();
  await expect(page.getByText('Quality conversation restored.')).toBeVisible();
  await expect(page.getByText('Saved conversation restored from Lakebase.')).toHaveCount(0);

  await page.getByRole('button', { name: /New conversation/ }).click();
  await expect(page.getByRole('heading', { name: routes[0].heading })).toBeVisible();
  await expect(page.getByPlaceholder(/Ask about player behavior/)).toHaveValue('');

  const main = await page.locator('.conversation-main').boundingBox();
  expect(main?.width ?? 0).toBeGreaterThan(700);
});

test('plan approval flow re-posts the approved plan and keeps the full transcript', async ({ page }) => {
  const plan = {
    type: 'plan',
    mode: 'live',
    plan: {
      id: 'plan-abc123',
      question: 'Compare active players by title over the last 30 days.',
      summary: 'I will confirm definitions, then aggregate 30-day active players by brand and title.',
      steps: [
        { id: 's1', title: 'Confirm scope', description: 'Resolve brand scope and the window.', kind: 'context' },
        { id: 's2', title: 'Resolve definitions', description: 'Check what counts as active.', kind: 'definitions' },
        { id: 's3', title: 'Query governed data', description: 'Run read-only SQL.', kind: 'data' },
        { id: 's4', title: 'Summarize', description: 'Explain figures with sources.', kind: 'synthesis' },
      ],
      requires_approval: true,
      uses_conversation_context: true,
      uses_attachment_context: false,
    },
  };
  const askBodies: Record<string, unknown>[] = [];

  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    askBodies.push(body);
    await route.fulfill({
      json: body.executePlan
        ? { ...savedAnswer, type: 'answer', id: 'msg-approved', takeaway: 'Approved plan executed.' }
        : plan,
    });
  });

  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill(plan.plan.question);
  await page.getByRole('button', { name: /Ask PIA/ }).click();

  // 1. The plan card renders instead of an answer.
  await expect(page.getByText('Proposed analysis plan', { exact: true })).toBeVisible();
  await expect(page.locator('.plan-step')).toHaveCount(4);

  // 2. Revise opens the plan as an editor on the card, and Cancel puts it back.
  await page.getByRole('button', { name: 'Revise request' }).click();
  await expect(page.getByLabel('Step 1 title')).toHaveValue('Confirm scope');
  await expect(page.getByRole('button', { name: 'Send revised request' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Revise request' })).toBeVisible();

  // 3. Approve re-posts with approvedPlanId + executePlan.
  await page.getByRole('button', { name: /Approve and run/ }).click();
  await expect(page.getByText('Approved plan executed.')).toBeVisible();
  expect(askBodies).toHaveLength(2);
  expect(askBodies[0]).toMatchObject({ prompt: plan.plan.question, executePlan: false });
  expect(askBodies[1]).toMatchObject({ approvedPlanId: 'plan-abc123', executePlan: true });

  // 4. The whole transcript stays on screen, not just the last pair.
  await expect(page.locator('.user-bubble')).toHaveCount(2);
  await expect(page.locator('.plan-card.resolved')).toBeVisible();
  await expect(page.getByText('Proposed analysis plan', { exact: true })).toBeVisible();
  await expect(page.getByText('Approved plan', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/Ask about player behavior/)).toHaveValue('');
});

test('a question back from the agent is answerable in one click', async ({ page }) => {
  // The failure this covers: the transcript read `narrative` for every response,
  // and a clarification has none, so the agent's question rendered as an empty
  // bubble, on the one turn where the user has something to do.
  const clarification = {
    type: 'clarification',
    mode: 'live',
    clarification: {
      id: 'clarify-1',
      question: 'Which table did you mean? Give the full catalog.schema.table.',
      reason: 'The question named "the master table", which does not resolve to one table.',
      options: [
        '<your_catalog>.<your_schema>.silver_player_profiles',
        '<your_catalog>.<your_schema>.gold_player_180d_summary',
      ],
      trace: {
        ...savedAnswer.trace,
        id: 'trace-clarify',
        stages: [
          savedAnswer.trace.stages[0],
          {
            id: 'step-1-describe_table',
            name: 'Described a table',
            kind: 'tool',
            start: 400,
            duration: 300,
            status: 'partial',
            calls: 1,
            input: 'master table',
            output: 'Not a declared table.',
            depth: 1,
            parent_id: 'plan',
          },
        ],
      },
    },
  };
  const askBodies: Record<string, unknown>[] = [];

  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/insights/ask', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    askBodies.push(body);
    await route.fulfill({
      json:
        askBodies.length === 1
          ? clarification
          : { ...savedAnswer, type: 'answer', id: 'msg-after', takeaway: 'Answered the named table.' },
    });
  });

  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('How many rows are in the master table?');
  await page.getByRole('button', { name: /Ask PIA/ }).click();

  await expect(page.getByText(clarification.clarification.question)).toBeVisible();
  await expect(page.getByText('Needs one detail')).toBeVisible();
  await expect(page.locator('.plan-step')).toHaveCount(2);
  // Its own trace is what the inspector shows, not the reference stages.
  await expect(page.getByText('Question asked')).toBeVisible();
  await expect(page.getByText('Described a table')).toBeVisible();

  await page.locator('.plan-step').first().click();

  await expect(page.getByText('Answered the named table.')).toBeVisible();
  expect(askBodies).toHaveLength(2);
  expect(askBodies[1]).toMatchObject({ prompt: clarification.clarification.options[0] });
  // The question stays on screen above the answer it produced.
  await expect(page.locator('.plan-card.resolved')).toBeVisible();
  await expect(page.getByText('Question answered')).toBeVisible();
});

test('attachment chips report parsing, ready, and error states', async ({ page }) => {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/conversations/*/attachments', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    const name = decodeURIComponent(route.request().headers()['x-file-name'] ?? '');
    if (name.endsWith('.pdf')) {
      return route.fulfill({ status: 422, json: { error: 'Use a TXT, Markdown, CSV, or JSON file.' } });
    }
    return route.fulfill({
      status: 201,
      json: { id: `att-${name}`, filename: name, mime_type: 'text/markdown', size_bytes: 3300 },
    });
  });

  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# quarterly notes') },
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
  ]);

  await expect(page.locator('.attachment-chip.ready')).toHaveCount(1);
  await expect(page.locator('.attachment-chip.error')).toHaveCount(1);
  await expect(page.getByText('Use a TXT, Markdown, CSV, or JSON file.')).toBeVisible();

  await page.getByRole('button', { name: 'Remove notes.md' }).click();
  await expect(page.locator('.attachment-chip')).toHaveCount(1);
});

// ── Light-only theme ────────────────────────────────────────────────────────

/**
 * AppKit's stylesheet repaints every token under `@media (prefers-color-scheme: dark)`
 * via `:root:not(.light)`, which outranks a plain `:root`. That once turned body text
 * near-white on top of this app's hardcoded white surfaces. The app is light-only, so
 * both OS preferences have to land on the same palette, which is why this runs twice.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`under an OS ${colorScheme}-mode preference`, () => {
    test.use({ colorScheme });

    test('the palette stays light and text stays readable', async ({ page }) => {
      await page.route('**/api/conversations', (route) =>
        route.fulfill({
          json: [{ id: 'conv-a', title: 'Compare active players by title', updated_at: new Date().toISOString() }],
        })
      );
      await page.goto('/');
      await expect(page.getByRole('button', { name: /Compare active players by title/ }).first()).toBeVisible();

      const tokens = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const read = (name: string) => cs.getPropertyValue(name).trim();
        return {
          foreground: read('--foreground'),
          muted: read('--muted-foreground'),
          background: read('--background'),
          body: read('--db-body'),
          action: read('--primary'),
          working: read('--db-orange'),
          danger: read('--db-red-600'),
          amber: read('--db-amber'),
        };
      });
      expect(tokens).toEqual({
        foreground: '#161616',
        muted: '#6f6f6f',
        background: '#ffffff',
        // The second neutral rung, for long-form copy. Pinned because the whole
        // hierarchy of eyebrows and field keys rests on it being clearly darker than
        // --muted-foreground and clearly lighter than ink; drift in either direction
        // collapses a level.
        body: '#3a3838',
        // The pin that matters most after the DuBois revamp, because it is the one the
        // old palette could not express. Action and text used to be the same black, so
        // nothing caught a control that had quietly stopped looking like a control.
        // They are now different colours and this says which is which: anything you
        // press is blue. A regression here reads as ink returning to --primary, and it
        // would look deliberate rather than broken.
        action: '#2272b4',
        // Databricks orange, and it means one thing: the agent is working. It is barred
        // from text and from hairlines because it measures 3.62:1 on white, so it is
        // legible as a filled mass and not as a letterform. Pinned so that a retune
        // cannot quietly make the token block's own instructions false.
        working: '#ff3621',
        // The app's one red, and the only one. It is deliberately not a brand colour
        // (anything that reads this token is claiming a failure), so a reappearance of
        // #e4002b or #c50025 in the palette is the regression this pins, along with the
        // older one of mistaking #ff3621, which now has a meaning of its own, for it.
        danger: '#c82d4c',
        // Evaluation, and nothing else. Unchanged across the revamp, and the one value
        // in this block that was already wrong here: this test pinned #fcaf17 while the
        // stylesheet has always shipped #ffab00, so it was asserting a colour the app
        // never had.
        amber: '#ffab00',
      });

      // Text on the app's white surfaces, worst offender first: the rail titles were
      // once near-white on near-white. Amber and orange are excluded on purpose —
      // neither is ever type here, only a filled mass or a thick rule.
      //
      // These selectors name shell elements, so a rename in the header, rail or hero has
      // to be followed through to here. A miss returns null and is asserted separately
      // below, because "the element I was measuring is gone" and "its contrast is too
      // low" are different failures and the message should say which.
      const contrasts = await page.evaluate(() => {
        const channel = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
        const luminance = (rgb: string) => {
          const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        // Every one of these paints on an opaque white shell, so white is the honest
        // comparison point.
        const against = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const text = luminance(getComputedStyle(el).color);
          const [hi, lo] = [text, 1].sort((a, b) => b - a);
          return (hi + 0.05) / (lo + 0.05);
        };
        return {
          railTitle: against('.conversation-item'),
          heroHeading: against('.ask-hero h2'),
          heroBody: against('.ask-hero > p'),
          brandName: against('.brand-name h1'),
          brandKicker: against('.brand-full'),
          promptCard: against('.prompt-grid button'),
        };
      });
      for (const [surface, ratio] of Object.entries(contrasts)) {
        expect(ratio, `${surface} was not on the page to measure`).not.toBeNull();
        expect(ratio, `${surface} contrast on white`).toBeGreaterThan(4.5);
      }
    });
  });
}

test('the conversation rail collapses duplicate titles', async ({ page }) => {
  const title = 'Compare active players by title';
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      json: [
        { id: 'conv-1', title, updated_at: new Date().toISOString() },
        { id: 'conv-2', title, updated_at: new Date(Date.now() - 6e5).toISOString() },
        { id: 'conv-3', title, updated_at: new Date(Date.now() - 12e5).toISOString() },
        { id: 'conv-4', title: 'Player activity data quality', updated_at: new Date(Date.now() - 18e5).toISOString() },
      ],
    })
  );
  await page.goto('/');
  await expect(page.locator('.conversation-item')).toHaveCount(2);
  await expect(page.locator('.conversation-title', { hasText: title })).toHaveCount(1);
});

// ── PDF attachments ─────────────────────────────────────────────────────────

/** The user-facing messages `server/lib/pdf-text.ts` raises, keyed by PdfTextErrorCode. */
const PDF_ERRORS = {
  encrypted: 'This PDF is password protected. Remove the password and upload it again.',
  'no-text': 'No readable text was found in this report. Scanned or image-only PDFs are not supported.',
  corrupt: 'This PDF could not be read. It may be corrupt or incomplete.',
  timeout: 'This PDF took too long to process. Try a smaller file.',
  empty: 'This PDF is empty.',
} as const;

const pdfFile = (name: string) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.7\n% fake fixture bytes'),
});

/** Routes PDF uploads to a 422 carrying `message`; anything else succeeds. */
async function routeAttachments(page: Page, message?: string, delayMs = 0) {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/conversations/*/attachments', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    const name = decodeURIComponent(route.request().headers()['x-file-name'] ?? '');
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (message && name.toLowerCase().endsWith('.pdf')) {
      return route.fulfill({ status: 422, json: { error: message } });
    }
    return route.fulfill({
      status: 201,
      json: { id: `att-${name}`, filename: name, mime_type: 'application/pdf', size_bytes: 482_000 },
    });
  });
}

test('the file picker accepts the five confirmed formats', async ({ page }) => {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.goto('/');
  await expect(page.locator('input[type=file]')).toHaveAttribute('accept', '.pdf,.md,.json,.txt,.csv');
});

test('a PDF attaches successfully and reports a ready chip', async ({ page }) => {
  await routeAttachments(page);
  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('Summarize the attached report');
  await page.locator('input[type=file]').setInputFiles(pdfFile('q3-player-report.pdf'));

  const chip = page.locator('.attachment-chip.ready');
  await expect(chip).toHaveCount(1);
  await expect(chip.getByText('q3-player-report.pdf')).toBeVisible();
  await expect(chip.getByText(/KB · Ready/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Ask PIA/ })).toBeEnabled();
});

for (const code of ['encrypted', 'no-text'] as const) {
  test(`a ${code} PDF shows its full server message on the chip`, async ({ page }) => {
    const message = PDF_ERRORS[code];
    await routeAttachments(page, message);
    await page.goto('/');
    await page.locator('input[type=file]').setInputFiles(pdfFile(`${code}-report.pdf`));

    const chip = page.locator('.attachment-chip.error');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('role', 'alert');

    // The whole sentence must be readable, not clipped to a generic-looking stub.
    await expect(chip.getByText(message, { exact: true })).toBeVisible();
    const clipped = await chip.locator('small').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);

    // A failed attachment must never block asking a question.
    await page.getByPlaceholder(/Ask about player behavior/).fill('Ask anyway');
    await expect(page.getByRole('button', { name: /Ask PIA/ })).toBeEnabled();
  });
}

test('a slow PDF parse keeps the chip alive and submit disabled throughout', async ({ page }) => {
  await routeAttachments(page, undefined, 4_000);
  await page.goto('/');
  await page.getByPlaceholder(/Ask about player behavior/).fill('Summarize the attached report');
  await page.locator('input[type=file]').setInputFiles(pdfFile('large-analytics-export.pdf'));

  const chip = page.locator('.attachment-chip.parsing');
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('.animate-spin')).toBeVisible();
  await expect(chip.getByText(/Extracting PDF text/)).toBeVisible();

  // Submit stays disabled and explains itself for the whole parse.
  const submit = page.getByRole('button', { name: /Reading files/ });
  await expect(submit).toBeDisabled();

  // The elapsed counter proves the UI is live rather than hung.
  await expect(chip.getByText(/Extracting PDF text… \d+s/)).toBeVisible({ timeout: 10_000 });

  await expect(page.locator('.attachment-chip.ready')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Ask PIA/ })).toBeEnabled();
});

test('an oversized PDF is rejected client-side without uploading', async ({ page }) => {
  let uploads = 0;
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/conversations/*/attachments', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    uploads += 1;
    return route.fulfill({ status: 201, json: {} });
  });

  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({
    name: 'huge-report.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(9 * 1024 * 1024, 0x20),
  });

  await expect(page.locator('.attachment-chip.error')).toHaveCount(1);
  await expect(page.getByText('This report is larger than 8 MB. Try a smaller file.')).toBeVisible();
  expect(uploads).toBe(0);
});

for (const route of routes.slice(1)) {
  test(`smoke test - ${route.label} page loads`, async ({ page }) => {
    await page.goto(route.path);
    await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
    if (!route.inNav) {
      // Reached by URL and deliberately not offered. Asserted as absent rather
      // than skipped, so a link creeping back into the nav is a failure here and
      // not a thing somebody notices in a screenshot.
      await expect(page.getByRole('navigation').getByRole('link', { name: route.label })).toHaveCount(0);
      return;
    }
    // Scoped to the navigation. Unscoped, "Connections" also matches the
    // link inside the storage banner, so this failed on strict mode whenever the
    // store was empty, which is the state a customer's first run is in, and the one
    // state a smoke test should be reliable in. There are two navs (desktop and
    // mobile), so this asserts the visible one rather than a bare count.
    await expect(page.getByRole('navigation').getByRole('link', { name: route.label }).first()).toBeVisible();
  });
}

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  consoleLogs = [];
  consoleErrors = [];
  pageErrors = [];
  failedRequests = [];

  // Create temp directory for test artifacts
  testArtifactsDir = join(process.cwd(), '.smoke-test');
  mkdirSync(testArtifactsDir, { recursive: true });

  // Capture console logs and errors (including React errors)
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();

    // Skip empty lines and formatting placeholders
    if (!text.trim() || /^%[osd]$/.test(text.trim())) {
      return;
    }

    // Get stack trace for errors if available
    const location = msg.location();
    const locationStr = location.url ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}` : '';

    consoleLogs.push(`[${type}] ${text}${locationStr}`);

    // Separately track error messages (React errors appear here)
    if (type === 'error') {
      consoleErrors.push(`${text}${locationStr}`);
    }
  });

  // Capture page errors with full stack trace
  page.on('pageerror', (error) => {
    const errorDetails = `Page error: ${error.message}\nStack: ${error.stack || 'No stack trace available'}`;
    pageErrors.push(errorDetails);
    // Also log to console for immediate visibility
    console.error('Page error detected:', errorDetails);
  });

  // Capture failed requests
  page.on('requestfailed', (request) => {
    failedRequests.push(`Failed request: ${request.url()} - ${request.failure()?.errorText}`);
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const testName = testInfo.title.replace(/ /g, '-').toLowerCase();
  // Always capture artifacts, even if test fails
  const screenshotPath = join(testArtifactsDir, `${testName}-app-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const logsPath = join(testArtifactsDir, `${testName}-console-logs.txt`);
  const allLogs = [
    '=== Console Logs ===',
    ...consoleLogs,
    '\n=== Console Errors (React errors) ===',
    ...consoleErrors,
    '\n=== Page Errors ===',
    ...pageErrors,
    '\n=== Failed Requests ===',
    ...failedRequests,
  ];
  writeFileSync(logsPath, allLogs.join('\n'), 'utf-8');

  console.log(`Screenshot saved to: ${screenshotPath}`);
  console.log(`Console logs saved to: ${logsPath}`);
  if (consoleErrors.length > 0) {
    console.log('Console errors detected:', consoleErrors);
  }
  if (pageErrors.length > 0) {
    console.log('Page errors detected:', pageErrors);
  }
  if (failedRequests.length > 0) {
    console.log('Failed requests detected:', failedRequests);
  }

  await page.close();
});
