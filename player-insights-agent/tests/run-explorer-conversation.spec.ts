import { test, expect } from '@playwright/test';

/**
 * Clicking "Run Explorer" from Ask PIA carries the open conversation across, so
 * the Explorer opens on that conversation's latest turn rather than on whoever's
 * run happens to be newest.
 *
 * Before this, the nav link dropped the conversation: the Explorer defaulted to
 * the first row of the whole list, which on a shared rail is a different person's
 * question. Arriving to read the provenance of the conversation you were just
 * looking at, and being shown someone else's, is the failure this page exists to
 * avoid.
 */

// Fixture ids and addresses, not real ones. The test needs three runs across two
// conversations, ordered newest-first the way `/api/runs` returns them; whose
// they are is irrelevant to what is asserted.
const NEWEST_OVERALL = {
  id: 'msg-newest-overall',
  kind: 'conversation',
  conversation_id: 'conv-someone-else',
  prompt: 'Which titles saw the largest week-over-week drop in active players?',
  stakeholder: 'someone@example.invalid',
  status: 'complete',
  duration_ms: 5200,
  rating: null,
  created_at: new Date().toISOString(),
};

const TARGET_LATEST = {
  id: 'msg-target-latest',
  kind: 'conversation',
  conversation_id: 'conv-target',
  prompt: 'And how did that break down by platform?',
  stakeholder: 'reader@example.invalid',
  status: 'complete',
  duration_ms: 4100,
  created_at: new Date(Date.now() - 60_000).toISOString(),
};

const TARGET_EARLIER = {
  id: 'msg-target-earlier',
  kind: 'conversation',
  conversation_id: 'conv-target',
  prompt: 'How many active players did each title have last month?',
  stakeholder: 'reader@example.invalid',
  status: 'complete',
  duration_ms: 3800,
  created_at: new Date(Date.now() - 120_000).toISOString(),
};

/** A minimal, honest trace body: enough for the pane to render without inventing stages. */
function noTrace(runId: string) {
  return {
    runId,
    kind: 'conversation',
    state: 'no-trace',
    mode: null,
    conversationId: 'conv-target',
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
    benchmark: null,
    note: 'This run has no stored trace.',
    undeclaredKeys: [],
  };
}

test('opens on the carried-over conversation, not the newest run overall', async ({ page }) => {
  // Newest-first, exactly as the server orders them, so the first match for the
  // conversation is its latest turn.
  await page.route('**/api/runs', (route) => route.fulfill({ json: [NEWEST_OVERALL, TARGET_LATEST, TARGET_EARLIER] }));
  await page.route('**/api/runs/*/trace', (route) => {
    const runId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    return route.fulfill({ json: noTrace(runId) });
  });

  await page.goto('/runs?conversation=conv-target');

  // The detail pane names the run it is showing by id, so the target's latest
  // turn is on screen and the newest-overall run is not.
  await expect(page.getByText(TARGET_LATEST.id)).toBeVisible();
  await expect(page.getByText(NEWEST_OVERALL.id)).toHaveCount(0);
  // The earlier turn of the same conversation is the list row it belongs to, not
  // the selected one: the latest turn wins.
  await expect(page.getByText(TARGET_EARLIER.id)).toHaveCount(0);
});

test('a hand-picked run still wins over the carried-over conversation', async ({ page }) => {
  await page.route('**/api/runs', (route) => route.fulfill({ json: [NEWEST_OVERALL, TARGET_LATEST, TARGET_EARLIER] }));
  await page.route('**/api/runs/*/trace', (route) => {
    const runId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    return route.fulfill({ json: noTrace(runId) });
  });

  await page.goto('/runs?conversation=conv-target');
  await expect(page.getByText(TARGET_LATEST.id)).toBeVisible();

  // Clicking a different run selects it, over the conversation carried in.
  await page.getByRole('button', { name: new RegExp(NEWEST_OVERALL.prompt.slice(0, 30)) }).click();
  await expect(page.getByText(NEWEST_OVERALL.id)).toBeVisible();
});

test('a conversation with no stored run falls back rather than showing nothing', async ({ page }) => {
  // The conversation was started this session and nothing has been written for
  // it yet. There is no run to open on, so the Explorer shows its usual default
  // instead of an empty pane under a conversation id that matches no row.
  await page.route('**/api/runs', (route) => route.fulfill({ json: [NEWEST_OVERALL] }));
  await page.route('**/api/runs/*/trace', (route) => {
    const runId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    return route.fulfill({ json: noTrace(runId) });
  });

  await page.goto('/runs?conversation=conv-with-no-runs');
  await expect(page.getByText(NEWEST_OVERALL.id)).toBeVisible();
});
