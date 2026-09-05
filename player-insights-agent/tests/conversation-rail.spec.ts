import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * The rail's two controls: the watermark naming who asked, and the delete.
 */

// Fixture addresses, not real ones. A real address here fails the mirror leak
// check on the way to the public repository, and these assertions only need two
// identities that differ, whose they are is irrelevant to what is tested.
const ASKED_BY_ANALYST = 'first.analyst@example.invalid';
const ASKED_BY_DEV = 'local-development@app.invalid';

const CONVERSATIONS = [
  {
    id: 'conv-spikes',
    title: 'Were there any activity spikes in the reporting window, and what drove them?',
    updated_at: '2026-08-05T14:25:55.204Z',
    user_email: ASKED_BY_ANALYST,
  },
  {
    id: 'conv-sessions',
    title: 'How many active players did each title have in the last 30 days?',
    updated_at: '2026-08-05T06:33:35.229Z',
    user_email: ASKED_BY_DEV,
  },
];

/** Serves the rail from the fixture above, and reports what the page deleted. */
// The access gate stands in front of the whole app until it is answered, and what
// it is asking about is unrelated to the rail. Tolerant of the gate being absent,
// so a session that is no longer asked the question does not start timing out here.
//
// The gate is raced against the app rather than sampled for. `isVisible()` is a
// single reading with no auto-waiting, so asking it the instant `goto` resolved
// answered "no" whenever React had not painted the gate yet. The click was
// skipped, the gate stayed up, `{children}` never rendered, and `openRail`'s
// `toHaveCount(2)` timed out against a rail of zero rows. Which tests that hit
// changed from run to run, and it read as an app regression rather than as this.
async function loadPastTheAccessGate(page: Page) {
  // Answering the gate POSTs to /api/access-mode, which records the decision in
  // the store. That was the one request this file let through, which made the
  // isolation claim at the top of it false, and it was the store, which is the
  // thing the claim is about. Stubbed with the shape the route returns, so the
  // gate closes on a fixture rather than on whether a co-tenant dev server
  // happens to be up.
  await page.route('**/api/access-mode', (route) =>
    route.fulfill({
      json: {
        decision: {
          mode: 'service-principal',
          decidedAt: '2026-08-05T14:25:55.204Z',
          detail:
            'The user chose service-principal mode at the gate: own access was not verified. Who runs questions is set by the deployment, not by this choice.',
        },
        servingPrincipal: null,
      },
    })
  );
  await page.goto('/');
  const proceed = page.getByRole('button', { name: /^Proceed/ });
  const app = page.locator('.conversation-rail');
  // Whichever this session gets. The gate renders instead of the app rather
  // than over it, so exactly one of these is ever on screen at a time.
  await expect(proceed.or(app).first()).toBeVisible();
  if (await proceed.isVisible()) await proceed.click();
  // Past it, not merely asked to be. A gate that refused to close is its own
  // failure and says so here, rather than as a missing row further down.
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function openRail(page: Page, onDelete?: (route: Route) => void, shared = false) {
  const deleted = new Set<string>();

  await page.route('**/api/identity', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        signedInAs: ASKED_BY_DEV,
        executionIdentity: 'Player Insights service principal',
        executionMode: 'service-principal',
        sharedConversationRail: shared,
      }),
    })
  );

  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CONVERSATIONS.filter((row) => !deleted.has(row.id))),
    })
  );
  await page.route('**/api/conversations/conv-*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    if (route.request().method() !== 'DELETE') return void route.fallback();
    if (onDelete) return void onDelete(route);
    deleted.add(id);
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        conversationId: id,
        deleted: { conversations: 1, messages: 4, attachments: 0, feedback: 0 },
      }),
    });
  });
  await page.route('**/api/conversations/*/messages', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/conversations/*/attachments', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );

  await loadPastTheAccessGate(page);

  const rail = page.locator('.conversation-rail');
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  return rail;
}

test('marks each user with their organization without spelling out the address', async ({ page }) => {
  const rail = await openRail(page);

  const spikes = rail.locator('.conversation-row', { hasText: 'activity spikes' });
  const watermark = spikes.locator('.conversation-owner');

  await expect(watermark).toBeVisible();
  await expect(watermark.locator('.roster-organization-mark')).toContainText('EX');
  await expect(watermark.locator('.identity-chip-name')).toHaveText('first.analyst');
  await expect(watermark).toHaveAttribute('title', `${ASKED_BY_ANALYST} · example.invalid`);
  await expect(watermark).not.toContainText('Asked by');

  // Two owners, two watermarks, which is the only thing that makes it useful.
  const sessions = rail.locator('.conversation-row', { hasText: 'active players' });
  const theirs = sessions.locator('.conversation-owner');
  await expect(theirs.locator('.roster-organization-mark')).toContainText('AP');
  await expect(theirs.locator('.identity-chip-name')).toHaveText('local-development');
  await expect(theirs).toHaveAttribute('title', `${ASKED_BY_DEV} · app.invalid`);
});

test('names the two controls in a row apart, so neither answers to the other', async ({ page }) => {
  const rail = await openRail(page);

  // The delete control used to be called "Delete <title>", which made its name a
  // superstring of the entry's own. Asking for "the button called <title>" then
  // returned two controls (one that opens the conversation and one that
  // destroys it), which is a strict-mode failure in four other specs and, more
  // to the point, leaves a screen-reader user with no way to tell them apart.
  await expect(page.getByRole('button', { name: /Were there any activity spikes/ })).toHaveCount(1);

  const spikes = rail.locator('.conversation-row', { hasText: 'activity spikes' });
  const remove = spikes.getByRole('button', { name: 'Delete conversation' });
  // The action is the name; the conversation it acts on is the description, which
  // assistive tech announces after it.
  await expect(remove).toHaveAttribute('aria-describedby', 'rail-title-conv-spikes');
  await expect(page.locator('#rail-title-conv-spikes')).toHaveText(
    'Were there any activity spikes in the reporting window, and what drove them?'
  );
});

test('asks before it deletes, and deletes nothing until the question is answered', async ({ page }) => {
  let deleteRequests = 0;
  const rail = await openRail(page, (route) => {
    deleteRequests += 1;
    void route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  const spikes = rail.locator('.conversation-row', { hasText: 'activity spikes' });
  await spikes.getByRole('button', { name: 'Delete conversation' }).click();

  const confirming = rail.locator('.conversation-row.confirming');
  await expect(confirming).toContainText('Delete this conversation?');
  // The click armed a question and sent nothing. A rail entry sits one mis-click
  // away from the conversation being demonstrated.
  expect(deleteRequests).toBe(0);
  await expect(rail.locator('.conversation-row')).toHaveCount(2);

  await confirming.getByRole('button', { name: 'Cancel' }).click();
  await expect(rail.locator('.conversation-row.confirming')).toHaveCount(0);
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  expect(deleteRequests).toBe(0);
});

test('removes the entry once the delete is confirmed, and leaves its neighbour alone', async ({ page }) => {
  const rail = await openRail(page);

  const spikes = rail.locator('.conversation-row', { hasText: 'activity spikes' });
  await spikes.getByRole('button', { name: 'Delete conversation' }).click();
  await rail.locator('.conversation-row.confirming').getByRole('button', { name: 'Delete' }).click();

  await expect(rail.locator('.conversation-row')).toHaveCount(1);
  await expect(rail).not.toContainText('activity spikes');
  // The delete is aimed at one entry. Emptying the rail is the failure this
  // store has already had.
  await expect(rail).toContainText('active players');
});

test('keeps the entry in the rail when the server refuses to delete it', async ({ page }) => {
  const rail = await openRail(
    page,
    (route) =>
      void route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'conversation_delete_failed',
          message: 'This conversation could not be deleted right now. Nothing was removed. Try again shortly.',
        }),
      })
  );

  const spikes = rail.locator('.conversation-row', { hasText: 'activity spikes' });
  await spikes.getByRole('button', { name: 'Delete conversation' }).click();
  await rail.locator('.conversation-row.confirming').getByRole('button', { name: 'Delete' }).click();

  // The row survives a refusal, and the route's own wording is what is shown.
  // An entry that vanished without being deleted looks exactly like data loss.
  await expect(page.getByText('Nothing was removed. Try again shortly.')).toBeVisible();
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  await expect(rail).toContainText('activity spikes');
});

test('says on the page when the rail is carrying more than the signed-in user', async ({ page }) => {
  const shared = await openRail(page, undefined, true);
  await expect(shared.locator('.section-label-scope')).toHaveText(/all users/);

  // And says nothing when it is not, rather than labelling the ordinary case.
  await page.unrouteAll();
  const own = await openRail(page);
  await expect(own.locator('.section-label-scope')).toHaveCount(0);
});

test('filters a rail by any of the people on it, several at a time', async ({ page }) => {
  const rail = await openRail(page, undefined, true);
  const filter = rail.getByRole('group', { name: 'Show conversations from' });
  const analyst = filter.getByRole('button', { name: `${ASKED_BY_ANALYST} (1)` });
  const everyone = filter.getByRole('button', { name: 'All 2' });

  // Everyone plus one chip per person, so two people make three buttons.
  // Counted off the rail itself rather than a separate lookup, so the numbers
  // cannot disagree with the rows underneath them. Ordered by volume and then by
  // address, which on a one-each rail puts the analyst ahead of the signed-in
  // identity. Named by address rather than by initials, because two letters read
  // aloud are not an answer to "whose", and spelled from the constant so a later
  // address swap cannot leave this asserting a name the fixture no longer seeds.
  await expect(filter.getByRole('button')).toHaveCount(3);
  await expect(analyst).toBeVisible();
  await expect(filter.getByRole('button', { name: 'You (1)' })).toBeVisible();

  // Everyone is the empty selection, and says so rather than leaving the reader
  // to infer it from three unpressed chips.
  await expect(everyone).toHaveAttribute('aria-pressed', 'true');

  await analyst.click();
  await expect(analyst).toHaveAttribute('aria-pressed', 'true');
  await expect(everyone).toHaveAttribute('aria-pressed', 'false');
  await expect(rail.locator('.conversation-row')).toHaveCount(1);
  await expect(rail).toContainText('activity spikes');
  await expect(rail).not.toContainText('active players');

  // The point of the change: a second person joins the selection instead of
  // replacing the first, so two people's questions can be read side by side.
  await filter.getByRole('button', { name: 'You (1)' }).click();
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  await expect(rail).toContainText('activity spikes');
  await expect(rail).toContainText('active players');

  // Toggling off is the same control, and lands back on one person rather than
  // on everyone. The selection is a set, not a radio group wearing chips.
  await analyst.click();
  await expect(analyst).toHaveAttribute('aria-pressed', 'false');
  await expect(rail.locator('.conversation-row')).toHaveCount(1);
  await expect(rail).toContainText('active players');

  await everyone.click();
  await expect(everyone).toHaveAttribute('aria-pressed', 'true');
  await expect(filter.getByRole('button', { name: 'You (1)' })).toHaveAttribute('aria-pressed', 'false');
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
});

test("still offers the filter when every conversation is the same person's, which is the usual case", async ({
  page,
}) => {
  await page.route('**/api/identity', (route) =>
    route.fulfill({ json: { signedInAs: ASKED_BY_DEV, executionIdentity: 'sp', executionMode: 'service-principal' } })
  );
  await page.route('**/api/conversations', (route) =>
    route.fulfill({ json: CONVERSATIONS.map((row) => ({ ...row, user_email: ASKED_BY_DEV })) })
  );
  await loadPastTheAccessGate(page);

  const rail = page.locator('.conversation-rail');
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  // Present on a rail of one, which is the case this used to assert the absence
  // of. Hiding it here made "is this everything, or only mine" answerable only
  // by counting rows, and made the control appear for the first time on the day
  // a second person arrived, which is when nobody is looking for a new one.
  const filter = rail.getByRole('group', { name: 'Show conversations from' });
  await expect(filter).toBeVisible();
  // Everyone plus the one person, and no more: the chips are still derived from
  // the rows, so a rail of one cannot name anybody it is not showing.
  await expect(filter.getByRole('button')).toHaveCount(2);
  await expect(filter.getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true');

  const you = filter.getByRole('button', { name: 'You (2)' });
  await expect(you).toBeVisible();

  // Selecting the only person narrows to the same rows rather than to none,
  // which is the failure a filter over one owner could plausibly have.
  await you.click();
  await expect(you).toHaveAttribute('aria-pressed', 'true');
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
});

/**
 * The one case that still has no filter, and why `> 0` rather than always.
 *
 * Rows can reach the rail with no address on them: conversations written before
 * the column existed still read back without one. There is nobody to make a
 * chip from, so the group would be a label and an icon over nothing.
 */
test('has no filter when the rail names nobody at all', async ({ page }) => {
  await page.route('**/api/identity', (route) =>
    route.fulfill({ json: { signedInAs: ASKED_BY_DEV, executionIdentity: 'sp', executionMode: 'service-principal' } })
  );
  await page.route('**/api/conversations', (route) =>
    route.fulfill({ json: CONVERSATIONS.map(({ user_email: _omitted, ...row }) => row) })
  );
  await loadPastTheAccessGate(page);

  const rail = page.locator('.conversation-rail');
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  // Absent rather than present-and-empty. A group with only an "All" chip in it
  // advertises a filter that cannot filter anything.
  await expect(rail.locator('.conversation-filter')).toHaveCount(0);
});

/**
 * Serves a shared rail from an arbitrary fixture, for the collapsing tests below.
 */
async function openSharedRail(page: Page, rows: unknown[]) {
  await page.route('**/api/identity', (route) =>
    route.fulfill({
      json: {
        signedInAs: ASKED_BY_DEV,
        executionIdentity: 'Player Insights service principal',
        executionMode: 'service-principal',
        sharedConversationRail: true,
      },
    })
  );
  await page.route('**/api/conversations', (route) => route.fulfill({ json: rows }));
  await page.route('**/api/conversations/*/messages', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/conversations/*/attachments', (route) => route.fulfill({ json: [] }));
  await loadPastTheAccessGate(page);
  return page.locator('.conversation-rail');
}

/**
 * The collapse is per person, because a title is not an identity.
 *
 * A title is the question's first 80 characters and the four suggestion chips
 * on the welcome screen are fixed strings, so two people clicking the same chip
 * produce the same title by construction. Keyed on the title alone, the rail
 * showed one of them and silently dropped the other, and this deployment has
 * the shared rail on, so the one dropped is somebody else's work.
 */
test('two people who asked the same question are two rows, not one', async ({ page }) => {
  const title = 'Compare active players by title';
  const rail = await openSharedRail(page, [
    { id: 'conv-theirs', title, updated_at: '2026-08-05T14:25:55.204Z', user_email: ASKED_BY_ANALYST },
    { id: 'conv-mine', title, updated_at: '2026-08-05T06:33:35.229Z', user_email: ASKED_BY_DEV },
  ]);

  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  // Both rows carry the same title, so the watermark is the only thing telling
  // them apart, which is exactly the case the collapse used to erase.
  await expect(rail.locator('.conversation-owner [aria-hidden="true"]')).toHaveText(['FA', 'LD']);
});

/**
 * And the count beside a name is a count of rows on screen.
 *
 * The filter's totals were read off the raw conversations while the rail drew
 * the collapsed list, so every entry the collapse dropped made the number
 * disagree with the rows underneath it.
 */
test('the filter counts the rows the rail is showing, not the rows the store returned', async ({ page }) => {
  const rail = await openSharedRail(page, [
    {
      id: 'conv-asked-twice',
      title: 'How many active players did each title have in the last 30 days?',
      updated_at: '2026-08-05T14:25:55.204Z',
      user_email: ASKED_BY_ANALYST,
    },
    {
      id: 'conv-asked-again',
      title: 'How many active players did each title have in the last 30 days?',
      updated_at: '2026-08-05T11:02:00.000Z',
      user_email: ASKED_BY_ANALYST,
    },
    {
      id: 'conv-sessions',
      title: 'Were there any activity spikes in the reporting window?',
      updated_at: '2026-08-05T06:33:35.229Z',
      user_email: ASKED_BY_DEV,
    },
  ]);

  // One person asked the same thing twice, so their two entries collapse to one.
  await expect(rail.locator('.conversation-row')).toHaveCount(2);
  const filter = rail.getByRole('group', { name: 'Show conversations from' });
  await expect(filter.getByRole('button', { name: 'All 2' })).toBeVisible();
  await expect(filter.getByRole('button', { name: `${ASKED_BY_ANALYST} (1)` })).toBeVisible();
  await expect(filter.getByRole('button', { name: 'You (1)' })).toBeVisible();
});

test('screenshot', async ({ page }) => {
  const rail = await openRail(page);
  const clip = { x: 0, y: 0, width: 300, height: 560 };

  await rail.locator('.conversation-row', { hasText: 'activity spikes' }).hover();
  await page.screenshot({ path: '.ui-test-artifacts/rail-watermark-and-delete.png', clip });

  await rail
    .locator('.conversation-row', { hasText: 'activity spikes' })
    .getByRole('button', { name: 'Delete conversation' })
    .click();
  await expect(rail.locator('.conversation-row.confirming')).toBeVisible();
  await page.screenshot({ path: '.ui-test-artifacts/rail-delete-confirm.png', clip });
});
