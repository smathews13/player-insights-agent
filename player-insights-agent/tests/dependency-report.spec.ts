import { test, expect, type Page } from '@playwright/test';

// The dependency report, which is now part of Connections rather than a page of
// its own. It is the only surface that tells an operator why the agent cannot
// reach something, so what matters is not that it renders but that it renders
// each answer the route can give, including the two that are easy to get wrong:
// a body that is not a report at all, and a failure whose whole value is the
// statement it carries.
//
// These tests deliberately do not stub `/api/settings`. The merged page reads
// both routes, and the preflight half has to render whatever the settings half
// does: a page that only reported dependencies when its other GET happened to
// succeed would go blank in exactly the deployment this report exists for.

const okCheck = {
  id: 'sql-warehouse',
  kind: 'sql-warehouse',
  name: '<sql-warehouse-id>',
  label: 'SQL warehouse · <sql-warehouse-id>',
  status: 'ok',
  detail: 'SELECT 1 succeeded on the configured warehouse.',
  checked_with: "statement_execution.execute_statement('SELECT 1')",
  duration_ms: 421,
  error: '',
  remedy: null,
};

const GRANT =
  'GRANT SELECT ON TABLE `<your_catalog>`.`<your_schema>`.`silver_purchases` ' +
  'TO `player-insights-serving-sp`;';

const blockedTable = {
  id: 'table-<your_catalog>.<your_schema>.silver_purchases',
  kind: 'table',
  name: '<your_catalog>.<your_schema>.silver_purchases',
  label: 'Table · <your_catalog>.<your_schema>.silver_purchases',
  status: 'failed',
  detail: 'The table is not visible to the serving principal.',
  checked_with: 'tables.get()',
  duration_ms: 12,
  error: "NotFound: Table 'silver_purchases' does not exist.",
  remedy: {
    kind: 'sql',
    statement: GRANT,
    note: 'Unity Catalog hides objects the caller cannot traverse.',
  },
};

function report(overrides: Record<string, unknown> = {}) {
  const checks = (overrides.checks as unknown[]) ?? [okCheck];
  return {
    checked_at: '2026-08-05T02:40:31.745Z',
    status: 'ok',
    principal: 'player-insights-serving-sp',
    principal_resolved: true,
    table_source: 'declared',
    checks,
    assumptions: [],
    counts: { ok: checks.length, failed: 0, unverified: 0 },
    source: 'agent',
    ...overrides,
  };
}

async function servePreflight(page: Page, body: unknown, status = 200) {
  await page.route('**/api/preflight', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  );
}

test('reports a healthy dependency set', async ({ page }) => {
  await servePreflight(page, report());
  await page.goto('/connections');
  await expect(page.getByText('Every dependency is reachable')).toBeVisible();
  // The principal shown has to be the serving one, not the signed-in user,
  // the whole premise of the check is that they differ. It is now the aside on
  // the collapsed "Connected as" row rather than a standing alert, which is the
  // one thing about identity worth a glance before anybody opens anything.
  await expect(page.getByRole('button', { name: /^Connected as/ })).toContainText('player-insights-serving-sp');
});

test('shows the literal GRANT for an unreachable table', async ({ page }) => {
  await servePreflight(page,
    report({ status: 'failed', checks: [okCheck, blockedTable], counts: { ok: 1, failed: 1, unverified: 0 } })
  );
  await page.goto('/connections');
  await expect(page.getByText('1 of 2 dependencies are blocked')).toBeVisible();
  // Asserting the statement itself, not a class name: an admin pastes this
  // string, so a truncated or re-worded one is a broken feature.
  await expect(page.getByLabel(/^Fix for Table ·/)).toHaveText(GRANT);
});

test('treats a 503 report as a report, not as a dead page', async ({ page }) => {
  // The route answers 503 with a real report when the agent never replied.
  // Rendering that as an error would hide the remedy it carries.
  await servePreflight(page,
    report({
      status: 'failed',
      source: 'app',
      principal_resolved: false,
      principal: '',
      checks: [
        {
          ...blockedTable,
          id: 'agent-endpoint',
          kind: 'serving-endpoint',
          label: 'Agent endpoint · player-insights-agent',
          remedy: { kind: 'cli', statement: 'uv run python log_model.py', note: 'Redeploy the agent.' },
        },
      ],
      counts: { ok: 0, failed: 1, unverified: 0 },
    }),
    503
  );
  await page.goto('/connections');
  // Uncollapsed, and above the connection rows, against the general rule that
  // everything on this page collapses: it is the only block a reader can act
  // on, and most of what it carries belongs to table checks, which have no
  // connection row to be found inside.
  await expect(page.getByText('What to fix')).toBeVisible();
  await expect(page.getByLabel('Fix for Agent endpoint · player-insights-agent')).toHaveText('uv run python log_model.py'
  );
});

test('offers a retry when the route answers with something that is not a report', async ({ page }) => {
  await servePreflight(page, { error: 'boom' }, 500);
  await page.goto('/connections');
  await expect(page.getByText(/not with a dependency report/)).toBeVisible();
  // One retry, not one per route. The page reads two GETs and both can fail at
  // once; two alerts each offering "Try again" would be two controls for one
  // intention, so the failures are listed together under a single button.
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(1);
});

test('says it is checking before the route answers', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/preflight', async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report()) });
  });
  await page.goto('/connections');
  await expect(page.getByText('Checking dependencies…')).toBeVisible();
  release();
  await expect(page.getByText('Every dependency is reachable')).toBeVisible();
});

/**
 * The seventh capability card is gone, and the reachability it never had is not
 * quietly reported as present.
 *
 * "Knowledge files" was a card with no check behind it and a permanent grey
 * "Not checked" badge. The uploads it described are stored in Lakebase, which
 * IS checked, so it folded into that row rather than becoming an eighteenth
 * connection with a status nothing could ever change. What must not happen is
 * the reverse: the Lakebase row inheriting a green badge on the strength of a
 * check that only covers the store, while saying nothing about the files.
 */
test('a blocked store does not read as reachable because a card was folded into it', async ({ page }) => {
  await servePreflight(page,
    report({
      status: 'failed',
      checks: [
        {
          ...okCheck,
          id: 'lakebase-storage',
          kind: 'lakebase',
          label: 'Lakebase · player-insights',
          status: 'failed',
          detail: 'The database refused the connection.',
          error: 'FATAL: password authentication failed',
          remedy: null,
        },
      ],
      counts: { ok: 0, failed: 1, unverified: 0 },
    })
  );
  await page.goto('/connections');

  const row = page.getByTestId('connection-lakebase');
  await expect(row).toHaveAttribute('data-status', 'blocked');
  await expect(row).not.toContainText('Reachable');
});
