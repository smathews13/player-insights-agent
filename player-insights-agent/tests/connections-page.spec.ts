import { test, expect, type Page } from '@playwright/test';

/**
 * What the Connections page does with a save the server refused.
 *
 * `load()` also never cleared the banner, so a failed save left its wording up
 * across a successful Refresh, describing a refusal that was no longer true.
 *
 * Every resource is now a collapsed row rather than a card, so each of these
 * has to open the row before it can assert on anything inside it. That is the
 * point of the merge and not an accident of it: eighteen cards, each carrying
 * roughly one status line, were what made this page and the retired Sources
 * page indistinguishable. The test ids are unchanged, so what a test selects
 * has not moved, only when it is in the document.
 */

/** One editable row, which is the only kind with a save to refuse. */
const EDITABLE_ROW = {
  resource: {
    id: 'app-warehouse',
    label: 'SQL warehouse (app)',
    kind: 'sql-warehouse',
    changedBy: 'app-runtime',
    arrivesBy: 'Read from the app environment on every request.',
    bundleVariable: 'app_warehouse_id',
    agentKey: null,
    appEnvVar: 'DATABRICKS_WAREHOUSE_ID',
    actualFromCheck: null,
    applyWith: 'TARGET=<target> bundle/app-release.sh --apply',
    setup: 'required',
    stageable: true,
  },
  configured: 'wh-configured-000',
  configuredFrom: 'app-env',
  actual: '',
  actualObserved: false,
  intended: null,
  intendedAt: '',
  intendedBy: '',
  editable: true,
  changedByLabel: 'Applied by the app',
  changedByNote: 'The app reads this value on every request, so saving it applies it.',
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    resources: [EDITABLE_ROW],
    drift: [],
    status: 'ok',
    appBuildSha: 'abc1234',
    modelBuildSha: 'def5678',
    orchestratorReported: true,
    storeAvailable: true,
    checkedAt: '2026-08-05T21:46:15.146Z',
    ...overrides,
  };
}

const TYPED = 'wh-typed-by-the-deployer';

/**
 * Opens one connection row. Collapsed, a row is its label, one status badge and
 * the value in use; the controls only exist once it is open.
 */
async function openTheRow(page: Page) {
  await page.goto('/connections');
  const row = page.getByTestId('connection-app-warehouse');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^SQL warehouse \(app\)/ }).click();
  return row;
}

async function openTheEditor(page: Page) {
  const card = await openTheRow(page);
  await card.getByRole('button', { name: /Change/ }).click();
  const field = card.getByLabel('New value for SQL warehouse (app)');
  await field.fill(TYPED);
  return { card, field };
}

/**
 * Two problems with one resource are two problems.
 *
 * `provenance-*` and `mismatch-*` are separate faults with separate remedies,
 * one says the value did not come from the model artifact, the other says the
 * running system is not using the value it was configured with, and a resource
 * can have both. The card showed whichever came first in the array and hid the
 * other, so a deployer could fix the one they were shown, re-check, and find a
 * second blocking finding they had never been told about.
 */
test('a resource with two findings shows both, not whichever came first', async ({ page }) => {
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      json: settings({
        status: 'blocked',
        drift: [
          {
            id: 'provenance-app-warehouse',
            severity: 'blocking',
            resourceId: 'app-warehouse',
            headline: 'SQL warehouse (app) did not come from the model artifact',
            detail: 'The orchestrator resolved this from the serving environment.',
            remedy: '',
          },
          {
            id: 'mismatch-app-warehouse',
            severity: 'blocking',
            resourceId: 'app-warehouse',
            headline: 'SQL warehouse (app) in use is not the one configured',
            detail: 'Configured as wh-configured-000, but the check used wh-something-else.',
            remedy: '',
          },
          {
            // Says what the Intended banner directly above it already says, so
            // it stays suppressed. Two statements of one fact read as two.
            id: 'pending-app-warehouse',
            severity: 'pending',
            resourceId: 'app-warehouse',
            headline: 'SQL warehouse (app) has an intended value that is not in effect',
            detail: 'Saved, and the running system is using something else.',
            remedy: '',
          },
        ],
      }),
    })
  );

  const card = await openTheRow(page);
  await expect(card).toContainText('did not come from the model artifact');
  await expect(card).toContainText('in use is not the one configured');
  await expect(card).not.toContainText('has an intended value that is not in effect');
});

/**
 * Reachability and drift are two different facts, and the row says both without
 * pretending either is the other.
 *
 * The badge answers "did anything reach this", which is the question somebody
 * scanning eighteen rows is asking. Whether the value in use agrees with the one
 * configured is a quieter marker beside it, because that comparison only means
 * something once both values are on screen, which is inside the row. Collapsing
 * the two into one word would have to choose which fact to lose: a reachable
 * endpoint that is the wrong endpoint would read as fine, or a correctly
 * configured one nothing could reach would read as a configuration problem.
 */
test('drift is marked on the collapsed row without overwriting whether it was reached', async ({ page }) => {
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      json: settings({
        status: 'blocked',
        drift: [
          {
            id: 'mismatch-app-warehouse',
            severity: 'blocking',
            resourceId: 'app-warehouse',
            headline: 'SQL warehouse (app) in use is not the one configured',
            detail: 'Configured as wh-configured-000, but the check used wh-something-else.',
            remedy: '',
          },
        ],
      }),
    })
  );
  await page.goto('/connections');

  const row = page.getByTestId('connection-app-warehouse');
  // No check names this resource, so nothing reached it and the badge says so
  // rather than reading its own configuration back as health.
  await expect(row).toHaveAttribute('data-status', 'nothing-to-reach');
  await expect(row.locator('[data-drift="drift"]')).toBeVisible();
});

test('a refused save keeps the editor open with the typed value still in it', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  await page.route('**/api/settings/values/app-warehouse', (route) =>
    route.fulfill({
      status: 409,
      json: { detail: 'This value is baked into the model artifact. Log a new model version to change it.' },
    })
  );

  const { card, field } = await openTheEditor(page);
  await card.getByRole('button', { name: /Save and apply/ }).click();

  // The server's own refusal, wherever the page chooses to put it.
  await expect(page.getByTestId('settings-write-error')).toContainText('baked into the model artifact');
  // And the work is not thrown away: same box, same value, still editable.
  await expect(field).toBeVisible();
  await expect(field).toHaveValue(TYPED);
});

test('a save the server accepted closes the editor', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  await page.route('**/api/settings/values/app-warehouse', (route) => route.fulfill({ json: { saved: true } }));

  const { card, field } = await openTheEditor(page);
  await card.getByRole('button', { name: /Save and apply/ }).click();

  await expect(field).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Change/ })).toBeVisible();
  await expect(page.getByTestId('settings-write-error')).toHaveCount(0);
});

test('Refresh clears the banner from a save that has since been abandoned', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  await page.route('**/api/settings/values/app-warehouse', (route) =>
    route.fulfill({ status: 503, json: { detail: 'The settings store did not answer.' } })
  );

  const { card } = await openTheEditor(page);
  await card.getByRole('button', { name: /Save and apply/ }).click();
  await expect(page.getByTestId('settings-write-error')).toBeVisible();

  await page.getByRole('button', { name: 'Refresh' }).click();

  // A banner describing a refusal that is no longer being made is a page
  // reporting a problem the deployer cannot act on and cannot dismiss.
  await expect(page.getByTestId('settings-write-error')).toHaveCount(0);
});

/**
 * Which identity the deployment is connected as, and what its last access check
 * established.
 */
const PANEL_IDENTITY = {
  signedInAs: 'someone@example.invalid',
  identitySource: 'databricks-apps',
  executionIdentity: '7f3c1a20-0000-4000-8000-abcdefabcdef',
  executionMode: 'user-verified',
  accessDecision: {
    mode: 'user-verified',
    decidedAt: '2026-08-05T21:46:15.146Z',
    detail:
      'Verified you hold CAN_USE on the SQL warehouse and SELECT on 10 tables under your own token. ' +
      'CAN RUN confirmed on 2 of 2 Genie spaces under the same token. Row-level filters and column masks ' +
      'were not checked and are not covered by this.',
  },
  servingPrincipal: { id: '00000000-0000-4000-8000-000000000000', observedAt: '2026-08-05T21:46:15.146Z' },
  analyticalExecution: { mode: 'signed_in_user', verified: true },
};

function identityPanelRoutes(page: Page) {
  return Promise.all([
    page.route('**/api/settings', (route) => route.fulfill({ json: settings() })),
    page.route('**/api/identity', (route) => route.fulfill({ json: PANEL_IDENTITY })),
  ]);
}

/**
 * Opens the identity row. Identity used to be on both merged pages, an alert on
 * one and this panel on the other, saying overlapping things about the same two
 * principals. It is now one row whose collapsed line is the single fact a reader
 * wants at a glance, the principal every check below ran as, and whose detail is
 * this panel unchanged.
 */
async function openIdentity(page: Page) {
  await page.goto('/connections');
  await page.getByRole('button', { name: /^Connected as/ }).click();
  return page.getByTestId('identity-panel');
}

test('settings names both principals, and does not conflate them', async ({ page }) => {
  await identityPanelRoutes(page);
  const panel = await openIdentity(page);
  await expect(panel).toBeVisible();

  // Two different identities doing two different jobs. The app's authenticates
  // the web tier; the orchestrator's is what Genie and SQL actually see, and
  // showing one while calling it "the service principal" would hide the hop the
  // access gate exists to name.
  await expect(panel).toContainText('Orchestrator');
  await expect(panel).toContainText('00000000-0000-4000-8000-000000000000');
  await expect(panel).toContainText('App');
  await expect(panel).toContainText('7f3c1a20-0000-4000-8000-abcdefabcdef');
});

test('the verification detail is recorded here, with the id said once', async ({ page }) => {
  await identityPanelRoutes(page);
  await openIdentity(page);

  const permissions = page.getByTestId('identity-permissions');
  await expect(permissions).toContainText('CAN_USE on the SQL warehouse and SELECT on 10 tables');
  await expect(permissions).toContainText('CAN RUN confirmed on 2 of 2 Genie spaces');

  // The honest limit of what was checked. Keeping the grants and dropping this
  // would turn a partial check into a clean bill of health.
  await expect(permissions).toContainText(
    'Row-level filters and column masks were not checked and are not covered by this.'
  );

  // Verification copy no longer claims who executes; that is the Questions line.
  await expect(permissions).not.toContainText('execution still runs as');
  await expect(page.getByTestId('analytical-execution')).toContainText('Questions run as the signed-in user');

  // One full identifier per screen: the Orchestrator field, not the last-check prose.
  const panelText = await page.getByTestId('identity-panel').innerText();
  expect(panelText.split('00000000-0000-4000-8000-000000000000').length - 1).toBe(1);
});

test('an unobserved orchestrator principal says so rather than borrowing the app one', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  // A decision with nothing to report, rather than no decision: the gate renders
  // over every route until one exists, so a null here tested the dialog and never
  // reached the panel. Skipping decides without establishing anything, which is
  // the reachable state in which the panel has no access check to show.
  await page.route('**/api/identity', (route) =>
    route.fulfill({
      json: {
        ...PANEL_IDENTITY,
        servingPrincipal: null,
        accessDecision: { mode: 'skipped', decidedAt: '2026-08-05T21:46:15.146Z', detail: '' },
      },
    })
  );
  const panel = await openIdentity(page);

  // Null is a real state: the endpoint's identity is only knowable from inside
  // it. Filling the gap with the app's principal would be a guess presented as
  // a record, and this is the field a deployer would trust to settle an
  // argument about which identity read their data.
  await expect(panel).toContainText('Not available');
  await expect(panel).not.toContainText('00000000');
  await expect(page.getByTestId('identity-permissions')).toHaveCount(0);
});

/**
 * The way in, and what it is now the way into.
 *
 * The gear pointed at `/connections` on the argument that Connections was the
 * settings surface: it reads and writes `/api/settings`, and nobody hunting for
 * settings hunts for the word "Connections" in a nav bar that hides below `xl`.
 * A gear promises preferences, though, and landing on catalogs and warehouse ids
 * read as a mis-click, so `/settings` holds what belongs to the reader and
 * Connections keeps what the deployment is. This asserts the gear leads to the
 * first and that the second is still one link away.
 */
test('a gear in the header opens app settings, at every width', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  await page.goto('/');

  const gear = page.getByRole('link', { name: 'App settings' });
  await expect(gear).toBeVisible();
  await gear.click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'App settings' })).toBeVisible();

  // The deployment's own configuration is not on this page, and the join to it is
  // named for where it goes rather than left as an unexplained absence.
  await page.getByRole('link', { name: /Open Connections/ }).click();
  await expect(page).toHaveURL(/\/connections$/);
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();

  // Outside the nav that collapses, because the width where the nav disappears
  // behind a hamburger is the width where a gear matters most.
  await page.setViewportSize({ width: 480, height: 800 });
  await expect(page.getByRole('link', { name: 'App settings' })).toBeVisible();
});

/**
 * The Benchmark Lab is an evaluation workbench rather than part of what a
 * customer is shown, so it is hidden until somebody asks for it in App settings.
 * Hidden is not removed: the flag governs the nav entry, and `/benchmarks` is
 * still registered for a bookmark or a link already shared.
 */
test('the Benchmark Lab is not advertised until the experiment is switched on', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  await page.goto('/');

  await expect(page.getByRole('navigation').getByRole('link', { name: 'Benchmark Lab' })).toHaveCount(0);

  await page.getByRole('link', { name: 'App settings' }).click();
  await page.getByRole('switch', { name: 'Show Benchmark Lab in the navigation' }).click();

  // The nav and the sheet read one flag held above both of them, so the header
  // changes in the same render as the toggle rather than on the next navigation.
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Benchmark Lab' }).first()).toBeVisible();
});

/**
 * First-run setup lived at `/setup` for long enough to be bookmarked and linked
 * to. It has been removed, and an unmatched path renders the router's error
 * element, which reads as a broken app rather than as a page that has moved.
 */
test('a bookmark of the removed setup route lands on the deployment configuration', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  await page.goto('/setup');

  await expect(page).toHaveURL(/\/connections$/);
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
});

test('the gear does not shadow another control by name', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: settings() }));
  await page.goto('/');

  // A delete button named for its neighbour's title broke four tests this
  // morning. "App settings" is checked for exactly one match so it cannot
  // become an ambiguous locator the way that one did.
  await expect(page.getByRole('link', { name: 'App settings' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'App settings' })).toHaveCount(0);
});
