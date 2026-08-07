import { test, expect, type Page } from '@playwright/test';

/**
 * What a conversation change is supposed to leave behind.
 *
 * A run that stopped is a property of the conversation it stopped in. The
 * trace inspector reads `runStopped` and `liveStages`, and both used to survive
 * a conversation change, so a failed run's red "Stopped" badge and its two
 * completed steps went on narrating an empty conversation the user had just
 * opened. Read literally, the panel was describing a run that had never
 * happened in the conversation on screen.
 */

/** A complete answer, in the shape the non-streaming branch of the ask route returns. */
function answerBody(id: string, narrative: string) {
  return {
    id,
    mode: 'live',
    takeaway: narrative,
    narrative,
    figures: [],
    sources: [],
    caveats: [],
    sql: 'SELECT 1',
    trace: { id: `tr-${id}`, totalMs: 10, toolCalls: 0, stages: [] },
  };
}

/** Two finished steps and then a death, in the shape `/api/insights/ask` streams. */
const STOPPED_RUN = [
  'event: stage',
  `data: ${JSON.stringify({
    id: 'plan',
    name: 'Interpreted the question',
    kind: 'agent',
    start: 0,
    duration: 600,
    status: 'complete',
    calls: 1,
    input: 'Why did engagement drop?',
    output: 'Query the daily summary.',
  })}`,
  '',
  'event: stage',
  `data: ${JSON.stringify({
    id: 'genie',
    name: 'Asked Genie for daily actives',
    kind: 'tool',
    start: 600,
    duration: 1400,
    status: 'complete',
    calls: 1,
    input: 'daily actives',
    output: 'rows',
  })}`,
  '',
  'event: error',
  `data: ${JSON.stringify({ message: 'The agent stopped before it finished this question.' })}`,
  '',
  '',
].join('\n');

async function routeStoppedRun(page: Page) {
  await page.route('**/api/insights/ask', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: STOPPED_RUN })
  );
}

/** Asks a question whose run dies after two steps, and waits for that to be on screen. */
async function askAndWatchItStop(page: Page) {
  const inspector = page.locator('.trace-inspector');
  await page.getByPlaceholder(/Ask about player behavior/).fill('Why did engagement drop?');
  await page.getByRole('button', { name: /^Ask PIA$/ }).click();

  await expect(inspector.getByText('Stopped')).toBeVisible({ timeout: 15_000 });
  await expect(inspector).toContainText('Interpreted the question');
  return inspector;
}

test('a stopped run does not follow the user into a new conversation', async ({ page }) => {
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [] }));
  await routeStoppedRun(page);

  await page.goto('/');
  const inspector = await askAndWatchItStop(page);

  await page.getByRole('button', { name: /New conversation/ }).click();

  // A conversation with nothing in it has no run to describe, and saying
  // "Stopped" over one is a claim about a run the user cannot see.
  await expect(inspector).toContainText('No run yet');
  await expect(inspector.getByText('Stopped')).toHaveCount(0);
  await expect(inspector).not.toContainText('Interpreted the question');
});

test('a stopped run does not follow the user into a conversation they open', async ({ page }) => {
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      json: [{ id: 'conv-saved', title: 'Saved player analysis', updated_at: new Date().toISOString() }],
    })
  );
  await page.route('**/api/conversations/conv-saved/messages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/conversations/conv-saved/attachments', (route) => route.fulfill({ json: [] }));
  await routeStoppedRun(page);

  await page.goto('/');
  const inspector = await askAndWatchItStop(page);

  await page.getByRole('button', { name: /Saved player analysis/ }).click();

  await expect(inspector).toContainText('No run yet');
  await expect(inspector.getByText('Stopped')).toHaveCount(0);
  await expect(inspector).not.toContainText('Interpreted the question');
});

/**
 * The other way out of a conversation, and the only one left open during a run.
 */
test('an answer that lands after the user pressed Back stays out of where they went', async ({ page }) => {
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      json: [
        { id: 'conv-a', title: 'Alpha saved question', updated_at: new Date().toISOString() },
        { id: 'conv-b', title: 'Beta saved question', updated_at: new Date(Date.now() - 6e5).toISOString() },
      ],
    })
  );
  for (const id of ['conv-a', 'conv-b']) {
    await page.route(`**/api/conversations/${id}/messages`, (route) =>
      route.fulfill({
        json: [
          { id: `user-${id}`, role: 'user', content: `Question stored in ${id}` },
          {
            id: `msg-${id}`,
            role: 'assistant',
            content: `Stored ${id} answer`,
            response_json: answerBody(`msg-${id}`, `Stored ${id} answer`),
          },
        ],
      })
    );
    await page.route(`**/api/conversations/${id}/attachments`, (route) => route.fulfill({ json: [] }));
  }
  // Slow enough that going back completes first, which is the ordering that
  // puts the answer in the wrong transcript rather than merely discarding it.
  // The response is waited for below rather than slept past, so the absence
  // asserted at the end is an answer the page received and refused rather than
  // one still in the air when the assertion ran.
  await page.route('**/api/insights/ask', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fulfill({ json: answerBody('msg-inflight', 'Answer from the run that was left behind') });
  });

  await page.goto('/');
  // Two pushed history entries, so Back has a conversation to land on.
  await page.getByRole('button', { name: /Alpha saved question/ }).click();
  await expect(page.getByText('Stored conv-a answer').first()).toBeVisible();
  await page.getByRole('button', { name: /Beta saved question/ }).click();
  await expect(page.getByText('Stored conv-b answer').first()).toBeVisible();
  expect(page.url()).toContain('c=conv-b');

  const runAnswered = page.waitForResponse('**/api/insights/ask');
  await page.getByPlaceholder(/Ask about player behavior/).fill('A question asked inside Beta');
  await page.getByRole('button', { name: /^Ask PIA$/ }).click();
  await expect(page.getByRole('button', { name: /Working/ })).toBeVisible();

  await page.goBack();
  await expect(page.getByText('Stored conv-a answer').first()).toBeVisible();

  // The page has the answer in hand, and a moment to have done something with it.
  await runAnswered;
  await page.waitForTimeout(1000);

  await expect(page.getByText('Answer from the run that was left behind')).toHaveCount(0);
  await expect(page.getByText('Stored conv-a answer').first()).toBeVisible();
  // And the address bar still names the conversation the user chose.
  expect(page.url()).toContain('c=conv-a');
});
