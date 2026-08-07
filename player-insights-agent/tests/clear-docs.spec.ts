import { test, expect, type Page } from '@playwright/test';

// Clearing documents used to require starting a new conversation, so the two
// things these tests hold down are that the control appears only when there is
// something to clear, and that a clear the server refused does not empty the
// list anyway: a composer showing no documents while the next question still
// carries them is worse than the coupling it replaced.

const DOCS = [
  {
    id: 'att-1',
    filename: 'q3-engagement.md',
    mime_type: 'text/markdown',
    size_bytes: 2048,
    created_at: '2026-08-04T18:00:00.000Z',
  },
  {
    id: 'att-2',
    filename: 'launch-notes.pdf',
    mime_type: 'application/pdf',
    size_bytes: 91_000,
    created_at: '2026-08-04T18:01:00.000Z',
  },
];

/** Opens a saved conversation that already has two documents attached. */
async function openConversationWithDocs(page: Page, onDelete: (route: import('@playwright/test').Route) => void) {
  let cleared = false;
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'conv-docs', title: 'Engagement review', updated_at: '2026-08-04T18:02:00.000Z' }]),
    })
  );
  await page.route('**/api/conversations/conv-docs/messages', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/conversations/conv-docs/attachments', (route) => {
    if (route.request().method() === 'DELETE') {
      cleared = true;
      onDelete(route);
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cleared ? [] : DOCS),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Engagement review/ }).click();
  await expect(page.getByText('q3-engagement.md')).toBeVisible();
}

test('clears every document without touching the conversation', async ({ page }) => {
  await openConversationWithDocs(page,
    (route) =>
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversationId: 'conv-docs', deleted: 2 }),
      })
  );

  await page.getByRole('button', { name: 'Clear docs (2)' }).click();

  await expect(page.getByText('q3-engagement.md')).toBeHidden();
  await expect(page.getByText('launch-notes.pdf')).toBeHidden();
  await expect(page.getByRole('button', { name: /Clear docs/ })).toBeHidden();
  // Still the same conversation: clearing documents is not starting over.
  await expect(page.getByRole('button', { name: /Engagement review/ })).toBeVisible();
});

test('keeps the documents visible when the server refuses to clear them', async ({ page }) => {
  await openConversationWithDocs(page,
    (route) =>
      void route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'attachment_clear_failed',
          message: 'The documents could not be cleared. Try again shortly.',
        }),
      })
  );

  await page.getByRole('button', { name: 'Clear docs (2)' }).click();

  await expect(page.getByText('The documents could not be cleared. Try again shortly.')).toBeVisible();
  await expect(page.getByText('q3-engagement.md')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear docs (2)' })).toBeVisible();
});

test('offers nothing to clear on a conversation with no documents', async ({ page }) => {
  await page.route('**/api/conversations', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Attach context' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Clear docs/ })).toBeHidden();
});
