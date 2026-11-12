import { test, expect, type Page } from '@playwright/test';

import { ACCESS_GATE_ENABLED } from '../shared/access-gate';

/**
 * The gate exists to stop a governance reviewer being told something untrue, so
 * these assert the wording as much as the wiring. "Verified" that quietly means
 * "the service principal is fine" would pass any test that only checked a
 * button worked.
 */

/**
 * Every test in this file drives a screen the app no longer shows.
 *
 * Skipped rather than deleted, and skipped on the switch rather than by hand, so
 * that flipping `ACCESS_GATE_ENABLED` back on brings the whole suite with it.
 * The parts of the gate that can be checked without a browser -- its copy, its
 * length, its focus decisions, its stylesheet -- still run on every commit.
 */
test.beforeEach(() => {
  test.skip(!ACCESS_GATE_ENABLED, 'The access check is disabled in shared/access-gate.ts.');
});

/**
 * Deliberately invented, not the real ones.
 *
 * The serving principal is created by Model Serving and rotates on redeploy, so
 * a real id transcribed here would be a stale internal identifier sitting in a
 * repository that gets mirrored to customers, and it would be checking that
 * the fixture matches itself either way. Nothing here depends on the values
 * being real, only on the two being different from each other.
 */
const SERVING = { id: '00000000-serving-0000-000000000000', observedAt: '2026-08-05T21:46:15.146Z' };
const APP_SP = '00000000-app-sp-0000-000000000000';

function identity(page: Page, overrides: Record<string, unknown> = {}) {
  return page.route('**/api/identity', (route) =>
    route.fulfill({
      json: {
        signedInAs: 'reviewer@example.example',
        identitySource: 'databricks-apps',
        executionIdentity: APP_SP,
        executionMode: 'service-principal',
        accessDecision: null,
        servingPrincipal: SERVING,
        sharedConversationRail: false,
        ...overrides,
      },
    })
  );
}

const DENIED_TABLE = '<your_catalog>.<your_schema>.raw_purchases';
const WAREHOUSE = 'wh-000000000000000';

/**
 * The limits the server attaches to every verification, pass or fail.
 *
 * Reproduced here rather than imported because these tests assert what a
 * person reads, and importing the strings would make them assert only that the
 * client renders whatever it was handed.
 */
const SERVING_SAW =
  'Also checked as the agent serving principal (what preflight reported for that identity, not a claim about who executes later asks): Data Genie space \u00b7 space-data (ok).';

const ROW_FILTERS = {
  what: 'Whether a row filter or a column mask narrows what you would see.',
  why: 'Neither reports itself. A filtered query succeeds and returns fewer rows, so a green above means the grant exists, not that you would see every row behind a figure.',
};

/**
 * What the server attaches once it HAS asked Genie as the reader.
 *
 * The first entry used to say the app "requests `sql` only" and returned
 * unconditionally. `dashboards.genie` is effective on the running app, so the
 * limitation is no longer that the question cannot be asked. It is that a
 * pass under the reader's token does not prove every on-screen figure came
 * from a space they can run, and does not itself decide who executes later asks.
 */
const LIMITS = [
  {
    what: 'Whether the answers you get would be limited to what you can see in Genie.',
    why: "Your own access to the spaces was checked and is reported above. That establishes which named spaces answered under your token; it does not prove every figure on screen came from one of them. Who runs a later ask is the deployment's execution identity (Connections), not this check.",
    insteadAs: SERVING_SAW,
  },
  ROW_FILTERS,
];

/** And what it attaches when the scope genuinely is not there to ask with. */
const LIMITS_WITHOUT_SCOPE = [
  {
    what: 'Whether the Genie spaces are shared with you.',
    why: 'Reading a Genie space needs the `dashboards.genie` scope on the forwarded token, and this token does not carry it (its own scope claim does not list it). That is a scope the app is missing rather than a permission you are missing, and no grant made to you would change it. Add `dashboards.genie` to `user_api_scopes`, then STOP and START the app: a scope is applied when the app starts, and a redeploy leaves it inert.',
    insteadAs: SERVING_SAW,
  },
  ROW_FILTERS,
];

const GENIE_SPACE = 'space-dictionary';

/** Fails the verification with a body shaped exactly as the route returns one. */
function verification(page: Page, status: number, body: Record<string, unknown>) {
  return page.route('**/api/access-verification', (route) => route.fulfill({ status, json: body }));
}

test('offers all three ways in before letting anyone in', async ({ page }) => {
  await identity(page);
  await page.goto('/');
  const gate = page.getByRole('dialog');
  await expect(gate).toBeVisible();

  await expect(page.getByRole('button', { name: /^Proceed/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Verify my access first/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Skip this/ })).toBeVisible();

  await page.screenshot({ path: 'test-results/access-gate.png', fullPage: false });
});

/**
 * The default is now to check the reader's own access rather than to wave them
 * through as the service principal.
 *
 * Asserted through the primary style rather than the label, because that is
 * what a person actually reads first: a screen whose recommended action is the
 * one that establishes nothing is the thing this inversion exists to stop.
 */
test('leads with checking your own access, and offers the service principal as the fallback', async ({ page }) => {
  await identity(page);
  await page.goto('/');

  await expect(page.getByRole('button', { name: /Verify my access first/ })).toHaveClass(/access-gate-primary/);
  await expect(page.getByRole('button', { name: /^Proceed as the service principal/ })).not.toHaveClass(
    /access-gate-primary/
  );
  await expect(page.getByRole('button', { name: /^Proceed as the service principal/ })).toContainText('The fallback');
});

/**
 * The single correctness constraint on this screen: making verification the
 * default must not invent an execution identity. Who runs asks is
 * analyticalExecution on Connections, not these buttons.
 */
test('never invents who executes; it only describes what was checked', async ({ page }) => {
  await identity(page);
  await page.goto('/');
  const gate = page.getByRole('dialog');

  await expect(gate).toContainText('checks your access under your own token');
  await expect(gate).toContainText('does not decide who runs the questions that follow');
  // "You could have read this, not that you did" is no longer on the opening
  // screen. It qualifies a result, so it is behind the limits disclosure beside
  // one, and the test for it is with the result below.
  await expect(gate).not.toContainText(/could.* have read the data behind an answer/);
  await expect(gate).not.toContainText(/still runs as a service principal/i);
  await expect(gate).not.toContainText(/Execution still happens as the service principal/i);
  await expect(gate).not.toContainText(/Questions execute as/i);
});

test('proceeding records the mode and lets them straight in', async ({ page }) => {
  await identity(page);
  let posted: unknown = null;
  await page.route('**/api/access-mode', async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({
      json: {
        decision: {
          mode: 'service-principal',
          decidedAt: '2026-08-05T21:46:15.146Z',
          detail:
            'The user chose service-principal mode at the gate: own access was not verified. Who runs questions is set by the deployment, not by this choice.',
        },
        servingPrincipal: SERVING,
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /^Proceed/ }).click();

  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posted).toEqual({ mode: 'service-principal' });

  // The choice is recorded and the app is usable, with nothing standing over it.
  // The mode and the principal are on Connections; the strip that used to report
  // them here was removed, so a status row appearing above every page again is a
  // regression rather than a feature, and the id must never be printed in full.
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('#root')).not.toContainText(SERVING.id);
});

test('a decision made in this session leaves no standing strip behind it', async ({ page }) => {
  await identity(page, {
    executionMode: 'service-principal',
    accessDecision: {
      mode: 'service-principal',
      decidedAt: '2026-08-05T21:46:15.146Z',
      detail:
        'The user chose service-principal mode at the gate: own access was not verified. Who runs questions is set by the deployment, not by this choice.',
    },
  });

  await page.goto('/');

  // Held for service-principal specifically, which was the last mode to keep a
  // strip: it survived the change that auto-hid the verified one, on the
  // argument that a mode chosen once should not then be invisible. The record
  // being on Connections settled that, and this asserts the argument stays
  // settled for the mode most likely to reopen it.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('a user-verified decision does not leave a standing status badge', async ({ page }) => {
  await identity(page, {
    executionMode: 'user-verified',
    accessDecision: {
      mode: 'user-verified',
      decidedAt: '2026-08-05T21:46:15.146Z',
      detail:
        'Verified you hold SELECT on 10 tables under your own token. CAN RUN confirmed on 2 of 2 Genie spaces under the same token. Row-level filters and column masks were not checked and are not covered by this.',
    },
  });

  await page.goto('/');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Verified access is recorded on Connections. A strip saying so over every
  // page was the annoyance, and it is gone for every mode rather than for this
  // one.
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
});

/**
 * A skip must not read as a check that passed. That sentence is the server's,
 * carried in the decision detail and printed on Connections, so what is
 * assertable here is narrower than it was: the skip is recorded as a skip, and
 * the gate does not stay in the way. The wording itself was asserted against
 * the strip's copy, and went when the strip did.
 */
test('skipping is recorded as a skip and does not hold the door shut', async ({ page }) => {
  await identity(page);
  let posted: unknown = null;
  await page.route('**/api/access-mode', async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({
      json: {
        decision: {
          mode: 'skipped',
          decidedAt: '2026-08-05T21:46:15.146Z',
          detail:
            'The user skipped the access gate. Nothing was checked under their token. Who runs questions is set by the deployment, not by this choice.',
        },
        servingPrincipal: SERVING,
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Skip this/ }).click();

  // Recorded as its own mode, not folded into the fallback, so a conversation
  // cannot look verified because nobody looked.
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(posted).toEqual({ mode: 'skipped' });
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('a passing verification admits them with the boundary spelled out, not hidden', async ({ page }) => {
  await identity(page);
  await page.route('**/api/access-verification', (route) =>
    route.fulfill({
      json: {
        verified: true,
        ok: 10,
        denied: 0,
        errored: 0,
        verdicts: [],
        decision: {
          mode: 'user-verified',
          decidedAt: '2026-08-05T21:46:15.146Z',
          detail:
            'Verified you hold SELECT on 10 tables under your own token. CAN RUN confirmed on 2 of 2 Genie spaces under the same token. Row-level filters and column masks were not checked and are not covered by this.',
        },
        servingPrincipal: SERVING,
      },
    })
  );

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  // The dialog must be gone and the app usable, with nothing left standing in
  // its place. The verification record lives on Connections.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('a decision already on the server does not ask again', async ({ page }) => {
  await identity(page, {
    executionMode: 'user-verified',
    accessDecision: {
      mode: 'user-verified',
      decidedAt: '2026-08-05T21:46:15.146Z',
      detail:
        'Verified you hold SELECT on 10 tables under your own token. CAN RUN confirmed on 2 of 2 Genie spaces under the same token. Row-level filters and column masks were not checked and are not covered by this.',
    },
  });

  await page.goto('/');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
});

/**
 * The whole point of the gate for somebody who is actually short of a grant.
 *
 * A count is not a result. This asserts the four things a blocked person needs
 * and cannot get anywhere else: which object, which privilege, the statement
 * that fixes it, and what stops working until it is run.
 */
test('a refused table names the object, the privilege, the grant, and what degrades', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 9,
    denied: 1,
    errored: 0,
    // The count is the screen's, computed from ok/denied/errored and printed as
    // one count line. What the server sends is the consequence a count cannot
    // carry, and that is now one sentence.
    impact: [
      'Genie is all-or-nothing per space: a space fails as a whole if a single table it curates is unreadable, so a question it would have answered either fails outright or falls back to direct SQL over the tables that do resolve, in the same voice as a complete one.',
    ],
    verdicts: [
      {
        table: DENIED_TABLE,
        status: 'denied',
        reason: 'no-grant',
        detail: `You do not hold SELECT on ${DENIED_TABLE}. The API said so in those terms rather than hiding the object, so this is a grant that is missing and not a table that is absent.`,
        missing: { object: DENIED_TABLE, permission: 'SELECT', objectKind: 'table' },
        remedy: {
          kind: 'sql',
          statement: `GRANT USE CATALOG ON CATALOG \`<your_catalog>\` TO \`reviewer@example.example\`;\nGRANT USE SCHEMA ON SCHEMA \`<your_catalog>\`.\`<your_schema>\` TO \`reviewer@example.example\`;\nGRANT SELECT ON TABLE \`<your_catalog>\`.\`<your_schema>\`.\`raw_purchases\` TO \`reviewer@example.example\`;`,
          note: 'Unity Catalog hides objects the caller cannot traverse, so a missing USE CATALOG or USE SCHEMA reads as a missing table. Whoever owns the catalog can run these, and if the catalog is not visible to you at all, a metastore admin has to make the grant.',
        },
        apiMessage:
          "[INSUFFICIENT_PERMISSIONS] Insufficient privileges: User does not have SELECT on Table 'raw_purchases' SQLSTATE: 42501",
      },
    ],
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText(DENIED_TABLE);
  await expect(alert).toContainText('missing SELECT');
  // Which of how many, leading the panel, and the consequence after it rather
  // than four paragraphs before it.
  await expect(alert).toContainText('9 of 10 tables readable \u00b7 1 refused');
  await expect(alert).toContainText('all-or-nothing per space');
  // The statement, ready to paste, naming the person who is short of it.
  await expect(alert).toContainText('GRANT SELECT ON TABLE');
  await expect(alert).toContainText('TO `reviewer@example.example`');
  await expect(alert).toContainText(/metastore admin/);
  // The classification is checkable against the thing it classified.
  await expect(alert.getByText('What Databricks actually returned')).toBeVisible();
  await expect(alert).toContainText('SQLSTATE: 42501');

  // The one thing that must never happen: a refused check quietly becoming a pass.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);

  await page.screenshot({ path: 'test-results/access-gate-denied.png', fullPage: true });
});

/**
 * The refusal named the catalog, so the grant is USE CATALOG. Telling this
 * reader to grant themselves SELECT on a table inside a catalog they cannot
 * enter is a statement that runs, changes nothing they can observe, and sends
 * them back around the loop.
 */
test('a catalog-level refusal asks for USE CATALOG on the catalog, not SELECT on the table', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 0,
    denied: 1,
    errored: 0,
    impact: [],
    verdicts: [
      {
        table: DENIED_TABLE,
        status: 'denied',
        reason: 'no-grant',
        detail: `You do not hold USE CATALOG on catalog <your_catalog>, which ${DENIED_TABLE} is inside.`,
        missing: { object: '<your_catalog>', permission: 'USE CATALOG', objectKind: 'catalog' },
      },
    ],
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('missing USE CATALOG on <your_catalog>');
  // The table is still named, or the reader cannot tell which check this was.
  await expect(alert).toContainText(DENIED_TABLE);
});

/**
 * The failure the warehouse stage exists to prevent. One workspace-object
 * grant, reported once, not as a denial on every table in the report.
 */
test('a warehouse refusal is one grant on one object, with no table verdicts at all', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 0,
    denied: 0,
    errored: 0,
    verdicts: [],
    blocked: {
      kind: 'warehouse-denied',
      summary: `You do not hold CAN_USE on SQL warehouse ${WAREHOUSE}, so no statement could be run as you at all. No table was checked, and none of them should be assumed either way. This is one missing grant on one workspace object, not a verdict on your Unity Catalog access.`,
      layer: 'SQL warehouse permissions',
      missing: { object: WAREHOUSE, permission: 'CAN_USE', objectKind: 'sql-warehouse' },
      remedy: {
        kind: 'cli',
        statement: `databricks permissions update warehouses ${WAREHOUSE} --json '{"access_control_list":[{"user_name":"reviewer@example.example","permission_level":"CAN_USE"}]}'`,
        note: 'SQL warehouses are workspace objects rather than Unity Catalog securables, so this CLI call is the equivalent of a GRANT.',
      },
      apiMessage: `PERMISSION_DENIED: User does not have permission to use warehouse ${WAREHOUSE}. SQLSTATE: 42501`,
    },
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The check stopped before it reached a single table.');
  await expect(alert).toContainText('CAN_USE');
  await expect(alert).toContainText(WAREHOUSE);
  await expect(alert).toContainText('sql-warehouse');
  await expect(alert).toContainText('Look at: SQL warehouse permissions');
  await expect(alert).toContainText('databricks permissions update warehouses');
  // Not one word about a table, because not one table was asked about.
  await expect(alert).not.toContainText(DENIED_TABLE);
  await expect(alert).not.toContainText('missing SELECT');
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.screenshot({ path: 'test-results/access-gate-warehouse.png', fullPage: true });
});

/**
 * The cost of making verification the default: the first thing a reader without
 * the grant now meets is a refusal. A default that dead-ends there is worse
 * than the behaviour it replaced, so the way out has to be named inside the
 * failure and promoted to primary, while still claiming nothing.
 */
test('a failed check promotes the working alternative instead of dead-ending', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 0,
    denied: 0,
    errored: 0,
    verdicts: [],
    blocked: {
      kind: 'warehouse-denied',
      summary: `You do not hold CAN_USE on SQL warehouse ${WAREHOUSE}, so no statement could be run as you at all.`,
      layer: 'SQL warehouse permissions',
      missing: { object: WAREHOUSE, permission: 'CAN_USE', objectKind: 'sql-warehouse' },
      remedy: {
        kind: 'cli',
        statement: `databricks permissions update warehouses ${WAREHOUSE} --json '{"access_control_list":[{"user_name":"reviewer@example.example","permission_level":"CAN_USE"}]}'`,
        note: 'SQL warehouses are workspace objects rather than Unity Catalog securables.',
      },
    },
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  // The grant that would fix it is still named, in the alert, with the command.
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('CAN_USE');
  await expect(alert).toContainText(WAREHOUSE);
  await expect(alert).toContainText('databricks permissions update warehouses');
  // And the way in, in the same breath, without claiming anything was established.
  await expect(alert).toContainText('You can still go in.');
  await expect(alert).toContainText('claims nothing about your own access');

  // One click away, and now the emphasised action, re-running a check that just
  // failed for a missing grant is not what this reader should be pushed towards.
  const fallback = page.getByRole('button', { name: /^Proceed as the service principal/ });
  await expect(fallback).toHaveClass(/access-gate-primary/);
  await expect(page.getByRole('button', { name: /Check my access again/ })).not.toHaveClass(/access-gate-primary/);

  await page.screenshot({ path: 'test-results/access-gate-fallback.png', fullPage: true });
});

/**
 * A token that was refused is not a grant that is missing. Sending this reader
 * to an admin for CAN_USE gets them a permission that changes nothing.
 */
test('a rejected token is not reported as a missing grant', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 0,
    denied: 0,
    errored: 0,
    verdicts: [],
    blocked: {
      kind: 'token-rejected',
      summary:
        'Databricks refused your forwarded token itself (HTTP 401) before it considered any permission, so no statement was run and nothing about your own access was established. This is not a permission you are missing and no grant made to you would change it. The token is expired, revoked, or not valid for this workspace.',
      layer: 'the forwarded user token',
      remedy: {
        kind: 'ui',
        statement: 'Reload this page to pick up a fresh token.',
        note: 'Databricks Apps mints the forwarded token and refreshes it with the session.',
      },
      apiMessage: 'Databricks answered HTTP 401 with no message body.',
    },
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('your token was refused before any permission was read');
  await expect(alert).toContainText('no grant made to you would change it');
  await expect(alert).toContainText('Look at: the forwarded user token');
  await expect(alert).not.toContainText('CAN_USE');
  await expect(alert).not.toContainText('databricks permissions update');
});

/**
 * A warehouse id that resolves to nothing is a configured value, not a
 * permission and not an outage. Reported as either, somebody restarts a
 * healthy warehouse or grants a permission on an object that cannot hold one.
 */
test('a warehouse id that does not resolve is reported as configuration, not as an outage', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 0,
    denied: 0,
    errored: 0,
    verdicts: [],
    blocked: {
      kind: 'warehouse-missing',
      summary: `Databricks has no SQL warehouse \`${WAREHOUSE}\` to answer for (HTTP 404). Either that id does not exist in this workspace, or it is not visible to you at all. The API reports both the same way and this cannot tell them apart. Either way no statement was run, and nothing about your permissions was established.`,
      layer: 'SQL warehouse configuration',
      remedy: {
        kind: 'cli',
        statement: `databricks warehouses get ${WAREHOUSE}`,
        note: 'Run as somebody who administers the workspace. This is not a grant you can be given.',
      },
      apiMessage: 'Databricks answered HTTP 404 with no message body.',
    },
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('the warehouse this asks does not resolve');
  await expect(alert).toContainText('Look at: SQL warehouse configuration');
  await expect(alert).toContainText('databricks warehouses get');
  // Neither of the two wrong readings this replaced.
  await expect(alert).not.toContainText('stopped, starting, or unhealthy');
  await expect(alert).not.toContainText('CAN_USE');
});

/**
 * The state a customer is most likely to hit first, and the one that must never
 * read as a denial. `user_api_scopes` applies when the app STARTS, so an app
 * that was redeployed rather than restarted forwards a token that is real,
 * valid, and unable to run a statement.
 */
test('a token without the sql scope reads as the app missing something, not the user', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 0,
    denied: 0,
    errored: 0,
    verdicts: [],
    blocked: {
      kind: 'no-sql-scope',
      summary:
        'Your token reached Databricks and was refused for lacking the `sql` scope, so no statement was run and nothing about your own permissions was established. This is not a permission you are missing. It is a scope the app is missing, and no grant made to you will change it.',
      layer: 'app configuration',
      remedy: {
        kind: 'cli',
        statement:
          '# 1. `sql` must be in user_api_scopes (resources/player_insights_app.app.yml).\n# 2. A scope is applied when the app STARTS. A redeploy leaves it inert:\ndatabricks apps stop <app-name>\ndatabricks apps start <app-name>',
        note: 'Adding a scope needs a full stop and start, not a redeploy, which is why a deployment that looks completely healthy can still forward a token that cannot run a statement.',
      },
      apiMessage: 'Provided OAuth token does not have required scopes: sql',
    },
    notChecked: LIMITS,
    mode: 'service-principal',
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('the app could not ask on your behalf');
  await expect(alert).toContainText('not a permission you are missing');
  await expect(alert).toContainText('no grant made to you will change it');
  // The distinction that costs an afternoon when it is lost.
  await expect(alert).toContainText('stop and start, not a redeploy');
  await expect(alert).toContainText('databricks apps stop');
  await expect(alert).toContainText('databricks apps start');
  // Nothing here is a grant the reader should go and ask for.
  await expect(alert).not.toContainText('GRANT');
});

test('a missing user token blames the layer that owns it rather than this app', async ({ page }) => {
  await identity(page);
  await verification(page, 409, {
    error: 'no_user_token',
    verified: false,
    blocked: {
      kind: 'no-user-token',
      summary:
        'Databricks Apps did not forward a user token with this request. The app is not acting on the user\u2019s behalf at all. This is a platform-side state, not a failure of any check. Either user authorization is not enabled for this workspace, or the app has not been stopped and started since `user_api_scopes` last changed. A redeploy alone does not apply a scope change.',
      layer: 'app configuration',
      remedy: {
        kind: 'cli',
        statement:
          '# 1. A workspace admin enables user authorization (Public Preview).\n# 2. The app is restarted, because scopes apply at START, not at deploy:\ndatabricks apps stop <app-name>\ndatabricks apps start <app-name>',
        note: 'Both states present identically from here (no token arrives either way), so both steps are listed. Neither is a permission you are missing.',
      },
    },
    notChecked: LIMITS,
    mode: 'service-principal',
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('this is not about your permissions');
  await expect(alert).toContainText('user authorization is not enabled');
  await expect(alert).toContainText('Look at: app configuration');
  // Both indistinguishable causes offered, because guessing between them is
  // what this whole distinction exists to stop.
  await expect(alert).toContainText('A workspace admin enables user authorization');
  await expect(alert).toContainText('databricks apps start');
  // Still at the gate. Not verified, and not silently proceeding either.
  await expect(page.getByRole('dialog')).toBeVisible();
});

/**
 * Both of these fail by answering rather than by erroring, which is the
 * category a reader has no way of noticing for themselves, so a result that
 * left them off would be read as covering them.
 */
test('the result says what it did not check, beside what it did', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 1,
    denied: 1,
    errored: 0,
    impact: [],
    verdicts: [
      {
        table: DENIED_TABLE,
        status: 'denied',
        detail: 'You do not hold SELECT on it.',
        missing: { object: DENIED_TABLE, permission: 'SELECT', objectKind: 'table' },
      },
    ],
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  // One collapsed disclosure now, not an open amber panel. Its summary is what a
  // reader meets; every caveat under it is still there, one click away.
  const limits = page.getByText('What this check does not tell you');
  await expect(limits).toBeVisible();
  const panel = page.locator('.access-gate-result-neutral');
  // Spaces were asked about; what remains uncovered is figure coverage and
  // that this check is not the execution identity.
  await expect(panel).toContainText('answered under your token');
  await expect(panel).toContainText('execution identity');
  await expect(panel).not.toContainText('calls Genie as the serving principal');
  // What was learned as the other identity, and labelled as that, so a green
  // space is not mistaken for a statement about the reader.
  await expect(panel).toContainText('as the agent serving principal');
  await expect(panel).toContainText('not a claim about who executes');
  await expect(panel).toContainText('Data Genie space');
  await expect(panel).toContainText('row filter or a column mask');
  await expect(panel).toContainText('Neither reports itself');
  // The claim that had stopped being true.
  await expect(panel).not.toContainText('requests `sql` only');
});

/**
 * A Genie space the reader cannot open, which the gate used to decline to ask
 * about at all, and to explain with a scope the app had already been granted.
 */
test('a refused Genie space is named on its own, with the CAN RUN grant', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 2,
    denied: 0,
    errored: 0,
    impact: [],
    verdicts: [],
    genie: [
      {
        space: 'space-data',
        label: 'Data Genie space \u00b7 space-data',
        status: 'ok',
        detail: 'Data Genie space \u00b7 space-data resolved under your own token, so you hold at least CAN RUN on it.',
      },
      {
        space: GENIE_SPACE,
        label: `Dictionary Genie space \u00b7 ${GENIE_SPACE}`,
        status: 'denied',
        detail: `You do not hold CAN RUN on Dictionary Genie space \u00b7 ${GENIE_SPACE}. Databricks refused the space itself (HTTP 403), so this is one grant on one workspace object and says nothing about your Unity Catalog access.`,
        missing: { object: GENIE_SPACE, permission: 'CAN_RUN', objectKind: 'genie-space' },
        remedy: {
          kind: 'cli',
          statement: `databricks permissions update genie ${GENIE_SPACE} --json '{"access_control_list":[{"user_name":"reviewer@example.example","permission_level":"CAN_RUN"}]}'`,
          note: 'In the UI: open the space \u2192 Share \u2192 add the person with Can run.',
        },
        apiMessage: 'PERMISSION_DENIED',
      },
    ],
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Genie spaces, asked under your own token.');
  await expect(alert).toContainText(GENIE_SPACE);
  await expect(alert).toContainText('missing CAN_RUN');
  await expect(alert).toContainText('databricks permissions update genie');
  await expect(alert).toContainText('says nothing about your Unity Catalog access');
  // The space that passed is not repeated on a screen about what failed, and
  // no table grant is offered for a workspace object.
  await expect(alert).not.toContainText('GRANT SELECT');
  // Every table was readable and the reader is still not verified, because the
  // spaces are half of what an answer is built from.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);

  await page.screenshot({ path: 'test-results/access-gate-genie.png', fullPage: true });
});

/**
 * And the honest version of the old message, for a deployment where the scope
 * really is absent. It must read as the app being short of something, never as
 * the reader being short of a grant.
 */
test('a token without the Genie scope names the scope and the restart, not a grant', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 1,
    denied: 1,
    errored: 0,
    impact: [],
    verdicts: [
      {
        table: DENIED_TABLE,
        status: 'denied',
        detail: 'You do not hold SELECT on it.',
        missing: { object: DENIED_TABLE, permission: 'SELECT', objectKind: 'table' },
      },
    ],
    genie: [],
    notChecked: LIMITS_WITHOUT_SCOPE,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const panel = page.locator('.access-gate-result-neutral');
  await expect(panel).toContainText('dashboards.genie');
  await expect(panel).toContainText('rather than a permission you are missing');
  await expect(panel).toContainText('STOP and START');
  await expect(panel).toContainText('a redeploy leaves it inert');
  // An empty Genie list is a check that did not happen, so nothing may appear
  // as though the spaces had been asked about and passed.
  await expect(page.getByRole('alert')).not.toContainText('asked under your own token');
});

/**
 * A dependency that did not answer is not a permission verdict, and offering a
 * grant for it would send somebody to fix a permission that is not missing.
 */
test('a warehouse that is down is not reported as a warehouse that refused', async ({ page }) => {
  await identity(page);
  await verification(page, 403, {
    verified: false,
    ok: 0,
    denied: 0,
    errored: 0,
    verdicts: [],
    blocked: {
      kind: 'dependency-down',
      summary: `SQL warehouse ${WAREHOUSE} did not answer \`SELECT 1\`, and did not refuse it for a permission either. It is most likely stopped, starting, or unhealthy. Nothing about your permissions was established; try again once it is running.`,
      layer: 'SQL warehouse availability',
      apiMessage: 'The statement ended in state CANCELED.',
    },
    notChecked: LIMITS,
    servingPrincipal: SERVING,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('something this depends on did not answer');
  await expect(alert).toContainText('Look at: SQL warehouse availability');
  await expect(alert).toContainText('try again once it is running');
  // No object, no privilege, no grant, because none of those is the problem.
  await expect(alert).not.toContainText('CAN_USE');
  await expect(alert).not.toContainText('databricks permissions update');
});

/**
 * A route that failed is not a verdict about the person reading the screen.
 *
 * The client called `response.json()` with no `response.ok` check, so a 5xx
 * body carrying `{error, message}` (which has neither `verified` nor `blocked`
 *), fell through to the denial report. It told the reader "your own access does
 * not cover everything these answers read", above an empty list, when nothing
 * had been checked at all. That is the one sentence this gate exists to avoid
 * saying wrongly: it sends somebody to ask for grants they already hold.
 */
test('a verification route that fell over is not reported as the reader being short of a grant', async ({ page }) => {
  await identity(page);
  await verification(page, 503, {
    error: 'access_verification_failed',
    message: 'The verification route could not complete.',
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Verify my access first/ }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Nothing was checked, because something this depends on did not answer.');
  // The route's own words, so the classification above can be checked.
  await expect(alert).toContainText('The verification route could not complete.');
  // None of the vocabulary of a permission verdict, because none was reached.
  await expect(alert).not.toContainText('Your own access does not cover everything');
  await expect(alert).not.toContainText('GRANT');
  // And still at the gate: a check that did not happen is not a check that passed.
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('does not ask a development session a question with only one answer', async ({ page }) => {
  await identity(page, {
    signedInAs: 'local-development@app.invalid',
    identitySource: 'development-fallback',
  });
  await page.goto('/');
  // Nobody is signed in, so there is no authority to weigh against the service
  // principal and no token that could ever be forwarded.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('a gate that cannot reach the server stands aside instead of locking the door', async ({ page }) => {
  await page.route('**/api/identity', (route) => route.fulfill({ status: 503, json: { error: 'down' } }));
  await page.goto('/');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The app itself is still there.
  await expect(page.locator('#root')).not.toBeEmpty();
});
