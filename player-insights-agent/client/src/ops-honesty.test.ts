/**
 * The rules the Ops tab is not allowed to break, asserted without a browser.
 *
 * Every case here is a way this page could be wrong while looking entirely
 * right, which is the only kind of defect a monitoring surface really has: a
 * page that fails to render gets reported in a minute, and a page that renders a
 * confident wrong number gets acted on.
 *
 * The four properties, and the reason each is worth a test rather than care:
 *
 *  1. A blank is never a zero. Both render as "nothing there" to a glance.
 *  2. Refusals and failures are never summed. The sum is arithmetically valid,
 *     which is exactly why nothing stops somebody producing it.
 *  3. Every figure says how good it is, on itself. A legend elsewhere is
 *     consulted once and then not again.
 *  4. No grant and no rows are different sentences. Empty spend still draws
 *     the resource tiles so a budget can be set; a missing grant still names
 *     the statement that fixes it.
 */
import { describe, expect, it } from 'vitest';

import {
  BASIS_LABEL,
  bars,
  costAbsence,
  costAbsenceReplacesGrid,
  costTilesForDisplay,
  costTileWorkspaceObject,
  count,
  errorFraming,
  healthResourceObject,
  latencyRouteMatchesTrend,
  latencyRouteView,
  latencySharedFacts,
  money,
  P50_BAR_MIN_WIDTH,
  p50BarWidths,
  productForCostTile,
  QUESTION_COST_FORMULA,
  questionServingAverage,
  spendVersusBudget,
  splitMethod,
  telemetryNotice,
  tileView,
  totalBudgetView,
  trafficCaption,
  costHonestyLine,
  costCoverageLinesForTile,
  costCoverageProductForTile,
} from './ops-view';
import { databricksLink } from '../../shared/databricks-links';
import {
  COST_QUALITY_LABEL,
  LATENCY_BASELINE_FLOOR,
  type CostTile,
  type OpsCostPayload,
  type RouteLatency,
  type TrafficBar,
} from '../../shared/ops-contract';
// The server's own list, so a component added there cannot quietly arrive on
// screen unmarked. Precedent: `trace-payload.test.ts` reads server modules for
// the same reason.
import { COST_COMPONENTS } from '../../server/lib/ops-billing';

/**
 * Everything an absence says, which is now a title and one line.
 *
 * THERE IS NO SECOND HALF ANY MORE. This used to join the visible body to a
 * `reasoning` paragraph behind a "Why" disclosure, because where a clause sat
 * was a layout decision that had already moved once. The disclosure itself has
 * gone: a collapsed paragraph is still a paragraph, and it sat between a reader
 * and the statement they came to copy. What survives is what a person acts on,
 * so a test that wants a clause can read the body directly.
 */
function said(notice: { body: string } | null | undefined) {
  return notice?.body ?? '';
}

function tile(overrides: Partial<CostTile> = {}): CostTile {
  return {
    id: 'endpoint',
    label: 'Agent endpoint',
    resourceId: '',
    quality: 'per-token',
    amount: 1.23,
    basis: 'total-in-range',
    population: 'This endpoint',
    unavailable: '',
    remedy: '',
    note: '',
    ...overrides,
  };
}

function costPayload(overrides: Partial<OpsCostPayload> = {}): OpsCostPayload {
  return {
    state: 'ready',
    grant: null,
    reason: '',
    currency: 'USD',
    throughDay: '2026-08-14',
    range: { from: '2026-08-08', to: '2026-08-14' },
    billingLagDays: 0,
    readAt: '2026-08-15T12:00:00Z',
    tiles: [tile()],
    perQuestion: {
      runs: [],
      runsInRange: 0,
      tokenCoveredRuns: 0,
      totalRecordedTokens: 0,
      limited: false,
      reason: '',
    },
    budgets: { total: null, resources: {} },
    budgetsReadable: true,
    ...overrides,
  };
}

/* ── A blank is never a zero ─────────────────────────────────────────────── */

describe('an absent figure', () => {
  it('is never rendered as a zero', () => {
    const view = tileView(tile({ amount: null, unavailable: 'Nothing in billing named this endpoint.' }), 'USD');
    expect(view.figure).toBe('');
    expect(view.absence).toBe('Nothing in billing named this endpoint.');
    expect(view.absence).not.toMatch(/0\.00/);
  });

  it('still says why, even where the server sent no sentence', () => {
    // A tile that arrived without its own explanation must not render blank. A
    // blank space where a figure goes is read as a zero by everybody.
    const view = tileView(tile({ amount: null, unavailable: '' }), 'USD');
    expect(view.absence).not.toBe('');
  });

  it('is distinguished from a component that genuinely cost nothing', () => {
    const nothing = tileView(tile({ amount: 0 }), 'USD');
    expect(nothing.figure).toBe('0.00 USD');
    expect(nothing.absence).toBe('');
  });

  it('does not round a real fraction of a cent away to zero', () => {
    // Several of these components cost thousandths of a cent per run. Rounded
    // to two places they read as free, and a free component is one nobody
    // bothers to turn off.
    expect(money(0.0004, 'USD')).toBe('0.0004 USD');
  });

  it('omits the currency rather than assuming one', () => {
    // A workspace billed in something other than USD must not have a dollar
    // sign put in front of a number that is not dollars.
    expect(money(2, '')).toBe('2.00');
  });

  it('has no figure at all where there is no count', () => {
    expect(count(null)).toBe('');
  });
});

/* ── Every figure says how good it is ────────────────────────────────────── */

describe('the quality of a number', () => {
  it('is on the tile itself, for every quality there is', () => {
    for (const quality of Object.keys(COST_QUALITY_LABEL) as Array<CostTile['quality']>) {
      const view = tileView(tile({ quality }), 'USD');
      expect(view.qualityLabel).toBe(COST_QUALITY_LABEL[quality]);
      expect(view.qualityLabel).not.toBe('');
    }
  });

  it('travels with the tile rather than being decided by the renderer', () => {
    // `tileView` is given no way to disagree with the tile. If this ever takes a
    // quality argument, a call site can pass the wrong one.
    expect(tileView(tile({ quality: 'estimate' }), 'USD').qualityLabel).toBe('Estimate');
  });

  /**
   * THE BADGE GOES ON THE APPORTIONMENTS AND NOWHERE ELSE.
   *
   * The six captions that used to say how each figure was arrived at are gone,
   * and one badge carries the only part of them a reader acts on. Which cards it
   * lands on is now invisible on the page: a badge on the endpoint's per-token
   * figure or on either daily rate would call a measurement an estimate, and
   * that is a claim nobody would catch by looking at a grid of six cards.
   */
  it('badges an apportionment and never a measurement', () => {
    expect(tileView(tile({ quality: 'estimate' }), 'USD').estimate).toBe(true);
    for (const quality of ['real', 'per-token', 'rate'] as const) {
      expect(tileView(tile({ quality }), 'USD').estimate).toBe(false);
    }
    // A card with no figure has nothing for a badge to qualify.
    expect(tileView(tile({ quality: 'estimate', amount: null }), 'USD').estimate).toBe(false);
  });

  /**
   * STILL NAMED, THOUGH IT IS NOW A CHIP RATHER THAN A SENTENCE.
   *
   * The populations were a clause each and the cards were prose around a number,
   * so the sentences went. The FACT could not go with them: two of the seven
   * figures are the whole workspace's spend rather than this deployment's, and a
   * reader who reads either as this app's has misread the block in the most
   * expensive direction available on it. Held against emptiness rather than
   * against a wording, because the wording is a layout decision and this is not.
   */
  it('names the population of every figure', () => {
    const view = tileView(tile(), 'USD');
    expect(view.population).not.toBe('');
  });

  /**
   * AND DRAWS IT ON THE TWO THAT ARE NOT OURS ALONE.
   *
   * The two shared meters are the reason the chip exists. Which cards it lands on
   * is invisible on the page in the same way the estimate badge's is: an
   * unbadged Genie figure reads as this deployment's spend, which is a wrong
   * number and not a missing footnote, and nobody catches that by looking at a
   * grid of six cards. The other four are this endpoint, this app and this job,
   * where a chip would state the reading a reader already has.
   */
  it('badges the scope of a shared meter and leaves our own alone', () => {
    for (const population of ['Whole warehouse', 'Whole workspace']) {
      expect(tileView(tile({ population }), 'USD').sharedScope).toBe(true);
    }
    for (const population of ['This endpoint', 'This app']) {
      expect(tileView(tile({ population }), 'USD').sharedScope).toBe(false);
    }
    // Nothing for a scope to be the scope of.
    expect(tileView(tile({ population: 'Whole workspace', amount: null }), 'USD').sharedScope).toBe(false);
  });

  /**
   * AND FOLLOWS THE RESPONSE RATHER THAN THE CARD.
   *
   * `ops-billing` falls back to the workspace-wide figure for a component it
   * cannot narrow, and relabels that tile 'Whole workspace' on the way out. So a
   * serving-endpoint card can carry somebody else's meter, and a rule keyed on
   * the component rather than on the population it was sent would leave that
   * figure reading as this deployment's own spend.
   */
  it('badges a narrow card the server had to widen', () => {
    const widened = tile({ id: 'serving-endpoint', quality: 'estimate', population: 'Whole workspace' });
    expect(tileView(widened, 'USD').sharedScope).toBe(true);
  });

  it('offers a remedy only where a figure is missing', () => {
    // A figure that arrived needs nothing set, and a remedy beside one reads as
    // an instruction to fix a number that is already right.
    expect(tileView(tile({ remedy: 'Set A_VARIABLE.' }), 'USD').remedy).toBe('');
    const absent = tileView(
      tile({ amount: null, unavailable: 'Resource identifier unavailable', remedy: 'Set A_VARIABLE.' }),
      'USD'
    );
    expect(absent.remedy).toBe('Set A_VARIABLE.');
  });

  it('says whether a figure is a total or a daily rate', () => {
    // The vector search endpoint is billed by the hour whether anything queries
    // it or not. Its daily rate read as a range total understates it by however
    // many days the range covers.
    expect(tileView(tile({ basis: 'per-day' }), 'USD').basisLabel).toBe(BASIS_LABEL['per-day']);
    expect(tileView(tile({ basis: 'total-in-range' }), 'USD').basisLabel).toBe('in range');
    expect(BASIS_LABEL['per-day']).not.toBe(BASIS_LABEL['total-in-range']);
  });
});

/*
 * ── There is no cross-quality headline ───────────────────────────────────────
 *
 * Five tests lived here and every one of them passed: the label said "average",
 * the denominator travelled with the figure, a division by no questions was
 * refused, an unattributable spend said so instead of showing 0.00. They were
 * the honesty rules for a rate, correctly applied to a rate that should never
 * have been computed — most of what it divided is billed by time, so the figure
 * fell as the deployment was used more and read as $57.41 a question at sixteen
 * questions.
 *
 * Kept as a note because the tests were the reason the row survived three
 * earlier passes over this block: green assertions about a number's arithmetic
 * look like assurance about the number. If a per-question figure is ever
 * proposed again, it needs a numerator that is actually per question, not a
 * label and a denominator. The component breakdown now has that numerator for
 * model serving, labels the warehouse allocation as an estimate, and refuses a
 * total while the remaining components have no join.
 */

/* ── No grant and no rows are different states ───────────────────────────── */

describe('an empty cost block', () => {
  it('tells a missing grant apart from a range billing has not filled', () => {
    const noGrant = costAbsence(costPayload({ state: 'no-grant' }));
    const noRows = costAbsence(costPayload({ state: 'no-rows' }));
    expect(noGrant?.title).not.toBe(noRows?.title);
    expect(noGrant?.body).not.toBe(noRows?.body);
  });

  it('does not send somebody to ask for a privilege they already hold', () => {
    const noRows = costAbsence(costPayload({ state: 'no-rows' }));
    // Visible, not collapsed. This is the clause that stops a wasted request to
    // an account admin, so a reader who never opens a disclosure has to see it.
    expect(noRows?.body).toMatch(/not a permission problem/);
    expect(noRows?.body).toMatch(/nothing to grant/);
  });

  it('says what to run when the grant really is missing', () => {
    const noGrant = costAbsence(costPayload({ state: 'no-grant' }));
    // Also visible. The remedy used to sit under three sentences about how the
    // reading works, which is the wrong way round for the one actionable line.
    expect(noGrant?.body).toMatch(/statement below/);
  });

  /**
   * AND SAYS NOTHING ELSE. The paragraph behind the "Why" explained that spend
   * is read as the reader rather than as the app, which is true, which nobody
   * opened, and which changes nothing about what they do next: run the statement
   * or go and ask for it.
   */
  it('offers the remedy without a paragraph behind it', () => {
    const noGrant = costAbsence(costPayload({ state: 'no-grant' }));
    expect(said(noGrant)).not.toMatch(/as you, not as the app/);
    expect(
      said(noGrant)
        .split('.')
        .filter((clause) => clause.trim()).length
    ).toBe(1);
  });

  /**
   * The clause that survives on an unfilled range, because it is the one that
   * stops the wrong action: without it an admin reads the empty block as the
   * missing grant above and goes to ask for a privilege they already hold.
   */
  it('keeps an unfilled range distinguishable from a missing grant', () => {
    const noRows = costAbsence(costPayload({ state: 'no-rows' }));
    expect(said(noRows)).toMatch(/nothing to grant/);
    expect(said(noRows)).not.toMatch(/arrive some hours after the usage/);
  });

  it('never claims spend was zero when the query failed', () => {
    const unreadable = costAbsence(costPayload({ state: 'unreadable', reason: '' }));
    expect(unreadable?.body).toMatch(/not a figure for zero spend/);
  });

  it('keeps saying so even when the server explained the failure', () => {
    // A failed read and a range that genuinely cost nothing render the same
    // empty block, and the server's sentence explains the failure without
    // saying which of the two this is. The clause has to survive having
    // something else to say.
    const explained = costAbsence(costPayload({ state: 'unreadable', reason: 'The warehouse was asleep.' }));
    expect(explained?.body).toContain('The warehouse was asleep.');
    expect(explained?.body).toMatch(/not a figure for zero spend/);
  });

  it('says nothing at all when there are figures to show', () => {
    expect(costAbsence(costPayload())).toBeNull();
  });

  it('does not let empty spend swallow the resource tiles', () => {
    expect(costAbsenceReplacesGrid(costPayload({ state: 'no-rows' }))).toBe(false);
    expect(costAbsenceReplacesGrid(costPayload({ state: 'no-grant' }))).toBe(true);
    expect(costAbsenceReplacesGrid(costPayload({ state: 'unreadable' }))).toBe(true);
  });

  it('still draws one box per tracked resource when billing returned none', () => {
    const tiles = costTilesForDisplay([]);
    expect(tiles.map((tile) => tile.id)).toEqual([
      'serving-endpoint',
      'foundation-model',
      'sql-warehouse',
      'genie',
      'vector-search',
      'app-compute',
    ]);
    expect(tiles.find((tile) => tile.id === 'foundation-model')?.unavailable).toContain(
      'Whole shared endpoint spend is withheld'
    );
    expect(
      tiles.filter((tile) => tile.id !== 'foundation-model').every((tile) => tile.unavailable === 'No billing rows')
    ).toBe(true);
  });
});

describe('a nominal budget against the Cost window', () => {
  it('does not treat missing spend as zero, and does not invent a total spend', () => {
    expect(spendVersusBudget(tile({ amount: null, quality: 'unknown' }), 40, 'USD')).toEqual({
      kind: 'budget-only',
      budgetLabel: '40.00 USD',
    });
    expect(spendVersusBudget(tile({ amount: 12, quality: 'real' }), null, 'USD')).toEqual({ kind: 'none' });
    expect(totalBudgetView(250, 'USD')).toEqual({ kind: 'budget-only', budgetLabel: '250.00 USD' });
    expect(totalBudgetView(null, 'USD')).toEqual({ kind: 'none' });
  });

  it('compares a measured tile to its budget in the same window, and flags only an overage', () => {
    expect(spendVersusBudget(tile({ amount: 12, quality: 'real' }), 40, 'USD')).toEqual({
      kind: 'compared',
      spendLabel: '12.00 USD',
      budgetLabel: '40.00 USD',
      over: false,
    });
    expect(spendVersusBudget(tile({ amount: 50, quality: 'real' }), 40, 'USD')).toMatchObject({
      kind: 'compared',
      over: true,
    });
  });

  it('will not compare an unknown-quality tile even if a number rode along', () => {
    expect(spendVersusBudget(tile({ amount: 9, quality: 'unknown' }), 40, 'USD').kind).toBe('budget-only');
  });

  it('will not call a whole-warehouse or whole-workspace meter an app overage', () => {
    expect(
      spendVersusBudget(tile({ amount: 50, quality: 'estimate', population: 'Whole warehouse' }), 10, 'USD')
    ).toMatchObject({ kind: 'shared-meter' });
    expect(
      spendVersusBudget(tile({ amount: 50, quality: 'estimate', population: 'Whole workspace' }), 10, 'USD')
    ).toMatchObject({ kind: 'shared-meter' });
  });

  it('will not compare unpriced or partial spend as a measured overage', () => {
    expect(
      spendVersusBudget(
        tile({
          amount: 12,
          quality: 'real',
          pricing: {
            source: 'list_prices',
            match: 'unpriced',
            currency: 'USD',
            pricedQuantity: 0,
            unpricedQuantity: 4,
            pricedRows: 0,
            unpricedRows: 1,
            unpricedSkus: ['PREMIUM_SQL'],
            duplicateMatches: 0,
            correctionRows: 0,
            priceEffectiveAt: '',
          },
        }),
        10,
        'USD'
      ).kind
    ).toBe('budget-only');
    expect(
      spendVersusBudget(
        tile({
          amount: 12,
          quality: 'real',
          pricing: {
            source: 'list_prices',
            match: 'partial',
            currency: 'USD',
            pricedQuantity: 4,
            unpricedQuantity: 2,
            pricedRows: 1,
            unpricedRows: 1,
            unpricedSkus: ['NEW_SKU'],
            duplicateMatches: 0,
            correctionRows: 0,
            priceEffectiveAt: '',
          },
        }),
        10,
        'USD'
      ).kind
    ).toBe('budget-only');
  });
});

/* ── Telemetry has four ordinary states ──────────────────────────────────── */

describe('the telemetry notice', () => {
  const input = { variable: 'PLAYER_INSIGHTS_TELEMETRY_SCHEMA', table: 'a_catalog.a_schema.otel_logs', reason: '' };

  it('reports being switched off without configuration or billing narrative', () => {
    const notice = telemetryNotice('not-enabled', input);
    expect(notice?.title).toMatch(/off/);
    expect(notice?.body).toBe('');
  });

  it('tells a missing grant apart from a table with no rows yet', () => {
    const noGrant = telemetryNotice('no-grant', input);
    const noRows = telemetryNotice('no-rows-yet', input);
    expect(noGrant?.title).not.toBe(noRows?.title);
    expect(noGrant?.body).toMatch(/SELECT/);
    // The one clause worth a reader's time, now in the line itself rather than
    // in a paragraph behind a disclosure: an empty table is expected because
    // telemetry does not backfill.
    expect(said(noRows)).toMatch(/does not backfill/);
  });

  /**
   * ONE LINE, NOT THREE. The paragraph said the tables begin filling after the
   * next deploy, so an empty one is expected rather than a sign that nothing was
   * served. "Telemetry does not backfill" is the whole of what a reader does
   * anything with, and it is a clause instead of a paragraph.
   */
  it('explains an empty table in a line rather than a paragraph', () => {
    const noRows = telemetryNotice('no-rows-yet', input);
    expect(said(noRows)).not.toMatch(/rather than a sign that nothing was served/);
    expect(said(noRows).length).toBeLessThan(120);
  });

  it('says nothing once there is something to read', () => {
    expect(telemetryNotice('reading', input)).toBeNull();
  });

  it('tells a read that failed apart from a table with nothing in it', () => {
    // The distinction this page was missing. A query that will not run has said
    // nothing about whether the table is empty, and the block titled it "No
    // telemetry history yet" over a table holding thousands of rows. An operator
    // reading that goes to check whether ingestion is on, which is the one thing
    // that was working.
    const unreadable = telemetryNotice('unreadable', input);
    const noRows = telemetryNotice('no-rows-yet', input);
    expect(unreadable?.title).not.toBe(noRows?.title);
    expect(unreadable?.title).not.toMatch(/history yet/);
    // And it must not be read as a quiet week either.
    expect(unreadable?.body).toMatch(/nothing here was measured/);
    expect(said(unreadable)).not.toMatch(/backfill/);
  });

  it('puts the platform own words first when a read failed', () => {
    // The error Databricks handed back is the most useful thing on the block and
    // the only part that says what to fix.
    const said_ = telemetryNotice('unreadable', {
      ...input,
      reason: 'INVALID_EXTRACT_BASE_FIELD_TYPE: got VARIANT.',
    });
    expect(said_?.body).toMatch(/^INVALID_EXTRACT_BASE_FIELD_TYPE/);
  });

  it('names the table when a failed read came back with no message', () => {
    const bare = telemetryNotice('unreadable', { ...input, reason: '' });
    expect(bare?.body).toContain(input.table);
  });

  it('names the table a grant would be on', () => {
    expect(telemetryNotice('no-grant', input)?.body).toContain(input.table);
  });
});

/* ── Failures and refusals are never summed ──────────────────────────────── */

describe('traffic charts', () => {
  const failures: TrafficBar[] = [{ key: 'f1', label: 'Warehouse refused', count: 2 }];
  const refusals: TrafficBar[] = [{ key: 'r1', label: 'Not permitted', count: 40 }];

  it('scales each chart against its own largest bar', () => {
    // Scaled together, two failures beside forty refusals would draw as a
    // sliver, which reads as "almost nothing" about the number an operator most
    // wants to see.
    expect(bars(failures)[0].percent).toBe(100);
    expect(bars(refusals)[0].percent).toBe(100);
  });

  it('never offers a total of the two', () => {
    const failureCaption = trafficCaption(failures, 'failure', 'failures', 50);
    const refusalCaption = trafficCaption(refusals, 'refusal', 'refusals', 50);
    // Each caption counts its own series against the runs, and neither mentions
    // the other. 42 is the sum nothing here is allowed to produce.
    expect(failureCaption).toContain('2 failures');
    expect(refusalCaption).toContain('40 refusals');
    expect(failureCaption).not.toContain('42');
    expect(refusalCaption).not.toContain('42');
  });

  it('draws no bar at all for an empty series', () => {
    // A bar of length zero is a drawn claim that there is something to draw.
    expect(bars([])).toEqual([]);
    expect(bars([{ key: 'a', label: 'A', count: 0 }])).toEqual([]);
  });

  /**
   * AN EMPTY CHART SAYS SO IN TWO WORDS, and never with a denominator.
   *
   * Failures and refusals are stacked and both are usually empty, so the sentence
   * this returned was drawn twice within a couple of centimetres of itself with
   * one noun different. The run count is in the band above the three charts,
   * once, which is where it belongs and where it does not repeat.
   */
  it('names an empty chart without a sentence or a denominator', () => {
    expect(trafficCaption([], 'failure', 'failures', 50)).toBe('No failures');
    expect(trafficCaption([], 'refusal', 'refusals', 50)).toBe('No refusals');
    // And there is nothing to divide by whether or not anything ran.
    expect(trafficCaption([], 'failure', 'failures', 0)).toBe('No failures');
  });

  it('agrees with itself about singular and plural', () => {
    expect(trafficCaption([{ key: 'a', label: 'A', count: 1 }], 'failure', 'failures', 9)).toContain('1 failure ');
  });
});

/* ── The copy rules ──────────────────────────────────────────────────────── */

describe('the copy', () => {
  it('uses no em dashes anywhere a reader can see', () => {
    const everything = [
      // The one string this module still writes for a card: the state that stands
      // in for a figure nobody could attribute.
      tileView(tile({ amount: null }), 'USD').absence,
      costAbsence(costPayload({ state: 'no-grant' }))?.body ?? '',
      costAbsence(costPayload({ state: 'no-rows' }))?.body ?? '',
      telemetryNotice('not-enabled', { variable: 'V', table: 'T', reason: '' })?.body ?? '',
      telemetryNotice('no-grant', { variable: 'V', table: 'T', reason: '' })?.body ?? '',
      telemetryNotice('no-rows-yet', { variable: 'V', table: 'T', reason: '' })?.body ?? '',
      trafficCaption([], 'failure', 'failures', 3),
    ].join(' ');
    expect(everything).not.toMatch(/\u2014/);
  });
});

/* ── The product marks ───────────────────────────────────────────────────── */

/**
 * EVERY COST COMPONENT IS DECIDED, and the two with no mark are decided too.
 *
 * A component added on the server and forgotten here arrives on screen as a
 * label with a gap where its neighbours have artwork, which reads as a design
 * choice rather than as an omission. Nothing else on the page would say so, and
 * the tile would otherwise be correct, which is the shape of defect that
 * survives.
 */
describe('the mark on a cost tile', () => {
  it('names a product for every billed component', () => {
    const undecided = COST_COMPONENTS.filter((id) => productForCostTile(id) === null);
    expect(undecided).toEqual([]);
  });

  it('marks each Genie space tile as Genie', () => {
    expect(productForCostTile('genie:space-data')).toBe('genie');
  });

  it('answers null for an id it has never seen, rather than guessing', () => {
    expect(productForCostTile('a-component-added-after-this-was-written')).toBeNull();
  });
});

describe('approx average cost per question', () => {
  it('divides measured endpoint spend by token-covered questions', () => {
    expect(QUESTION_COST_FORMULA).toBe('serving endpoint spend ÷ questions with recorded tokens');
    expect(
      questionServingAverage(
        costPayload({
          tiles: [tile({ id: 'serving-endpoint', quality: 'real', amount: 10 })],
          perQuestion: {
            runs: [],
            runsInRange: 2,
            tokenCoveredRuns: 2,
            totalRecordedTokens: 1000,
            limited: false,
            reason: '',
          },
        })
      )
    ).toBe(5);
  });

  it('refuses a workspace-wide serving meter and a zero-token denominator', () => {
    expect(
      questionServingAverage(
        costPayload({
          tiles: [tile({ id: 'serving-endpoint', quality: 'real', amount: 10, population: 'Whole workspace' })],
          perQuestion: {
            runs: [],
            runsInRange: 2,
            tokenCoveredRuns: 2,
            totalRecordedTokens: 1000,
            limited: false,
            reason: '',
          },
        })
      )
    ).toBeNull();
    expect(
      questionServingAverage(
        costPayload({
          tiles: [tile({ id: 'serving-endpoint', quality: 'real', amount: 10 })],
          perQuestion: {
            runs: [],
            runsInRange: 2,
            tokenCoveredRuns: 0,
            totalRecordedTokens: 0,
            limited: false,
            reason: '',
          },
        })
      )
    ).toBeNull();
  });
});

describe('cost honesty and coverage copy', () => {
  it('says list prices, not contracted rates, and names when the range may still fill', () => {
    expect(costHonestyLine(null)).toContain('not contracted rates');
    expect(
      costHonestyLine({
        priceSource: 'list_prices',
        contractRates: 'unavailable',
        dataThrough: '2026-08-14',
        rangeMayStillFill: true,
        currencyConsistent: true,
      })
    ).toContain('later days in this range may still be filling');
  });

  it('maps coverage by product contract, never by prose or a nearby tile', () => {
    const coverage = {
      inventoryCount: 11,
      costModelCount: 5,
      products: [
        {
          product: 'APPS',
          taggedRows: 4,
          taggedQuantity: 4,
          pricedRows: 4,
          unpricedRows: 0,
          tiled: true,
          reason: 'Matched by app name.',
        },
      ],
      propagation: [{ product: 'APPS', status: 'unsupported' as const, detail: 'App tags are organizational.' }],
    };
    expect(costCoverageProductForTile('serving-endpoint')).toBe('MODEL_SERVING');
    expect(costCoverageProductForTile('genie:space-1')).toBe('GENIE');
    expect(costCoverageProductForTile('app-compute')).toBe('APPS');
    expect(costCoverageProductForTile('unknown')).toBeNull();
    expect(costCoverageLinesForTile('app-compute', coverage)).toEqual([
      'Matched by app name.',
      'App tags are organizational.',
    ]);
    expect(costCoverageLinesForTile('sql-warehouse', coverage)).toEqual([]);
  });
});

/**
 * A tile or Health row is a Databricks link only when this app already knows
 * the object and a verified workspace path. A guessed URL is worse than none.
 */
describe('which Ops resources open in Databricks', () => {
  it('opens the cost tiles that name a workspace object', () => {
    expect(costTileWorkspaceObject({ id: 'serving-endpoint', resourceId: 'an-endpoint' })).toEqual({
      kind: 'serving-endpoint',
      name: 'an-endpoint',
    });
    expect(costTileWorkspaceObject({ id: 'sql-warehouse', resourceId: 'wh-1' })).toEqual({
      kind: 'sql-warehouse',
      warehouseId: 'wh-1',
    });
    expect(costTileWorkspaceObject({ id: 'app-compute', resourceId: 'astrolabe' })).toEqual({
      kind: 'app',
      name: 'astrolabe',
    });
  });

  it('opens a Genie space and a Vector Search index when those ids are real', () => {
    expect(costTileWorkspaceObject({ id: 'genie:01ab', resourceId: '01ab', resourceKind: 'genie-space' })).toEqual({
      kind: 'genie-space',
      spaceId: '01ab',
    });
    expect(costTileWorkspaceObject({ id: 'vector-search', resourceId: 'a.b.c', resourceKind: 'vector-index' })).toEqual(
      {
        kind: 'vector-index',
        index: 'a.b.c',
      }
    );
  });

  it('does not turn a workspace id or a Vector Search endpoint name into a link', () => {
    expect(costTileWorkspaceObject({ id: 'genie', resourceId: '' })).toBeNull();
    expect(costTileWorkspaceObject({ id: 'genie', resourceId: 'a-workspace' })).toBeNull();
    expect(costTileWorkspaceObject({ id: 'vector-search', resourceId: 'vs-endpoint' })).toBeNull();
  });

  it('builds Databricks URLs for a Genie space and a Vector Search index', () => {
    const host = 'https://example-workspace.invalid';
    expect(
      databricksLink(
        host,
        costTileWorkspaceObject({ id: 'genie:01ab', resourceId: '01ab', resourceKind: 'genie-space' })!
      )
    ).toBe(`${host}/genie/rooms/01ab`);
    expect(
      databricksLink(
        host,
        costTileWorkspaceObject({ id: 'vector-search', resourceId: 'a.b.c', resourceKind: 'vector-index' })!
      )
    ).toBe(`${host}/explore/data/a/b/c`);
  });

  it('opens Health identifiers the Architecture page already knows how to open', () => {
    expect(healthResourceObject({ kind: 'sql-warehouse', name: 'wh-1' })).toEqual({
      kind: 'sql-warehouse',
      warehouseId: 'wh-1',
    });
    expect(healthResourceObject({ kind: 'genie-space', name: '01ab' })).toEqual({
      kind: 'genie-space',
      spaceId: '01ab',
    });
    expect(healthResourceObject({ kind: 'serving-endpoint', name: 'an-endpoint' })).toEqual({
      kind: 'serving-endpoint',
      name: 'an-endpoint',
    });
    expect(healthResourceObject({ kind: 'catalog', name: 'a_catalog' })).toEqual({
      kind: 'catalog',
      catalog: 'a_catalog',
    });
    expect(healthResourceObject({ kind: 'vector-index', name: 'a.b.c' })).toEqual({
      kind: 'vector-index',
      index: 'a.b.c',
    });
  });

  it('does not invent a Lakebase or Vector Search endpoint URL', () => {
    expect(healthResourceObject({ kind: 'lakebase', name: 'a-branch' })).toBeNull();
    expect(healthResourceObject({ kind: 'vector-endpoint', name: 'vs-endpoint' })).toBeNull();
    expect(healthResourceObject({ kind: 'sql-warehouse', name: '' })).toBeNull();
  });
});

/* ── Recorded errors vs a live failure ───────────────────────────────────── */

describe('the framing over recorded error lines', () => {
  it('says nothing at zero, because zero is not a count', () => {
    expect(errorFraming({ errorCount: 0, dependencies: ['answered'] })).toBeNull();
  });

  it('hides historical errors when no dependency is failing now', () => {
    expect(errorFraming({ errorCount: 2, dependencies: ['answered', 'answered', 'not-checked'] })).toBeNull();
  });

  it('does not reassure when a dependency is not answering now', () => {
    const framing = errorFraming({ errorCount: 1, dependencies: ['answered', 'did-not-answer'] });
    expect(framing?.live).toBe(true);
    expect(framing?.headline).toBe('1 error line recorded');
    expect(framing?.note).not.toMatch(/not a live failure/);
    expect(framing?.note).toMatch(/Result column/);
  });

  it('does not use historical errors to fill an unchecked state', () => {
    // A probe that did not run has said nothing about the dependency, so it must
    // not tip the note into the live-failure wording.
    expect(errorFraming({ errorCount: 1, dependencies: ['not-checked'] })).toBeNull();
  });
});

/* ── The log-scaled p50 bar ──────────────────────────────────────────────── */

describe('the p50 bar scale', () => {
  /**
   * THE SCALE HAS TO MAKE 65ms AND 83.5s BOTH LEGIBLE. On a linear scale the
   * fast route is 0.08% of the track beside the slow one — invisible, which
   * reads as unmeasured rather than fast. Log scaling puts it back on the chart.
   */
  it('keeps the fastest route visible beside the slowest', () => {
    const [slow, fast] = p50BarWidths([83_500, 65]);
    expect(slow).toBe(100);
    expect(fast).toBe(P50_BAR_MIN_WIDTH);
    // The floor is the whole point: a linear scale would give the fast bar
    // 65 / 83500 = 0.08%, which rounds to nothing.
    expect(fast).toBeGreaterThan(Math.round((65 / 83_500) * 100));
  });

  it('orders the bars by duration and spaces them by ratio, not by difference', () => {
    // Four routes across five orders of magnitude, the panel's real shape.
    const widths = p50BarWidths([85_500, 8_709.2, 169.9, 0.7]);
    // Monotone with the durations: slowest widest, fastest narrowest.
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
    expect(widths[2]).toBeGreaterThan(widths[3]);
    expect(widths[0]).toBe(100);
    expect(widths[3]).toBe(P50_BAR_MIN_WIDTH);
    // Log spacing: 8.7s is roughly one order below 85.5s and about four-fifths
    // of the way up the track, not the ~10% a linear scale would give it.
    expect(widths[1]).toBeGreaterThan(60);
  });

  it('draws no bar for a zero or an absent duration', () => {
    // A drawn bar is a claim there is a duration; zero and absent are neither.
    expect(p50BarWidths([0, 100, 200])[0]).toBe(0);
    expect(p50BarWidths([-1])[0]).toBe(0);
  });

  it('gives every equal route the full bar rather than dividing by zero', () => {
    expect(p50BarWidths([50, 50, 50])).toEqual([100, 100, 100]);
  });
});

/* ── The method chip split ───────────────────────────────────────────────── */

describe('splitting a span name into method and path', () => {
  it('splits a normal route', () => {
    expect(splitMethod('POST /api/insights/ask')).toEqual({ method: 'POST', path: '/api/insights/ask' });
  });

  it('keeps the whole string as the path when there is no method', () => {
    // A background span with no leading verb must not be given an invented GET.
    expect(splitMethod('background refresh')).toEqual({ method: '', path: 'background refresh' });
  });
});

/* ── The shared-facts strip ──────────────────────────────────────────────── */

describe('the latency shared-facts line', () => {
  const thin = (over: Partial<RouteLatency> = {}): RouteLatency =>
    route({ spans: 8, p95Ms: null, p99Ms: null, ...over });

  it('says the whole window is thin when no route crosses the floor', () => {
    const facts = latencySharedFacts([thin(), thin({ route: 'GET /api/ops/cost' })]);
    expect(facts.showPercentiles).toBe(false);
    expect(facts.line).toBe('Every route is under 20 recorded requests: no p95, p99, or trend yet.');
    expect(facts.line).not.toContain('error responses recorded');
    expect(facts.line).not.toContain('Refusals are not reported');
  });

  it('brings the columns back and drops the claim once a route crosses the floor', () => {
    const facts = latencySharedFacts([thin(), route({ spans: 40, p95Ms: 200, p99Ms: 250 })]);
    expect(facts.showPercentiles).toBe(true);
    expect(facts.line).toBe('');
  });

  it('does not narrate errors or refusals on the shared-facts line', () => {
    const facts = latencySharedFacts([thin({ errorCount: 3 })]);
    expect(facts.line).not.toContain('error responses recorded');
    expect(facts.line).not.toContain('Refusals are not reported');
  });

  it('says nothing at all when there are no routes', () => {
    expect(latencySharedFacts([]).line).toBe('');
  });
});

/* ── Latency baseline honesty ────────────────────────────────────────────── */

function route(overrides: Partial<RouteLatency> = {}): RouteLatency {
  return {
    route: 'GET /api/example',
    spans: LATENCY_BASELINE_FLOOR,
    p50Ms: 100,
    p95Ms: 200,
    p99Ms: 250,
    slowestMs: 300,
    errorCount: 0,
    refusalCount: null,
    lastSpanAt: '2026-08-17 16:40:00',
    priorSpans: LATENCY_BASELINE_FLOOR,
    priorP50Ms: 100,
    ...overrides,
  };
}

describe('a latency verdict against a route baseline', () => {
  it('refuses to flag a thin sample', () => {
    const view = latencyRouteView(route({ spans: 3, priorSpans: 40, priorP50Ms: 50, p50Ms: 500 }));
    expect(view.verdict).toBe('too-thin');
    expect(view.verdictLabel).toMatch(/Too thin/);
  });

  it('refuses a verdict when there is no prior period', () => {
    const view = latencyRouteView(route({ priorSpans: 0, priorP50Ms: null, spans: 40, p50Ms: 500 }));
    expect(view.verdict).toBe('too-thin');
    expect(view.verdict).not.toBe('slower');
  });

  it('flags only when both halves clear the floor and the median rose enough', () => {
    expect(latencyRouteView(route({ p50Ms: 160, priorP50Ms: 100 })).verdict).toBe('slower');
    expect(latencyRouteView(route({ p50Ms: 140, priorP50Ms: 100 })).verdict).toBe('within');
  });

  it('keeps errors and refusals separate, and names the error population', () => {
    const view = latencyRouteView(route({ errorCount: 3, spans: 26, refusalCount: null }));
    expect(view.errorsLabel).toBe('3 of 26 spans');
    expect(view.refusalsLabel).toBe('Not reported');
    expect(view.errorsLabel).not.toContain('refus');
  });

  it('never invents a refusal count to fill the column', () => {
    expect(latencyRouteView(route()).refusalsLabel).toBe('Not reported');
  });
});

describe('the latency TREND filters', () => {
  const off = { within: false, outside: false };
  const green = { within: true, outside: false };
  const red = { within: false, outside: true };
  const both = { within: true, outside: true };

  it('shows every row, including a dash, when neither pill is on', () => {
    expect(latencyRouteMatchesTrend('within', off)).toBe(true);
    expect(latencyRouteMatchesTrend('slower', off)).toBe(true);
    expect(latencyRouteMatchesTrend('too-thin', off)).toBe(true);
    expect(latencyRouteMatchesTrend('not-reported', off)).toBe(true);
  });

  it('shows only the matching verdict when one pill is on', () => {
    expect(latencyRouteMatchesTrend('within', green)).toBe(true);
    expect(latencyRouteMatchesTrend('slower', green)).toBe(false);
    expect(latencyRouteMatchesTrend('too-thin', green)).toBe(false);

    expect(latencyRouteMatchesTrend('slower', red)).toBe(true);
    expect(latencyRouteMatchesTrend('within', red)).toBe(false);
    expect(latencyRouteMatchesTrend('not-reported', red)).toBe(false);
  });

  it('drops the dashes when both pills are on, and keeps every row that has a trend', () => {
    expect(latencyRouteMatchesTrend('within', both)).toBe(true);
    expect(latencyRouteMatchesTrend('slower', both)).toBe(true);
    expect(latencyRouteMatchesTrend('too-thin', both)).toBe(false);
    expect(latencyRouteMatchesTrend('not-reported', both)).toBe(false);
  });
});
