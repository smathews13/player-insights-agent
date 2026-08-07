import { test, expect, type Page } from '@playwright/test';

/**
 * The header, measured against values longer than ours.
 *
 * This class of defect exists because every string the app is developed against
 * is short. A signed-in name five characters longer than the developer's pushed
 * the gear off the right edge and squeezed both identity chips to zero width, so
 * the deployment showed a header with no name in it and a horizontal scrollbar.
 * Nothing in the suite would have caught that, because the suite signed in as
 * somebody with a short address.
 *
 * So these run at the widths where the header is tightest, with a long address
 * and a long conversation title, and assert two things: the document does not
 * scroll sideways, and the signed-in name is legible rather than truncated to
 * its label. A name that has to be shortened is fine -- the chip carries the
 * whole address in a title attribute -- but a chip showing only "Signed in ..."
 * is the defect wearing an ellipsis.
 */

// Invented, and longer than any real address this deploys for. The test needs
// length rather than authenticity, and this file publishes, so a value read off
// a real deployment would be a disclosure about a person who did not choose it.
const LONG_IDENTITY = 'marguerite.vandenberg@contoso-interactive.example';
const LONG_TITLE =
  'Cross-title engagement for partner_share_prod.title_production.vw_flagship_title_summary over the trailing 90 days';

/** Just above the desktop nav breakpoint, a common laptop, and a wide desktop. */
const WIDTHS = [1024, 1280, 1440, 1680];

async function stubIdentity(page: Page) {
  await page.route('**/api/identity', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        signedInAs: LONG_IDENTITY,
        executionIdentity: 'Player Insights service principal',
        executionMode: 'service-principal',
        // Without a decision already taken, the access gate opens over the page
        // and there is no header to measure.
        accessDecision: {
          mode: 'service-principal',
          decidedAt: '2026-08-06T00:00:00.000Z',
          detail: 'Proceeded as the service principal.',
        },
      }),
    })
  );
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'conv-long', title: LONG_TITLE, updated_at: new Date().toISOString(), user_email: LONG_IDENTITY },
      ]),
    })
  );
}

for (const width of WIDTHS) {
  test(`the header fits a long signed-in name at ${width}px`, async ({ page }) => {
    await stubIdentity(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Player Insights Agent' })).toBeVisible();

    // The whole point: no sideways scroll, at any of these widths.
    const documentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(documentOverflow).toBeLessThanOrEqual(1);

    // Every header child has to land inside the header, gear included.
    const escaped = await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return ['no header'];
      const right = header.getBoundingClientRect().right;
      return [...header.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > right + 1)
        .filter((el) => {
          // A rect can extend past a box that clips it; only unclipped ones show.
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== 'visible') return false;
          }
          return true;
        })
        .map((el) => el.className || el.tagName);
    });
    expect(escaped).toEqual([]);
  });
}

test('the signed-in chip shows a name rather than an ellipsis, and titles the full address', async ({ page }) => {
  await stubIdentity(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  const chip = page.locator('.identity-chip').first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute('title', LONG_IDENTITY);

  // Enough of the local part to identify the person, not just the label.
  await expect(chip).toContainText('marguerite.vandenberg');
  const clipped = await chip.locator('span').first().evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(clipped).toBeLessThanOrEqual(1);
});

test('a conversation title naming a fully qualified table stays inside the rail', async ({ page }) => {
  await stubIdentity(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const title = page.locator('.conversation-title').first();
  await expect(title).toBeVisible();
  // The line clamp counts lines and cannot break a long unbroken token, so this
  // is what catches a title running out of the rail sideways.
  const overflow = await title.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
