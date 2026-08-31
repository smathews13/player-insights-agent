/**
 * What a reader actually sees on Ops, asserted against rendered markup.
 *
 * Rendered rather than inspected, in the pattern `connections-render.test.tsx`
 * established and `monitoring-render.test.tsx` follows: this repository has been
 * bitten by screens that were wrong while every assertion about their source was
 * true. The three bodies take a state rather than fetching into one, so every
 * state can be driven here without a browser, which is just as well because this
 * repository is not allowed to run one.
 *
 * THE PROPERTY MOST OF THIS FILE IS ABOUT is that the three blocks are
 * independent. It is the design's central claim and the one that is quietly lost
 * first, because a refactor that merges three fetches into one looks like a
 * tidy-up and reads like an improvement. Health is a live probe, cost is a
 * workspace-wide billing query and traffic is a query against the app's own
 * store; behind one route, the slowest and least readable of the three decides
 * when the other two appear.
 *
 * PIXELS ARE NOT VERIFIED BY ANY OF THIS. These tests read the words a person
 * would read. Nothing here says the layout is right.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import {
  CostBody,
  CostTileTitle,
  HealthBody,
  LatencyBody,
  OpsPage,
  StopAllActiveRuns,
  TrafficBody,
  type Block,
} from './OpsPage';
import { activeMinutesDisplay, queryHistoryCoverageDetail } from './ops-view';
import { REFRESH_LABEL } from './refresh-state';
import type { OpsCostPayload, OpsHealthPayload, OpsLatencyPayload, OpsTrafficPayload } from '../../shared/ops-contract';

const OPS_STYLES = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');
const OPS_SOURCE = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(node: React.ReactElement): string {
  return text(renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>));
}

/** The markup itself, for the claims that are about a class or an href. */
function markupOf(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function block<T>(data: T | null, overrides: Partial<Block<T>> = {}): Block<T> {
  return { data, busy: false, failed: '', refresh: () => {}, ...overrides };
}

it('keeps Health rows at the Connected-resources size', () => {
  expect(OPS_STYLES).toMatch(/\.ops-health-table\s*\{[^}]*font-size:\s*var\(--text-base\)/);
  expect(OPS_STYLES).toMatch(
    /\.ops-health-table th,\s*\n\.ops-health-table td\s*\{[^}]*padding:\s*10px 16px[^}]*line-height:\s*1\.4/
  );
});

describe('the admin cancellation control', () => {
  it('labels the compact admin-only control and says only what it preserves', () => {
    const visible = render(<StopAllActiveRuns />);
    expect(visible).toContain('ADMIN');
    expect(visible).toContain('Stop all active runs');
    expect(visible).toContain('No data or history is deleted.');
    expect(visible).not.toContain('One-time snapshot only');
    expect(visible).not.toContain('Future Asks continue');
    const markup = markupOf(<StopAllActiveRuns />);
    expect(markup).toContain('ops-stop-all-button');
    expect(markup).toContain('data-variant="destructive"');
    expect(OPS_STYLES).toMatch(/\.ops-stop-all strong\s*\{[^}]*color:\s*var\(--db-red-700\)[^}]*font-weight:\s*800/);
  });

  it('is gated by the resolved admin role on Ops', () => {
    const source = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('showsAdminSurfaces(role.state) ? <StopAllActiveRuns /> : null');
    expect(source).toContain("fetch('/api/admin/runs/cancel-all'");
  });
});

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function health(overrides: Partial<OpsHealthPayload> = {}): OpsHealthPayload {
  return {
    checkedAt: '2026-08-15T12:00:00Z',
    dependencies: [
      {
        id: 'warehouse',
        kind: 'sql-warehouse',
        connectionsId: 'warehouse',
        label: 'SQL warehouse',
        name: 'a-warehouse-id',
        result: 'answered',
        lastCheckedAt: '2026-08-15T12:00:00Z',
        reason: '',
      },
      {
        id: 'genie',
        kind: 'genie-space',
        connectionsId: 'genie',
        label: 'Genie space',
        name: 'a-space-id',
        result: 'did-not-answer',
        lastCheckedAt: '2026-08-15T12:00:00Z',
        reason: 'The space returned 403 for this user.',
      },
      {
        // Empty on purpose: the index is the case the contract calls out, where a
        // probe has no Connections row to land on, so no link should be drawn.
        id: 'index',
        kind: 'vector-index',
        connectionsId: '',
        label: 'Vector search index',
        name: 'an-index',
        result: 'not-checked',
        lastCheckedAt: '',
        reason: '',
      },
      {
        // The row the endpoint reading is taken from, so the pairing the block
        // now turns on is exercised rather than assumed.
        id: 'agent-endpoint',
        kind: 'serving-endpoint',
        connectionsId: 'agent',
        label: 'Orchestrator serving endpoint \u00b7 a-model',
        name: 'a-model',
        result: 'answered',
        lastCheckedAt: '2026-08-15T12:00:00Z',
        reason: '',
      },
    ],
    platform: [
      { id: 'endpoint', label: 'Serving endpoint', state: 'Ready', read: true, rows: ['agent-endpoint'], reason: '' },
      { id: 'app', label: 'App', state: 'Running', read: true, rows: [], reason: '' },
      { id: 'lakebase', label: 'Lakebase', state: 'Connected', read: true, rows: [], reason: '' },
    ],
    app: {
      telemetry: 'not-enabled',
      variable: 'PLAYER_INSIGHTS_TELEMETRY_SCHEMA',
      table: '',
      grant: null,
      insightsHref: 'https://example.test/apps/pia/insights',
      requestsPerHour: [],
      lastServedAt: '',
      recordingSince: '',
      signInsPerDay: [],
      errors: { count: 0, recent: [] },
      reason: '',
    },
    reason: '',
    ...overrides,
  };
}

function cost(overrides: Partial<OpsCostPayload> = {}): OpsCostPayload {
  return {
    state: 'ready',
    grant: null,
    reason: '',
    currency: 'USD',
    throughDay: '2026-08-14',
    range: { from: '2026-08-08', to: '2026-08-14' },
    billingLagDays: 0,
    readAt: '2026-08-15T12:00:00Z',
    tiles: [
      {
        id: 'endpoint',
        label: 'Agent endpoint',
        resourceId: '',
        quality: 'per-token',
        amount: 1.5,
        basis: 'total-in-range',
        population: 'This endpoint',
        unavailable: '',
        remedy: '',
        note: '',
      },
      {
        id: 'index-endpoint',
        label: 'Vector search endpoint',
        resourceId: '',
        quality: 'rate',
        amount: 4,
        basis: 'per-day',
        population: 'Whole workspace',
        unavailable: '',
        remedy: '',
        note: '',
      },
    ],
    perQuestion: {
      runs: [],
      runsInRange: 0,
      tokenCoveredRuns: 0,
      totalRecordedTokens: 0,
      limited: false,
      reason: 'No completed runs were recorded.',
    },
    budgets: { total: { value: null, unit: 'USD' }, resources: {} },
    budgetsReadable: true,
    ...overrides,
  };
}

function traffic(overrides: Partial<OpsTrafficPayload> = {}): OpsTrafficPayload {
  return {
    readAt: '2026-08-15T12:00:00Z',
    reason: '',
    unread: '',
    questionsPerDay: [{ day: '2026-08-14', count: 12 }],
    distinctAskersPerDay: [{ day: '2026-08-14', count: 4 }],
    activeMinutesPerDay: [{ day: '2026-08-14', count: 80 }],
    failuresByCause: [{ key: 'WAREHOUSE_UNAVAILABLE', label: 'Warehouse unavailable', count: 2 }],
    refusalsByCause: [{ key: 'NOT_PERMITTED', label: 'Not permitted', count: 40 }],
    toolCalls: [{ key: 'genie', label: 'Genie', count: 30 }],
    runsInRange: 50,
    ...overrides,
  };
}

/* ── The three blocks are independent ────────────────────────────────────── */

describe('one block failing', () => {
  it('does not stop the other two rendering', () => {
    // The design's central claim, and the one a refactor loses first.
    const broken = render(<CostBody block={block<OpsCostPayload>(null, { failed: 'The server answered 500.' })} />);
    const stillFine = render(<HealthBody block={block(health())} />);
    const alsoFine = render(<TrafficBody block={block(traffic())} />);

    expect(broken).toContain('Cost could not be read');
    expect(stillFine).toContain('SQL warehouse');
    expect(alsoFine).toContain('Questions per day');
  });

  it('says which block it was, so the page does not read as broken', () => {
    expect(render(<CostBody block={block<OpsCostPayload>(null, { failed: 'x' })} />)).toContain(
      'Cost could not be read'
    );
    expect(render(<HealthBody block={block<OpsHealthPayload>(null, { failed: 'x' })} />)).toContain(
      'Health could not be read'
    );
    expect(render(<TrafficBody block={block<OpsTrafficPayload>(null, { failed: 'x' })} />)).toContain(
      'Traffic could not be read'
    );
  });

  /**
   * The reassurance line under a failed block is gone: which block failed is the
   * first line of the panel, and the other two blocks are visibly populated
   * beside it. What has to survive is the block's own name and the exact reason.
   */
  it('carries the exact reason and nothing else', () => {
    const broken = render(
      <TrafficBody block={block<OpsTrafficPayload>(null, { failed: 'the warehouse refused: 403' })} />
    );
    expect(broken).toContain('the warehouse refused: 403');
    expect(broken).not.toMatch(/read separately and are not affected/);
  });

  it('offers a retry for that block alone', () => {
    // The shared control, not a fifth spelling of it. It said "Try this block
    // again"; which block is the first line of the panel, so the label was not
    // carrying that, and the app had already collapsed four of these into one
    // component. Asserted by class as well as word: the word alone would pass
    // against a hand-rolled button that happened to say Refresh.
    const failed = <CostBody block={block<OpsCostPayload>(null, { failed: 'x' })} />;
    expect(render(failed)).toContain(REFRESH_LABEL);
    // On the raw markup, because `render` strips the tags the class lives in.
    expect(renderToStaticMarkup(<MemoryRouter>{failed}</MemoryRouter>)).toContain('refresh-button');
  });

  it('carries its own read time rather than the page having one', () => {
    // Three reads at three moments. A single timestamp would be a claim about
    // all three that is true of at most one.
    const one = render(<CostBody block={block(cost({ readAt: '2026-08-15T12:00:00Z' }))} />);
    const other = render(<TrafficBody block={block(traffic({ readAt: '2026-08-15T09:00:00Z' }))} />);
    expect(one).toMatch(/Read /);
    expect(other).toMatch(/Read /);
  });
});

/* ── Health ──────────────────────────────────────────────────────────────── */

describe('the health block', () => {
  it('gives every dependency a result in words, not only a colour', () => {
    const markup = render(<HealthBody block={block(health())} />);
    expect(markup).toContain('Reachable');
    expect(markup).toContain('Not answering');
    expect(markup).toContain('Not checked');
  });

  /**
   * THE WORDS ARE A CHECK'S, NOT A CONVERSATION'S. "Answered" was the result for
   * every healthy row, on a table of resources, beside pills reading "Ready" and
   * "Running" — and one column over from a Notes cell quoting the platform. It
   * read as something a person had asked the warehouse.
   */
  it('states a resource check without borrowing the question-and-answer words', () => {
    const markup = render(<HealthBody block={block(health())} />);
    expect(markup).not.toContain('Answered');
    expect(markup).not.toContain('Did not answer');
  });

  /**
   * ONE BADGE PER RESOURCE, IN THAT RESOURCE'S ROW. The platform's readings used
   * to sit in the block's band as a cluster of their own, above a table that
   * reported the same serving endpoint in its own Result column and in different
   * words. A reader had two places to look for one question and two vocabularies
   * to reconcile.
   */
  it('states each resource once, in the Result column rather than in the band', () => {
    const markup = markupOf(<HealthBody block={block(health())} />);

    // The readings, in the Result cells of the rows they are about.
    expect(markup).toMatch(
      /ops-col-result[^]*?ops-platform-pill-label">Serving endpoint<\/span><span class="ops-platform-pill-state">Ready</
    );
    expect(markup).toMatch(
      /ops-col-result[^]*?ops-platform-pill-label">App<\/span><span class="ops-platform-pill-state">Running</
    );
    expect(markup).toMatch(
      /ops-col-result[^]*?ops-platform-pill-label">Lakebase<\/span><span class="ops-platform-pill-state">Connected</
    );

    // And nowhere else. The band's own pill cluster is gone, so each of these
    // words appears exactly as many times as there are rows carrying it.
    expect(markup).not.toContain('class="ops-platform"');
    expect([...markup.matchAll(/>Running</g)]).toHaveLength(1);
    expect([...markup.matchAll(/>Connected</g)]).toHaveLength(1);
    expect([...markup.matchAll(/>Ready</g)]).toHaveLength(1);
  });

  /**
   * A reading is drawn on the row the SERVER said it was taken from. The endpoint
   * reading is taken from the answer-path endpoints only, so a client matching on
   * kind would hand its verdict to a judge endpoint it never looked at.
   */
  it('puts a platform reading only on the rows it was taken from', () => {
    const base = health();
    const markup = markupOf(
      <HealthBody
        block={block(
          health({
            dependencies: [
              ...base.dependencies,
              {
                id: 'judge-endpoint',
                kind: 'serving-endpoint',
                connectionsId: '',
                label: 'Benchmark judge model \u00b7 a-judge',
                name: 'a-judge',
                result: 'answered',
                lastCheckedAt: '2026-08-15T12:00:00Z',
                reason: '',
              },
            ],
          })
        )}
      />
    );

    // One "Ready", on the answer-path row. The judge states what its own probe
    // established instead of borrowing the answer path's verdict.
    expect([...markup.matchAll(/>Ready</g)]).toHaveLength(1);
    expect(markup).toMatch(
      /ops-platform-pill-label">Serving endpoint<\/span><span class="ops-platform-pill-state">Reachable</
    );
  });

  /**
   * The app and the store are resources a reader acts on, and neither is one of
   * the dependency probes: the app is running because this handler answered, and
   * Lakebase is a read of the app's own schema. Dropping their readings when the
   * band's pill cluster went would have taken two rows off the list.
   */
  it('gives the app and Lakebase a row of their own, since no probe covers them', () => {
    const markup = render(<HealthBody block={block(health())} />);
    expect(markup).toContain('App Running');
    expect(markup).toContain('Lakebase Connected');
  });

  /**
   * The probes failing says nothing about the readings that are not probes: the
   * app answered this very request, and the store was read on the same pass.
   */
  it('keeps the rows it did establish when the dependency probes could not run', () => {
    const markup = render(
      <HealthBody
        block={block(
          health({ dependencies: [], reason: 'The dependency probes could not be run, so nothing was checked: boom' })
        )}
      />
    );
    expect(markup).toContain('The dependency checks did not run');
    expect(markup).toContain('App Running');
    expect(markup).toContain('Lakebase Connected');
  });

  it("carries the store's own words when it is not answering", () => {
    const markup = render(
      <HealthBody
        block={block(
          health({
            platform: [
              {
                id: 'lakebase',
                label: 'Lakebase',
                state: 'Not answering',
                read: true,
                rows: [],
                reason: 'permission denied for schema player_insights',
              },
            ],
          })
        )}
      />
    );
    // Not answering, and the reason a reader has to have in order to know whether
    // to look at the pool or at a grant.
    expect(markup).toContain('Lakebase Not answering');
    expect(markup).toContain('Conversation state store');
  });

  it('renders a check that did not run as its own state rather than as a failure', () => {
    const markup = render(<HealthBody block={block(health())} />);
    // The vector index row was never checked. It must not be reported as a
    // fault, which would send somebody to investigate a service that is fine.
    expect(markup).toContain('Not checked');
    expect(markup).not.toContain('Vector search index Did not answer');
  });

  it("shows the probe's own reason rather than a rewritten one", () => {
    expect(render(<HealthBody block={block(health())} />)).toContain('Natural-language data space');
  });

  /**
   * The distinction that matters is that a platform reading is the platform's word
   * and a probe result is this app's. It is now carried by the pill NAMING its own
   * subject and by the link out to the platform record, rather than by two pills
   * living in a different part of the block. Never by sentences explaining either:
   * two of those said the same thing on every check and the third was on screen
   * explaining a bug.
   */
  it('says whose word each result is, in the pill rather than by its position', () => {
    const markup = render(<HealthBody block={block(health())} />);
    // The platform's readings, as states rather than prose.
    expect(markup).toContain('Serving endpoint Ready');
    expect(markup).toContain('App Running');
    // The app's own probes, with their three states intact and each naming the
    // resource it is about.
    expect(markup).toContain('SQL warehouse Reachable');
    expect(markup).toContain('Genie space Not answering');
    expect(markup).toContain('Vector Search index Not checked');
  });

  it('states a platform reading without explaining how it was taken', () => {
    const markup = render(<HealthBody block={block(health())} />);
    expect(markup).not.toMatch(/measured by Databricks/);
    expect(markup).not.toMatch(/was not read on this check/);
    expect(markup).not.toMatch(/Why the app cannot measure this/);
    expect(markup).not.toMatch(/so the container is up/);
  });

  it('counts error lines without editorialising the count', () => {
    const markup = render(
      <HealthBody
        block={block(health({ app: { ...health().app, telemetry: 'reading', errors: { count: 3, recent: [] } } }))}
      />
    );
    expect(markup).toContain('3 error lines recorded');
    expect(markup).not.toMatch(/out of everything the app logged/);
    // The live timestamp stays. It is the only thing on the block that says
    // whether anything has reached this deployment recently.
    expect(markup).toContain('Most recent request');
  });

  /**
   * HISTORY IS NOT A LIVE FAILURE, and the block now says which one it is.
   *
   * The seed for this was two "cache fell back to in-memory" lines from two days
   * before, over a deployment whose dependencies were all answering. Read bare,
   * a count of error lines beside a green health table reads as a current
   * Connection failure. When every dependency answered its last check, the note
   * says these are recorded log lines, not a live failure.
   */
  it('hides recorded errors when every dependency answered', () => {
    const base = health();
    const markup = render(
      <HealthBody
        block={block(
          health({
            dependencies: base.dependencies.map((row) => ({ ...row, result: 'answered', reason: '' })),
            app: {
              ...base.app,
              telemetry: 'reading',
              errors: {
                count: 2,
                recent: [
                  { at: '2026-08-17T04:00:00Z', body: 'appkit:cache:persistent fell back to in-memory' },
                  { at: '2026-08-17T04:01:00Z', body: 'appkit:cache:persistent fell back to in-memory' },
                ],
              },
            },
          })
        )}
      />
    );
    expect(markup).not.toContain('error lines recorded');
    expect(markup).not.toContain('appkit:cache:persistent fell back to in-memory');
  });

  /**
   * A GENUINELY DOWN DEPENDENCY GETS THE LINES. The reader is pointed back at
   * the Result column rather than told everything is history.
   */
  it('does not reassure when a dependency is not answering', () => {
    const base = health();
    const markup = render(
      <HealthBody
        block={block(
          health({
            dependencies: base.dependencies.map((row, index) =>
              index === 0 ? { ...row, result: 'did-not-answer', reason: 'the warehouse refused' } : row
            ),
            app: {
              ...base.app,
              telemetry: 'reading',
              errors: { count: 1, recent: [{ at: '2026-08-19T09:00:00Z', body: 'query failed' }] },
            },
          })
        )}
      />
    );
    expect(markup).toContain('1 error line recorded');
    expect(markup).toContain('A dependency is not answering its most recent check');
    expect(markup).not.toContain('not a live failure');
  });

  /**
   * ZERO IS NOT A COUNT, which is the tab's rule and the one this line broke.
   *
   * "0 error lines in this range" draws the eye to a figure a reader then has to
   * read in order to discover that nothing happened, which the absence of the
   * line says on its own. The timestamp beside it is a different kind of fact
   * and stays: it is the only thing on the block that says whether anything has
   * reached this deployment at all.
   */
  it('renders no error line at all rather than a zero', () => {
    const markup = render(
      <HealthBody
        block={block(health({ app: { ...health().app, telemetry: 'reading', errors: { count: 0, recent: [] } } }))}
      />
    );
    expect(markup).not.toContain('0 error lines');
    expect(markup).not.toMatch(/error lines? recorded/);
    expect(markup).toContain('Most recent request');
  });

  it('links out to the platform record instead of paraphrasing it', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <HealthBody block={block(health())} />
      </MemoryRouter>
    );
    expect(markup).toContain('https://example.test/apps/pia/insights');
  });

  it('shows telemetry being off without deployment-variable narrative', () => {
    const markup = render(<HealthBody block={block(health())} />);
    expect(markup).toContain('App telemetry is off');
    expect(markup).not.toContain('PLAYER_INSIGHTS_TELEMETRY_SCHEMA');
    expect(markup).not.toContain('ops-absence-body');
  });

  it('offers a statement to run when the telemetry table cannot be read', () => {
    const payload = health({
      app: {
        ...health().app,
        telemetry: 'no-grant',
        table: 'a_catalog.a_telemetry_schema.otel_logs',
        grant: {
          object: 'a_catalog.a_telemetry_schema',
          privilege: 'SELECT',
          statement: 'GRANT SELECT ON SCHEMA a_catalog.a_telemetry_schema TO `someone@example.test`;',
        },
      },
    });
    const markup = render(<HealthBody block={block(payload)} />);
    expect(markup).toContain('You cannot read the telemetry table');
    expect(markup).toContain('GRANT SELECT ON SCHEMA');
  });

  it('says an empty telemetry table is expected rather than a sign of no traffic', () => {
    const payload = health({
      app: { ...health().app, telemetry: 'no-rows-yet', table: 'a_catalog.a_schema.otel_logs', reason: '' },
    });
    const markup = render(<HealthBody block={block(payload)} />);
    expect(markup).toContain('No telemetry history yet');
    expect(markup).toMatch(/does not backfill/);
    // In the line itself. The paragraph behind the "Why" disclosure that used to
    // carry this has gone, along with every other one on the tab.
    expect(markup).not.toContain('Why');
  });

  /**
   * A CHECK, NOT A READ, and the band says which.
   *
   * These rows are live probes against other people's services, and the cost and
   * traffic bands beside them are queries against tables. One word for both would
   * be a claim that the three timestamps mean the same thing, which is the claim
   * this page's three separate reads exist to avoid.
   */
  it('dates the health band as a check rather than as a read', () => {
    expect(render(<HealthBody block={block(health())} />)).toMatch(/Checked /);
    // And says so even before anything has run, rather than going blank.
    expect(render(<HealthBody block={block(health({ checkedAt: '' }))} />)).toContain('Not checked yet');
  });

  /**
   * A row lands on the same dependency's Connections row, where the server said
   * there is one.
   *
   * The empty `connectionsId` is the case the contract calls out and the one that
   * matters: the Vector Search endpoint is discovered rather than configured, so
   * a link built from the id alone would land a reader on Connections with
   * nothing highlighted, which reads as the page failing to find the row.
   */
  it('links a dependency to its Connections row, and only where there is one', () => {
    const markup = markupOf(<HealthBody block={block(health())} />);
    expect(markup).toContain('href="/connections?entity=warehouse"');
    expect(markup).toContain('href="/connections?entity=genie"');
    expect(markup).toContain('href="/connections?entity=agent"');
    // Three probe rows carry an id. The index carries none, and the app and
    // Lakebase rows are readings rather than probes, so none of the three draws a
    // link to a Connections row that was never there.
    expect([...markup.matchAll(/\/connections\?entity=/g)]).toHaveLength(3);
  });

  it("quotes the probe's own words rather than blending them into the page", () => {
    // Quoted so a reader can see where this app stops speaking and the platform
    // starts. The words themselves are never rewritten.
    expect(render(<HealthBody block={block(health())} />)).toContain('Natural-language data space');
  });

  it('labels the final health column Notes', () => {
    const markup = markupOf(<HealthBody block={block(health())} />);
    expect(markup).toMatch(/<th scope="col">Notes<\/th>/);
    expect(markup).not.toContain('Reason, when it did not answer');
  });

  it('says a check that did not run is neither, rather than leaving the cell blank', () => {
    // A blank beside "Not checked" reads as a result somebody has not written
    // down yet. It is a third state, and the row says so in words.
    expect(render(<HealthBody block={block(health())} />)).toContain('Semantic vector index · not checked');
  });

  /**
   * The platform pills are painted from the platform's own word, never green by
   * position.
   *
   * They are the results on this block whose colour could be decided by where they
   * sit rather than by what they say, and a pill painted green over a word that is
   * not "Ready" would be the only element on the tab contradicting its own text.
   */
  it('paints a platform reading from its word rather than from its place', () => {
    /** The tone class on the pill whose left half is this label. */
    const toneOf = (markup: string, label: string) =>
      new RegExp(
        `ast-pill--([a-z-]+) ops-pill ops-platform-pill"><span class="ops-platform-pill-label">${label}<`
      ).exec(markup)?.[1] ?? '';

    expect(toneOf(markupOf(<HealthBody block={block(health())} />), 'Serving endpoint')).toBe('pos');

    const middling = markupOf(
      <HealthBody
        block={block(
          health({
            platform: [
              {
                id: 'endpoint',
                label: 'Serving endpoint',
                state: 'Updating',
                read: true,
                rows: ['agent-endpoint'],
                reason: '',
              },
            ],
          })
        )}
      />
    );
    // Scoped to the pill carrying the platform's word: the rows around it paint an
    // answered probe with the same green, and an unscoped assertion would pass on
    // one of those instead.
    expect(toneOf(middling, 'Serving endpoint')).toBe('warn');

    const unread = markupOf(
      <HealthBody
        block={block(health({ platform: [{ id: 'app', label: 'App', state: '', read: false, rows: [], reason: '' }] }))}
      />
    );
    expect(toneOf(unread, 'App')).toBe('neutral-outline');
  });

  /**
   * EVERY ROW CARRIES ITS PRODUCT'S OWN MARK, from the shared module.
   *
   * Asserted through the markup the module produces rather than through the map,
   * because a map that is right and a component that is never called look
   * identical from `ops-view`'s side. The mark is decorative: the name is right
   * beside it, and one that announced itself would have a screen reader say the
   * product twice on every row.
   */
  it('carries a product mark on a dependency row, silently', () => {
    const markup = markupOf(<HealthBody block={block(health())} />);
    expect(markup).toContain('ops-dependency-mark');
    expect(markup).toContain('--brand-icon-size:16px');
    // Six rows, six marks, and none of them speaking. Four probes and the two
    // readings that are rows in their own right: the app and its store carry a
    // mark like their neighbours rather than sitting on the list unnamed.
    expect([...markup.matchAll(/ops-dependency-mark/g)]).toHaveLength(6);
    expect(markup).not.toContain('title="Databricks SQL"');
  });

  /**
   * A probe nobody has classified draws nothing, rather than a stand-in.
   *
   * The wrong mark on a row that is failing sends a reader to the wrong
   * service's console, which is worse than a row with no mark on it.
   */
  it('draws no mark for a probe kind it cannot name', () => {
    const markup = markupOf(
      <HealthBody
        block={block(
          health({
            dependencies: [{ ...health().dependencies[0], kind: 'something-nobody-has-mapped' }],
            // The one row, on its own. The app and Lakebase readings are named
            // kinds and would each draw a mark of their own.
            platform: [],
          })
        )}
      />
    );
    expect(markup).toContain('SQL warehouse');
    expect(markup).not.toContain('ops-dependency-mark');
  });
});

/* ── Cost ────────────────────────────────────────────────────────────────── */

describe('the cost block', () => {
  /**
   * A BADGE ON THE APPORTIONMENTS, WHERE SIX CAPTIONS USED TO BE.
   *
   * Every card carried a line saying how its figure was arrived at, and between
   * them they were six lines of prose under six numbers that wrapped into the
   * cards' own borders. The one thing a reader acts on is whether the figure is
   * an apportionment, and that is one word in the block's own pill.
   */
  it('labels an estimated figure inline and leaves a measured one bare', () => {
    const payload = cost({
      tiles: [
        { ...cost().tiles[0], id: 'sql-warehouse', label: 'SQL warehouse', quality: 'estimate' },
        { ...cost().tiles[0], id: 'serving-endpoint', label: 'Serving endpoint', quality: 'per-token' },
      ],
    });
    const markup = markupOf(<CostBody block={block(payload)} />);
    expect([...markup.matchAll(/ast-pill ast-pill--warn ops-pill/g)]).toHaveLength(1);
    expect(markup).toContain('>estimated<');
    expect(markup).not.toContain('selected period');
    expect(markup).not.toContain('Per token');
  });

  /**
   * AND THE SCOPE BESIDE IT, ON THE TWO METERS THAT ARE NOT OURS ALONE.
   *
   * By class as well as by word. The scope is a fact about what the figure
   * covers, and in the amber pill beside "Estimate" it would read as a second
   * warning about a number with one thing wrong with it. Asserted here because
   * neither the tone nor the absence of the chip on the other four cards is
   * something a reader would question by looking at the grid.
   */
  it('does not add scope chips or footer explanations to a tile', () => {
    const payload = cost({
      tiles: [
        { ...cost().tiles[0], id: 'genie', label: 'Genie', quality: 'estimate', population: 'Whole workspace' },
        { ...cost().tiles[0], id: 'app-compute', label: 'App compute', quality: 'rate', population: 'This app' },
      ],
    });
    const markup = markupOf(<CostBody block={block(payload)} />);
    expect(markup).not.toContain('Whole workspace');
    expect(markup).not.toContain('This app');
    // A sentence, in either direction, is what the badge replaced.
    expect(markup).not.toMatch(/spend shared|not this app|includes other/i);
  });

  /**
   * THE FIGURES LINE UP, which they did not.
   *
   * Six tiles in a three-column grid is the arrangement where proportional figures
   * are visible without leaving the page: a reader compares a column of currency
   * down the grid, and DM Sans digits run from 342 to 656 units wide, so `$1.10`
   * and `$8.88` do not share an edge. The rule asked for tabular figures with
   * `font-variant-numeric` and DM Sans has no `tnum` feature to switch on, so it
   * had never done anything.
   *
   * The class goes on the figure ALONE. The basis beside it -- "in range", "per
   * day" -- is a phrase, and in mono it would read as part of the value.
   */
  it('sets the figures in mono and the basis beside them in DM Sans', () => {
    const markup = markupOf(<CostBody block={block(cost())} />);
    expect(markup).toMatch(/<span class="ast-num">[^<]*\d/);
    expect(markup).not.toMatch(/class="ops-tile-basis ast-num"|class="ast-num[^"]*"[^>]*>(selected period|per day)/);
  });

  /** The six lines of prose, gone, and named so they cannot come back quietly. */
  it('carries no caption under any figure', () => {
    const payload = cost({
      tiles: (['serving-endpoint', 'sql-warehouse', 'genie', 'vector-search', 'app-compute'] as const).map((id) => ({
        ...cost().tiles[0],
        id,
      })),
    });
    const markup = render(<CostBody block={block(payload)} />);
    for (const caption of [
      'per-token: from recorded tokens',
      'hourly spend shared across queries by duration',
      'billed against the warehouse behind it',
      'whether used or not',
      'bills while the app exists',
      'billed per job run',
    ]) {
      expect(markup).not.toContain(caption);
    }
  });

  it('leaves range totals unlabelled and keeps daily rates explicit', () => {
    const markup = render(<CostBody block={block(cost())} />);
    expect(markup).not.toContain('selected period');
    expect(markup).toContain('per day');
  });

  it('keeps attribution methodology out of the simplified tile area', () => {
    expect(render(<CostBody block={block(cost())} />)).not.toContain('system_billing');
    expect(render(<CostBody block={block(cost())} />)).not.toContain("custom_tags['astrolabe']");
  });

  /**
   * BADGES OVER THE BLOCK, WHERE THERE WERE THREE QUALIFIERS UNDER IT.
   *
   * List prices rather than the bill, complete days only, and read under this
   * reader's own grants: three lines saying the same thing about how much weight
   * these figures bear, stacked above a grid of numbers. They have to govern the
   * block rather than a tile, because they are as true of the cards with no
   * figure as of the amounts.
   *
   * "Experimental" is what the figures are worth — it replaced "Not production",
   * which described the account they came from rather than the numbers.
   */
  it('qualifies the whole block with badges rather than a paragraph', () => {
    const markup = markupOf(<CostBody block={block(cost())} />);
    const visible = text(markup);
    expect(visible).toContain('Experimental');
    expect(visible).not.toContain('Under development');
    expect(visible).not.toContain('Not production');
    expect(visible).not.toMatch(/How to read these figures/);
    expect(visible).toContain('7 days');
    expect(visible).toContain('Prices use Databricks list rates; contracted rates are not available.');
    expect(visible).not.toContain('system.billing.list_prices');
    expect(visible).not.toContain('complete days');
    expect(markup.indexOf('>Experimental</span>')).toBeLessThan(markup.indexOf('>Cost</h3>'));
  });

  it('states exact partial Query History coverage instead of implying an estimate is complete', () => {
    const detail = queryHistoryCoverageDetail({
      state: 'partial',
      requestedRange: { from: '1970-01-01T00:00:00.000Z', to: '2026-08-30T23:59:59.999Z' },
      queriedRange: { from: '2025-08-30T00:00:00.000Z', to: '2026-08-30T23:59:59.999Z' },
      rowsRead: 1_998,
      pagesRead: 2,
      chunksRead: 1,
      reasons: ['range-clamped', 'page-cap'],
    });

    expect(detail).toContain('Partial: requested 1970-01-01 to 2026-08-30');
    expect(detail).toContain('queried 2025-08-30 to 2026-08-30');
    expect(detail).toContain('1998 rows across 2 pages');
    expect(detail).toContain('requested span exceeded the bounded history window');
    expect(detail).toContain('page limit was reached');
    expect(detail).toContain('SQL and Genie allocations are withheld');
  });

  it('draws that badge as the badge the rest of the tab uses', () => {
    // By class, on the raw markup: the word alone would pass against a bare
    // span, and a section-level caveat set in body text is the sentence this
    // replaced.
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <CostBody block={block(cost())} />
      </MemoryRouter>
    );
    expect(markup).toContain('ast-pill ast-pill--warn ops-pill');
    expect(markup).not.toContain('ops-block-unfinished');
  });

  /**
   * A state and a remedy, where two cards were nothing but a paragraph.
   *
   * A configured resource with no billing identity is a state and a remedy,
   * never a zero.
   */
  it('renders a missing resource identifier as a concise state without a footer remedy', () => {
    const payload = cost({
      tiles: [
        {
          ...cost().tiles[0],
          label: 'Serving endpoint',
          amount: null,
          unavailable: 'Resource identifier unavailable',
          remedy: 'Set DATABRICKS_SERVING_ENDPOINT_NAME.',
        },
      ],
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('Resource identifier unavailable');
    expect(markup).not.toContain('Not attributable');
    expect(markup).not.toContain('Set DATABRICKS_SERVING_ENDPOINT_NAME.');
    expect(markup).not.toMatch(/cannot be told apart/);
    expect(markup).not.toContain('0.00');
  });

  it('shows only the high-level attributed-cost formula', () => {
    const markup = render(<CostBody block={block(cost())} />);
    expect(markup).toContain('AVG. COST / QUESTION');
    expect(markup).toContain('Attributed serving + SQL ÷ completed questions');
    expect(markup).not.toContain('Average model serving per question');
    expect(markup).not.toContain('token-apportions model-serving spend only');
    expect(markup).not.toContain('Per-question attribution');
    expect(markup).not.toContain('3.00 USD');
    expect(markup).not.toContain('across 4 questions');
  });

  it('averages attributed serving and SQL spend and removes the per-run table', () => {
    const payload = cost({
      tiles: [
        {
          id: 'serving-endpoint',
          label: 'Serving endpoint',
          resourceId: 'an-endpoint',
          quality: 'real',
          amount: 10,
          basis: 'total-in-range',
          population: 'This endpoint',
          unavailable: '',
          remedy: '',
          note: '',
        },
        {
          id: 'sql-warehouse',
          label: 'SQL warehouse',
          resourceId: 'warehouse',
          quality: 'estimate',
          amount: 4,
          basis: 'total-in-range',
          population: 'This warehouse',
          attribution: 'deployment',
          unavailable: '',
          remedy: '',
          note: '',
        },
      ],
      perQuestion: {
        runsInRange: 2,
        tokenCoveredRuns: 2,
        totalRecordedTokens: 1000,
        limited: false,
        reason: '',
        runs: [
          {
            runId: 'run-1',
            correlationId: 'req-1',
            traceId: 'trace-1',
            completedAt: '2026-08-14T12:00:00Z',
            totalTokens: 1000,
            parts: [
              {
                id: 'serving-endpoint',
                label: 'Model serving',
                quality: 'per-token',
                amount: 1.25,
                unavailable: '',
              },
              {
                id: 'sql-warehouse',
                label: 'SQL warehouse',
                quality: 'estimate',
                amount: 2,
                unavailable: '',
              },
              {
                id: 'genie',
                label: 'Genie spaces',
                quality: 'unknown',
                amount: null,
                unavailable: 'No run attribution key.',
              },
            ],
          },
        ],
      },
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('7.00 USD');
    expect(markup).toContain('Attributed serving + SQL ÷ completed questions');
    expect(markup).not.toContain('token-apportioned');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('Not knowable per question today');
    expect(markup).not.toContain('No run attribution key.');
    expect(markup).not.toContain('2.00 USD');
  });

  it('renders a missing grant with the statement that fixes it', () => {
    const payload = cost({
      state: 'no-grant',
      tiles: [],
      grant: {
        object: 'system.billing',
        privilege: 'SELECT',
        statement: 'GRANT SELECT ON SCHEMA system.billing TO `someone@example.test`;',
      },
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('You cannot read the billing tables');
    expect(markup).toContain('GRANT SELECT ON SCHEMA system.billing');
  });

  it('renders an unfilled range as a different thing from a missing grant', () => {
    const markup = render(<CostBody block={block(cost({ state: 'no-rows', tiles: [] }))} />);
    expect(markup).toMatch(/nothing to grant/);
    expect(markup).not.toContain('GRANT SELECT');
    expect(markup).not.toContain('You cannot read the billing tables');
  });

  /**
   * Empty spend still draws the same boxes as a billed week. A single
   * "No billing rows yet" card swallowed the resources we are tracking, so
   * there was nothing to click and no place for a zero to land.
   */
  it('keeps the resource tile grid when billing has no matching rows', () => {
    const markup = markupOf(
      <CostBody
        block={block(
          cost({
            state: 'no-rows',
            tiles: [],
            reason: 'No billing rows matched an exact tracked resource.',
          })
        )}
      />
    );
    expect(markup).toContain('class="ops-tiles"');
    expect(markup).not.toContain('class="ops-absence"');
    expect(markup).toContain('Serving endpoint');
    expect(markup).toContain('SQL warehouse');
    expect(markup).toContain('Genie');
    expect(markup).toContain('Vector search');
    expect(markup).toContain('App compute');
    expect(markup).toContain('AVG. COST / QUESTION');
    expect(markup).not.toContain('Index rebuild job');
    expect(markup).toContain('No billing rows');
    expect(markup).toContain('No billing rows matched an exact tracked resource');
    expect(markup).not.toContain('system_billing');
    expect((markup.match(/class="ops-tile"/g) ?? []).length).toBe(7);
  });

  it('draws one box per connected Genie space and Vector Search when billing is empty', () => {
    const empty = {
      amount: null as number | null,
      quality: 'unknown' as const,
      basis: 'total-in-range' as const,
      population: '',
      unavailable: 'No billing rows',
      remedy: '',
      note: '',
    };
    const markup = markupOf(
      <CostBody
        block={block(
          cost({
            state: 'no-rows',
            tiles: [
              {
                ...empty,
                id: 'serving-endpoint',
                label: 'Serving endpoint',
                resourceId: 'an-endpoint',
                resourceKind: 'serving-endpoint',
              },
              {
                ...empty,
                id: 'sql-warehouse',
                label: 'SQL warehouse',
                resourceId: 'wh-1',
                resourceKind: 'sql-warehouse',
              },
              {
                ...empty,
                id: 'genie:space-data',
                label: 'Player data',
                resourceId: 'space-data',
                resourceKind: 'genie-space',
              },
              {
                ...empty,
                id: 'genie:space-dictionary',
                label: 'Dictionary',
                resourceId: 'space-dictionary',
                resourceKind: 'genie-space',
              },
              {
                ...empty,
                id: 'vector-search',
                label: 'Vector search',
                resourceId: 'cat.schema.index',
                resourceKind: 'vector-index',
              },
              { ...empty, id: 'app-compute', label: 'App compute', resourceId: 'player-insights', resourceKind: 'app' },
            ],
            reason: 'No billing rows matched the Astrolabe tag in this range.',
          })
        )}
      />
    );
    expect(markup).toContain('Player data');
    expect(markup).toContain('Dictionary');
    expect(markup).toContain('Vector search');
    expect(markup).not.toContain('identifier unavailable');
    expect(markup).toContain('No billing rows');
    expect(markup).not.toContain('Index rebuild');
    expect((markup.match(/class="ops-tile"/g) ?? []).length).toBe(7);
  });

  it('removes the narrative qualifiers from the cost band', () => {
    const markup = render(<CostBody block={block(cost())} />);
    expect(markup).not.toContain('read under your own grants');
    expect(markup).not.toContain('through 14 Aug, the last complete day');
    expect(markup).not.toContain('At list price');
  });

  it('marks every cost tile and the average as experimental', () => {
    const payload = cost();
    const markup = markupOf(<CostBody block={block(payload)} />);
    expect([...markup.matchAll(/experimental-pane-badge/g)]).toHaveLength(payload.tiles.length + 1);
    const heads = markup.match(/<div class="ops-tile-head">[\s\S]*?<\/div>/g) ?? [];
    expect(heads).toHaveLength(payload.tiles.length + 1);
    expect(heads.every((head) => head.indexOf('experimental-pane-badge') < head.indexOf('ops-tile-label'))).toBe(true);
  });

  /**
   * The tile mark, at the smaller of the two sizes this page uses.
   *
   * The fixture's two tiles are keyed `endpoint` and `index-endpoint`, neither of
   * which is a cost component the server emits, so this drives the real ids.
   */
  it('marks a tile with the product the figure is for', () => {
    const payload = cost({
      tiles: [
        { ...cost().tiles[0], id: 'serving-endpoint' },
        { ...cost().tiles[1], id: 'app-compute' },
      ],
    });
    const markup = markupOf(<CostBody block={block(payload)} />);
    expect([...markup.matchAll(/ops-tile-mark/g)]).toHaveLength(2);
    expect(markup).toContain('--brand-icon-size:14px');
  });

  it('renders Data Genie, Dictionary Genie, Serving, and Vector Search separately with scoped counts', () => {
    const payload = cost({
      tiles: [
        {
          ...cost().tiles[0],
          id: 'serving-endpoint',
          label: 'Serving endpoint',
          resourceId: 'astrolabe-agent',
          resourceKind: 'serving-endpoint',
        },
        {
          ...cost().tiles[0],
          id: 'genie:data',
          label: 'Data Genie',
          resourceId: 'space-data',
          resourceKind: 'genie-space',
          amount: null,
          quality: 'unknown',
          unavailable: 'Genie LLM dollars unavailable',
          evidence: {
            billingRows: null,
            astrolabeQueries: null,
            activity: { calls: 3, observedCalls: 4, unit: 'requests' },
          },
        },
        {
          ...cost().tiles[0],
          id: 'genie:dictionary',
          label: 'Dictionary Genie',
          resourceId: 'space-dictionary',
          resourceKind: 'genie-space',
          amount: null,
          quality: 'unknown',
          unavailable: 'Genie LLM dollars unavailable',
          evidence: {
            billingRows: null,
            astrolabeQueries: null,
            activity: { calls: 2, observedCalls: 2, unit: 'requests' },
          },
        },
        {
          ...cost().tiles[0],
          id: 'vector-search',
          label: 'Vector search',
          resourceId: 'catalog.schema.index',
          secondaryResourceId: 'vs-endpoint',
          resourceKind: 'vector-index',
          amount: null,
          quality: 'unknown',
          unavailable: 'Vector Search dollars unavailable',
          evidence: {
            billingRows: null,
            astrolabeQueries: null,
            activity: { calls: 5, observedCalls: 7, unit: 'queries' },
          },
        },
      ],
    });
    const markup = markupOf(<CostBody block={block(payload)} />);
    const visible = text(markup);
    expect(visible).toContain('Serving endpoint · astrolabe-agent');
    expect(visible).toContain('Data Genie · space-data');
    expect(visible).toContain('Dictionary Genie · space-dictionary');
    expect(visible).toContain('Vector search · catalog.schema.index · vs-endpoint');
    expect(visible).toContain('Genie LLM dollars unavailable');
    expect(visible).toContain('Vector Search dollars unavailable');
    expect(visible).not.toMatch(/Astrolabe (?:requests|queries)/);
    expect(visible).not.toContain('carry resource identity');
    expect(visible).not.toContain('Foundation model');
    expect(visible).not.toContain('withheld');
  });

  it('keeps internal Vector Search activity out of the visible cost tile', () => {
    const tile = {
      ...cost().tiles[0],
      id: 'vector-search',
      label: 'Vector search',
      resourceId: 'catalog.schema.index',
      resourceKind: 'vector-index' as const,
      amount: null,
      quality: 'unknown' as const,
      unavailable: 'Vector Search dollars unavailable',
      evidence: {
        billingRows: null,
        astrolabeQueries: null,
        activity: { calls: 1, observedCalls: 1, unit: 'queries' as const },
      },
    };
    const visible = text(markupOf(<CostBody block={block(cost({ tiles: [tile] }))} />));

    expect(visible).toContain('Vector Search dollars unavailable');
    expect(visible).not.toContain('Astrolabe query');
  });

  it('shows only concise row-count evidence under a SQL estimate', () => {
    const payload = cost({
      tiles: [
        {
          ...cost().tiles[0],
          id: 'sql-warehouse',
          label: 'SQL warehouse',
          resourceId: 'warehouse-1',
          resourceKind: 'sql-warehouse',
          quality: 'estimate',
          amount: 2.5,
          evidence: {
            billingRows: 4,
            astrolabeQueries: 2,
            warehouseQueries: 10,
            queryHistoryComplete: true,
          },
          remedy: 'This must not render.',
          note: 'This must not render either.',
        },
      ],
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('2.50 USD estimated');
    expect(markup).toContain('4 billing rows');
    expect(markup).not.toMatch(/Astrolabe quer|warehouse quer/);
    expect(markup).not.toMatch(/ops-tile-evidence[^>]*>warehouse-1/);
    expect(markup).not.toContain('This must not render');
    expect(markup).not.toContain('ops-tile-foot');
    expect(markup).not.toContain('ops-tile-formula');
  });

  it('draws a tile title as a hyperlink with the Databricks mark when it has a URL', () => {
    const markup = markupOf(
      <CostTileTitle label="Serving endpoint" href="https://example-workspace.invalid/ml/endpoints/an-endpoint" />
    );
    expect(markup).toContain('href="https://example-workspace.invalid/ml/endpoints/an-endpoint"');
    expect(markup).toContain('ops-tile-label-link');
    expect(markup).toContain('lucide-external-link');
    expect(markup).toContain('Open Serving endpoint in Databricks');
  });

  it('leaves a title as plain text when there is no URL', () => {
    const markup = markupOf(<CostTileTitle label="Genie" href={null} />);
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('lucide-external-link');
    expect(markup).toContain('Genie');
  });

  it('sits the average in the same tile grid as the resource cards', () => {
    const markup = markupOf(<CostBody block={block(cost())} />);
    expect(markup).not.toContain('ops-question-average');
    const tiles = markup.match(/class="ops-tile"/g) ?? [];
    expect(tiles.length).toBe(cost().tiles.length + 1);
    expect(markup).not.toContain('Total app cost');
  });

  it('shows a state rather than a zero where a figure could not be sourced', () => {
    const payload = cost({
      tiles: [
        {
          ...cost().tiles[0],
          amount: null,
          unavailable: 'Nothing in billing named this endpoint.',
        },
      ],
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('Nothing in billing named this endpoint.');
    expect(markup).not.toContain('0.00');
  });

  it('lets an operator set an app budget and a per-tile budget for the Cost window', () => {
    const payload = cost({
      budgets: {
        total: { USD: 400, DBU: 50 },
        resources: { 'serving-endpoint': { USD: 40, DBU: 5 } },
      },
      tiles: [
        { ...cost().tiles[0], id: 'serving-endpoint', label: 'Serving endpoint', basis: 'total-in-range' },
        { ...cost().tiles[1], id: 'vector-search', label: 'Vector search', basis: 'per-day' },
      ],
    });
    const markup = markupOf(<CostBody block={block(payload)} />);
    expect(markup).toContain('Total app spend');
    expect(markup).toContain('App budget');
    expect(markup).toContain('aria-label="App budget in USD"');
    expect(markup).toContain('aria-label="Serving endpoint budget in USD"');
    expect(markup).toContain('aria-label="Vector search budget per day in USD"');
    expect(markup).not.toContain('selected period');
    expect(markup).toMatch(/aria-label="App budget in USD"[^>]*placeholder="1\.5"[^>]*value="400"/);
    expect(markup).toMatch(/aria-label="Serving endpoint budget in USD"[^>]*placeholder="1\.5"[^>]*value="40"/);
    expect(markup).toContain('placeholder="4"');
    expect(markup).not.toContain('class="ops-budget-unit"');
    expect(markup).not.toContain('<select');
    expect(markup.match(/aria-label="Budget unit filter"/g)).toHaveLength(1);
    expect(markup).toContain('lucide-sliders-horizontal');
    expect(markup.match(/class="time-range-segment cost-unit-segment"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="US dollars"');
    expect(markup).toContain('aria-label="Databricks units"');
    expect(OPS_SOURCE).toContain('onKeyDown={move}');
    expect(OPS_SOURCE).toContain('adjacentCostDisplayUnit');
    expect(OPS_STYLES).toMatch(/\.cost-unit-segment\s*\{[^}]*opacity:\s*1/);
    expect(markup.match(/data-prefix="true"/g)).toHaveLength(payload.tiles.length + 1);
    expect(markup.match(/class="ops-number-ticker-prefix" aria-hidden="true">\$<\/span>/g)).toHaveLength(
      payload.tiles.length + 1
    );
    expect(markup).toMatch(/aria-label="Vector search budget per day in USD"[^>]*value=""/);
    expect(markup.match(/class="ops-budget-resource">Serving endpoint/g)).toHaveLength(1);
    expect(markup).not.toContain('ops-budget-label');
    expect(markup).not.toContain('Same window as the tiles');
    expect(text(markup)).not.toMatch(/month|monthly|PagerDuty|forecast/i);
    expect(markup).toContain('400');
    expect(markup).toContain('40');
    expect([...markup.matchAll(/>Apply<\/button>/g)]).toHaveLength(1);
    expect([...markup.matchAll(/>Apply resource budgets<\/button>/g)]).toHaveLength(1);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Apply resource budgets<\/button>/);
    expect(markup.indexOf('ops-cost-summary-grid')).toBeLessThan(markup.indexOf('ops-tiles'));
    expect(OPS_STYLES).toMatch(/\.ops-number-ticker-wide\s*\{[^}]*width:\s*min\(100%,\s*14rem\)/);
    expect(OPS_STYLES).toMatch(/\.ops-number-ticker\[data-prefix='true'\] input\s*\{[^}]*padding-left:\s*22px/);
    expect(OPS_STYLES).toMatch(/\.ops-number-ticker\[data-suffix='true'\] input\s*\{[^}]*padding-right:\s*40px/);
    expect(OPS_STYLES).toMatch(/\.ops-tile-budget\s*\{[^}]*display:\s*grid/);
  });

  it('uses resource-specific DBU placeholders and an unavailable state without converting dollars', () => {
    const payload = cost({
      budgets: {
        total: { USD: 100, DBU: null },
        resources: {
          'serving-endpoint': { USD: 54.81, DBU: null },
          'app-compute': { USD: 11.19, DBU: null },
        },
      },
      tiles: [
        { ...cost().tiles[0], id: 'serving-endpoint', label: 'Serving endpoint', dbus: 2.75 },
        {
          ...cost().tiles[0],
          id: 'app-compute',
          label: 'App compute',
          amount: 99,
          dbus: null,
        },
      ],
    });
    const markup = markupOf(<CostBody block={block(payload)} unit="DBU" />);
    expect(markup).toMatch(/aria-label="App budget in DBU"[^>]*placeholder="2\.75"/);
    expect(markup).toMatch(/aria-label="Serving endpoint budget in DBU"[^>]*placeholder="2\.75"/);
    expect(markup).toMatch(/aria-label="App compute budget in DBU"[^>]*placeholder=""/);
    expect(markup.match(/data-suffix="true"/g)).toHaveLength(payload.tiles.length + 1);
    expect(markup.match(/class="ops-number-ticker-suffix" aria-hidden="true">DBU<\/span>/g)).toHaveLength(
      payload.tiles.length + 1
    );
    expect(markup).not.toContain('class="ops-number-ticker-prefix" aria-hidden="true">$');
    expect(markup).not.toContain('e.g.');
    expect(markup).not.toContain('value="100"');
    expect(markup).not.toContain('value="54.81"');
    expect(markup).toContain('2.75 DBU');
    expect(markup).not.toContain('99.00 USD');
  });

  it('renders measured Vector Search USD and DBUs from the same corrected tile', () => {
    const vector = {
      ...cost().tiles[1],
      id: 'vector-search',
      label: 'Vector search',
      resourceId: 'catalog.schema.index',
      secondaryResourceId: 'vs-endpoint',
      amount: 7,
      dbus: 3,
      basis: 'per-day' as const,
      attribution: 'deployment' as const,
      evidence: { billingRows: 2, astrolabeQueries: null },
    };
    const payload = cost({ tiles: [vector] });
    expect(render(<CostBody block={block(payload)} unit="USD" />)).toContain('7.00 USD');
    expect(render(<CostBody block={block(payload)} unit="DBU" />)).toContain('3.00 DBU');
  });

  it('compares spend to a tile budget when both exist, and still offers a budget when spend is missing', () => {
    const payload = cost({
      budgets: {
        total: { value: null, unit: 'USD' },
        resources: {
          'serving-endpoint': { value: 11, unit: 'USD' },
          'app-compute': { value: 25, unit: 'USD' },
        },
      },
      tiles: [
        {
          ...cost().tiles[0],
          id: 'serving-endpoint',
          label: 'Serving endpoint',
          amount: 12,
          quality: 'real',
          basis: 'total-in-range',
        },
        {
          ...cost().tiles[0],
          id: 'app-compute',
          label: 'App compute',
          amount: null,
          quality: 'unknown',
          unavailable: 'No billing rows',
          basis: 'total-in-range',
        },
      ],
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('Over budget');
    expect(markup).toContain('No billing rows');
    expect(markup).toContain('spend not measured');
  });

  it('does not compare a partial list-price lower bound to a budget', () => {
    const payload = cost({
      budgets: {
        total: { value: null, unit: 'USD' },
        resources: { 'serving-endpoint': { value: 11, unit: 'USD' } },
      },
      tiles: [
        {
          ...cost().tiles[0],
          id: 'serving-endpoint',
          label: 'Serving endpoint',
          amount: null,
          quality: 'unknown',
          unavailable: 'Partial list-price coverage; spend withheld. Unpriced SKUs: NEW_SKU',
          pricing: {
            source: 'list_prices',
            match: 'partial',
            currency: 'USD',
            pricedQuantity: 10,
            unpricedQuantity: 2,
            pricedRows: 1,
            unpricedRows: 1,
            unpricedSkus: ['NEW_SKU'],
            duplicateMatches: 0,
            correctionRows: 0,
            priceEffectiveAt: '2026-01-01T00:00:00Z',
          },
        },
      ],
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('Partial list-price coverage; spend withheld');
    expect(markup).toContain('Budget');
    expect(markup).toContain('spend not measured');
    expect(markup).not.toContain('Over budget');
    expect(markup).not.toContain('Under budget');
    expect(markup).not.toContain('12.00 USD');
  });

  it('never labels a whole-warehouse meter as an app overage', () => {
    const payload = cost({
      budgets: {
        total: { value: null, unit: 'USD' },
        resources: { 'sql-warehouse': { value: 10, unit: 'USD' } },
      },
      tiles: [
        {
          ...cost().tiles[0],
          id: 'sql-warehouse',
          label: 'SQL warehouse',
          amount: 50,
          quality: 'estimate',
          population: 'Whole warehouse',
          attribution: 'shared-upper-bound',
        },
      ],
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('shared meter vs named budget');
    expect(markup).not.toContain('Over budget');
  });

  it('keeps Genie cards dollar-free and names LLM spend as not attributable', () => {
    const payload = cost({
      tiles: [
        {
          id: 'genie:space-data',
          label: 'Player data',
          resourceId: 'space-data',
          resourceKind: 'genie-space',
          quality: 'unknown',
          amount: null,
          basis: 'total-in-range',
          population: 'This space',
          attribution: 'unavailable',
          unavailable: 'Genie LLM dollars unavailable',
          remedy: '',
          note: 'SQL from this space is billed on the SQL warehouse tile. That warehouse figure is not the complete Genie cost.',
        },
      ],
    });
    const markup = render(<CostBody block={block(payload)} />);
    expect(markup).toContain('Genie LLM dollars unavailable');
    expect(markup).toContain('space-data');
    expect(markup).not.toContain('not the complete Genie cost');
    expect(markup).not.toContain('0.00');
  });

  it('removes mapped coverage explanations from the simplified product tile', () => {
    const payload = cost({
      coverage: {
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
            reason: 'Matched by app name. App tags are organizational.',
          },
          {
            product: 'JOBS',
            taggedRows: 4,
            taggedQuantity: 4,
            pricedRows: 4,
            unpricedRows: 0,
            tiled: false,
            reason: 'The semantic rebuild job is tagged when connected, but it is not a Cost tile.',
          },
        ],
        propagation: [{ product: 'APPS', status: 'unsupported', detail: 'App tags are organizational.' }],
      },
      tiles: [{ ...cost().tiles[0], id: 'app-compute', label: 'App compute' }],
    });
    const markup = markupOf(<CostBody block={block(payload)} />);
    expect(markup).toContain('App compute');
    expect(markup).not.toContain('ops-tile-coverage');
    expect(markup).not.toContain('App tags are organizational.');
    expect(markup).not.toContain('Tracked cost components');
    expect(markup).not.toContain('11 tagged resources');
    expect(markup).not.toContain('semantic rebuild job');
  });

  it('keeps budget fields when billing has no rows and when the grant is missing', () => {
    const empty = render(<CostBody block={block(cost({ state: 'no-rows', tiles: [] }))} />);
    expect(empty).toContain('App budget');
    expect(empty).not.toContain('selected period');
    const denied = render(
      <CostBody
        block={block(
          cost({
            state: 'no-grant',
            tiles: [],
            grant: {
              object: 'system.billing',
              privilege: 'SELECT',
              statement: 'GRANT SELECT ON SCHEMA system.billing TO `someone@example.test`;',
            },
          })
        )}
      />
    );
    expect(denied).toContain('App budget');
    expect(denied).toContain('GRANT SELECT ON SCHEMA system.billing');
    expect(denied).toContain('Serving endpoint');
  });
});

/* ── Traffic ─────────────────────────────────────────────────────────────── */

describe('the traffic block', () => {
  it('keeps the first local active-minute sample partial and on its Runtime calendar day', () => {
    const payload = traffic({
      activeMinutesPerDay: [{ day: '2026-08-27', count: 3 }],
      activeMinutesTimeZone: 'America/Los_Angeles',
      activeMinutesRecordedFrom: '2026-08-28T05:58:00Z',
      activeMinutesRecordedThrough: '2026-08-28T06:00:00Z',
    });
    const summary = activeMinutesDisplay(payload);
    expect(summary.title).toBe('Active app minutes · 3 total');
    expect(summary.note).toContain('Partial coverage since Aug 27');
    expect(summary.note).not.toContain('since Aug 28');

    const markup = render(<TrafficBody block={block(payload)} />);
    expect(markup).toContain('Active app minutes · 3 total');
    expect(markup).toContain('Partial coverage since Aug 27');
  });

  it('draws failures and refusals as two charts', () => {
    const markup = render(<TrafficBody block={block(traffic())} />);
    expect(markup).toContain('Failures by cause');
    expect(markup).toContain('Refusals by cause');
    // Two headings say this. The title no longer narrates the layout under them.
    expect(markup).not.toContain('never this one');
  });

  it('keeps both cause charts together as the middle visual group', () => {
    const markup = markupOf(<TrafficBody block={block(traffic())} />);
    const middle = markup.match(
      /<div class="ops-chart-pair"[^>]*>([\s\S]*?)<\/div><div class="ops-chart ops-chart-tool">/
    )?.[1];
    expect(middle).toBeDefined();
    expect(text(middle!)).toContain('Failures by cause');
    expect(text(middle!)).toContain('Refusals by cause');
  });

  /**
   * THE CHART HAS A SCALE NOW, which is the whole of what was wrong with it.
   *
   * Four bars between two dates and the counts off screen: a reader could see
   * which day was busiest and had no way to tell whether the tallest was three
   * questions or three hundred. A short range labels every column; a long one
   * marks the peak on the line the tallest column reaches, because thirty
   * figures across a card collide and one does not.
   */
  it('gives the day columns a magnitude at both densities', () => {
    const day = (n: number) => ({ day: `2026-08-${String(n).padStart(2, '0')}`, count: n });
    const week = markupOf(
      <TrafficBody
        block={block(traffic({ questionsPerDay: [day(3), day(9)], distinctAskersPerDay: [], activeMinutesPerDay: [] }))}
      />
    );
    expect(week).toContain('ops-daybar-value');
    expect(week).not.toContain('ops-daybars-peak');

    const month = markupOf(
      <TrafficBody
        block={block(
          traffic({
            questionsPerDay: Array.from({ length: 30 }, (_, i) => day(i + 1)),
            distinctAskersPerDay: [],
            activeMinutesPerDay: [],
          })
        )}
      />
    );
    expect(month).not.toContain('ops-daybar-value');
    expect(month).toContain('ops-daybars-peak');
    // The peak itself, not the first or last day's count.
    expect(text(month.slice(month.indexOf('ops-daybars-peak')))).toMatch(/^[^0-9]*30/);
  });

  it('never shows a total of the two', () => {
    // The freshness line is relative to the real clock, so it can say "Read 42
    // days ago" on some future afternoon and fail this for a reason that has
    // nothing to do with the claim. Dropped before the assertion rather than
    // frozen, because freezing it here would mean threading a clock through the
    // block head for one test.
    const markup = render(<TrafficBody block={block(traffic())} />).replace(/Read[^A-Z]*ago/g, '');
    // 2 failures and 40 refusals. 42 is the number nothing on this page is
    // allowed to produce: a refusal is the app working correctly, a failure is
    // the app not working, and the sum is a "problems" figure an operator would
    // chase into the access controls doing their job.
    expect(markup).not.toContain('42');
    expect(markup).toContain('2');
    expect(markup).toContain('40');
  });

  it('prints every count as a number rather than only as a bar length', () => {
    const markup = render(<TrafficBody block={block(traffic())} />);
    expect(markup).toContain('30');
    expect(markup).toContain('12');
    expect(markup).toContain('4');
    expect(markup).toContain('80');
    expect(markup).toContain('Distinct askers per day');
    expect(markup).toContain('Active app minutes · 80 total');
  });

  /**
   * TWO EMPTY CHARTS, AND NOT THE SAME SENTENCE TWICE.
   *
   * Failures and refusals are stacked and both are usually empty, and each used
   * to render "No <plural> in this range, out of 50 runs that ended in it." The
   * only word that differed was the noun. The run count is in the band above,
   * once, where it governs all three charts.
   */
  it('says an empty chart is empty in as few words as that takes', () => {
    const markup = render(<TrafficBody block={block(traffic({ failuresByCause: [], refusalsByCause: [] }))} />);
    expect(markup).toContain('No failures');
    expect(markup).toContain('No refusals');
    expect(markup).not.toMatch(/out of 50 runs that ended in it/);
    expect(markup).not.toMatch(/No failures in this range/);
  });

  it('replaces itself with a reason when the store could not be read', () => {
    const markup = render(<TrafficBody block={block(traffic({ reason: 'Lakebase refused the connection.' }))} />);
    expect(markup).toContain('Traffic could not be read');
    expect(markup).toContain('Lakebase refused the connection.');
  });

  /**
   * ONE READ GONE IS NOT THE BLOCK GONE, AND IT IS NOT A ZERO EITHER.
   *
   * The empty chart above is a measurement. This one is not, and the two are
   * the same picture, so the difference has to be in words on the page. What
   * must NOT happen is the block substituting itself: the two charts that
   * answered are the reason the reads are settled separately in the first place.
   */
  it('names a chart it could not read without discarding the ones it could', () => {
    const markup = render(
      <TrafficBody
        block={block(
          traffic({
            questionsPerDay: [],
            unread:
              'Questions per day could not be read, so that chart is missing rather than empty: the store did not answer',
          })
        )}
      />
    );
    expect(markup).toContain('Part of this could not be read');
    expect(markup).toContain('Questions per day could not be read');
    // The block is still standing, with the charts that did answer on it.
    expect(markup).not.toContain('Traffic could not be read');
    expect(markup).toContain('Warehouse unavailable');
  });

  it('says nothing extra when every read answered and the answer was nothing', () => {
    const markup = render(
      <TrafficBody
        block={block(traffic({ questionsPerDay: [], failuresByCause: [], toolCalls: [], runsInRange: 0 }))}
      />
    );
    expect(markup).not.toContain('could not be read');
  });

  /**
   * A COUNT LEADS TO THE RUNS IT COUNTED, and to the right ones.
   *
   * The two links must differ. Failures and refusals are disjoint by
   * construction, so a refusal count that landed on the failure filter would
   * show a reader a list that cannot contain what they clicked, and the page
   * they came from would look like it had invented the number.
   */
  it('sends a cause count to the runs behind it, filtered to that outcome', () => {
    const markup = markupOf(<TrafficBody block={block(traffic())} />);
    expect(markup).toContain('href="/monitoring?outcome=failed"');
    expect(markup).toContain('href="/monitoring?outcome=refused"');
  });

  /**
   * THE WAY THROUGH TO THE RUNS THEMSELVES, which the handoff's footer asks for
   * and this block did not have.
   *
   * The cause charts land on Monitoring filtered to an outcome. What was missing
   * was the route to the runs as runs, where an answer time is a fact about one
   * question rather than a shape on a chart.
   */
  it('links answer times through to Run Explorer', () => {
    const markup = markupOf(<TrafficBody block={block(traffic())} />);
    expect(markup).toContain('href="/runs"');
    expect(markup).toContain('Answer times in Run Explorer');
    // Cost is greyed out as unfinished and Traffic is measured data. The class
    // that greys Cost is on Cost's own section, and this is the half of that
    // which a change to a shared wrapper would break.
    expect(markup).not.toContain('ops-block-unfinished');
  });

  it('keeps the range on the way to Run Explorer', () => {
    const markup = markupOf(<TrafficBody block={block(traffic())} runsHref={() => '/runs?range=30d'} />);
    expect(markup).toContain('href="/runs?range=30d"');
  });

  /**
   * A DENOMINATOR OF ZERO IS NOT A DENOMINATOR, and the tab's rule that zero
   * counts never render is why it is dropped rather than printed. "out of 0
   * runs" reads as a measurement of a quiet range; what it means is that nothing
   * ran, so there was nothing to measure and the empty chart above says nothing
   * about failures at all.
   */
  it('drops the run denominator rather than printing a zero', () => {
    const markup = render(
      <TrafficBody block={block(traffic({ failuresByCause: [], toolCalls: [], runsInRange: 0 }))} />
    );
    expect(markup).not.toContain('out of 0 runs');
    expect(markup).not.toMatch(/From 0 recorded runs/);
    // The chart still says it is empty. What it no longer does is divide by it.
    expect(markup).toContain('No failures');
    expect(markup).toContain('No tool calls');
  });

  it('keeps the range on the way to Monitoring', () => {
    // The count was counted over THIS window. Landing on Monitoring's default
    // week would show a different number for the same question.
    const markup = markupOf(
      <TrafficBody block={block(traffic())} monitoringHref={(outcome) => `/monitoring?range=30d&outcome=${outcome}`} />
    );
    expect(markup).toContain('href="/monitoring?range=30d&amp;outcome=failed"');
  });

  /**
   * The denominator is in the band, once, rather than under each of three charts.
   *
   * It is the same number for all three and it was said three times. What it may
   * never do is disappear: "No failures" with nothing to divide by is
   * indistinguishable from "nothing ran", which is why the empty chart above
   * still carries it.
   */
  it('names the run denominator once rather than under every chart', () => {
    const markup = render(<TrafficBody block={block(traffic())} />);
    expect(markup).toContain('From 50 recorded runs');
    expect(markup).not.toMatch(/out of 50 runs/);
  });

  /**
   * THE TOOL-CALLS CHART, WHICH IS THE ONE WITH SOMETHING TO SAY ON A HEALTHY
   * DEPLOYMENT.
   *
   * Its labels are prose the store recorded ("Ran a governed read-only query"),
   * not short identifiers, so what a reader needs is the whole label rather than
   * a clipped one; the full text is in the markup and the count sits beside it.
   * Truncation is a CSS concern the file header rules out asserting, so this
   * holds the content and the empty state instead.
   */
  describe('the tool-calls chart', () => {
    it('names each tool in full and prints its count', () => {
      const markup = render(
        <TrafficBody
          block={block(
            traffic({
              toolCalls: [
                { key: 'read', label: 'Ran a governed read-only query', count: 3 },
                { key: 'search', label: 'Called search_semantics', count: 15 },
              ],
            })
          )}
        />
      );
      expect(markup).toContain('Tool calls by tool');
      // The whole phrase, not a clipped one: this is the label that was being cut
      // to "Ran a governed read-only que…" before it was allowed to wrap.
      expect(markup).toContain('Ran a governed read-only query');
      expect(markup).toContain('Called search_semantics');
      expect(markup).toContain('15');
    });

    it('reads as a deliberate empty state when nothing called a tool', () => {
      // The healthy-deployment case. Two words, the same shape as the empty
      // failures and refusals charts, never a drawn bar of length zero. The
      // other horizontal charts are emptied too so the absent bar is the tools'.
      const markup = markupOf(
        <TrafficBody block={block(traffic({ toolCalls: [], failuresByCause: [], refusalsByCause: [] }))} />
      );
      expect(text(markup)).toContain('No tool calls');
      expect(markup).not.toContain('ops-bar-fill');
    });

    it('prints the bars with no standing note under them', () => {
      const populated = text(render(<TrafficBody block={block(traffic())} />));
      expect(populated).not.toContain('first sign a release changed the agent');
      expect(populated).toContain('Tool calls by tool');

      const empty = text(
        render(<TrafficBody block={block(traffic({ toolCalls: [], failuresByCause: [], refusalsByCause: [] }))} />)
      );
      expect(empty).not.toContain('first sign a release changed the agent');
      expect(empty).toContain('No tool calls');
    });
  });
});

describe('Ops cost uses complete billing days', () => {
  const at = (search: string) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/ops${search}`]}>
        <Routes>
          <Route
            element={
              <Outlet
                context={{
                  features: { benchmarkLab: false, egressControls: false, forecasting: false },
                  setFeature: () => {},
                  role: { state: 'admin', addedAdminsReadable: true },
                }}
              />
            }
          >
            <Route path="/ops" element={<OpsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

  it('renders the shared range control and no billing-window caption', () => {
    const markup = at('?range=24h&from=2026-03-02&to=2026-03-06');
    expect(markup).toContain('time-range-segments');
    expect(markup).not.toContain('ops-range-dates');
    expect(text(markup)).not.toContain('Cost billing window');
    expect(text(markup)).not.toContain('Today is excluded because billing arrives late');
  });

  it('sends validated from and to dates to cost only', () => {
    const source = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain("costParams.set('from', range.from)");
    expect(source).toContain("costParams.set('to', range.to)");
    expect(source).toContain("'/api/ops/cost',");
    expect(source).not.toContain('costEstimatesShown');
    expect(source).toContain("useOpsBlock<OpsCostPayload>('/api/ops/cost', costSearch, opsCostRangeId(params))");
    expect(source).toContain("useOpsBlock<OpsHealthPayload>('/api/ops/health', '')");
    expect(source).toContain('TimeRangeControl page="Ops cost"');
    expect(source).toContain("params.set('range', 'all')");
    expect(source).toContain("const runsHref = () => '/runs?range=all'");
    expect(source).toContain('costTileWorkspaceObject(tile)');
    expect(source).toContain('healthResourceObject(row)');
    expect(source).toContain('databricksLink(host, object)');
  });
});

/* ── Latency ─────────────────────────────────────────────────────────────── */

function latency(overrides: Partial<OpsLatencyPayload> = {}): OpsLatencyPayload {
  return {
    readAt: '2026-08-17T16:45:00Z',
    state: 'ready',
    reason: '',
    grant: null,
    table: 'a_catalog.a_schema.otel_spans',
    routes: [
      {
        route: 'POST /api/insights/ask',
        spans: 8,
        p50Ms: 85_500,
        p95Ms: null,
        p99Ms: null,
        slowestMs: 120_000,
        errorCount: 0,
        refusalCount: null,
        lastSpanAt: '2026-08-17 16:40:00',
        priorSpans: 0,
        priorP50Ms: null,
      },
      {
        route: 'GET /api/ops/cost',
        spans: 9,
        p50Ms: 8_709.2,
        p95Ms: null,
        p99Ms: null,
        slowestMs: 12_000,
        errorCount: 0,
        refusalCount: null,
        lastSpanAt: '2026-08-17 16:41:00',
        priorSpans: 5,
        priorP50Ms: 7_000,
      },
      {
        route: 'GET /api/preflight',
        spans: 26,
        p50Ms: 169.9,
        p95Ms: 430.9,
        p99Ms: 500,
        slowestMs: 600,
        errorCount: 2,
        refusalCount: null,
        lastSpanAt: '2026-08-17 16:42:00',
        priorSpans: 22,
        priorP50Ms: 100,
      },
      {
        route: 'GET /api/storage',
        spans: 818,
        p50Ms: 0.7,
        p95Ms: 1.0,
        p99Ms: 1.2,
        slowestMs: 2.0,
        errorCount: 0,
        refusalCount: null,
        lastSpanAt: '2026-08-17 16:43:00',
        priorSpans: 400,
        priorP50Ms: 0.6,
      },
    ],
    coveredFrom: '2026-08-16 19:30:59',
    coveredTo: '2026-08-17 16:43:41',
    ...overrides,
  };
}

describe('the latency block', () => {
  it('filters the rows by route text or method, without another read', () => {
    const byRoute = render(<LatencyBody block={block(latency())} initialSearch="ask" />);
    const byMethod = render(<LatencyBody block={block(latency())} initialSearch="POST" />);

    for (const rendered of [byRoute, byMethod]) {
      expect(rendered).toContain('POST /api/insights/ask');
      expect(rendered).not.toContain('GET /api/ops/cost');
      expect(rendered).not.toContain('GET /api/preflight');
    }
  });

  it('clearing the query restores every already-fetched route', () => {
    const filtered = render(<LatencyBody block={block(latency())} initialSearch="ask" />);
    const cleared = render(<LatencyBody block={block(latency())} initialSearch="" />);

    expect(filtered).not.toContain('GET /api/ops/cost');
    expect(cleared).toContain('POST /api/insights/ask');
    expect(cleared).toContain('GET /api/ops/cost');
    expect(cleared).toContain('GET /api/preflight');
    expect(cleared).toContain('GET /api/storage');
  });

  it('uses the shared search and empty-list affordances when nothing matches', () => {
    const markup = markupOf(<LatencyBody block={block(latency())} initialSearch="no-such-route" />);
    const rendered = text(markup);

    expect(markup).toContain('run-search monitoring-search ops-latency-search');
    expect(markup).toContain('monitoring-search-clear');
    expect(markup).toContain('aria-label="Clear the route search"');
    expect(rendered).toContain('Nothing matches "no-such-route".');
    expect(rendered).toContain('Clear search');
    expect(markup).not.toContain('data-testid="ops-latency"');
  });

  it('keeps route search in the header rail beside Refresh', () => {
    const markup = markupOf(<LatencyBody block={block(latency())} />);
    const header = markup.slice(markup.indexOf('ops-block-head'), markup.indexOf('ops-block-body'));

    expect(header).toContain('ops-latency-head-controls');
    expect(header).toContain('ops-latency-search');
    expect(header).toContain('ops-latency-trend-filters');
    expect(header).toContain('Within baseline');
    expect(header).toContain('Outside baseline');
    expect(header).toContain('Refresh');
  });

  it('hides the TREND pills when the table has no TREND column', () => {
    const allThin = latency({
      routes: [
        {
          route: 'POST /api/insights/ask',
          spans: 8,
          p50Ms: 85_500,
          p95Ms: null,
          p99Ms: null,
          slowestMs: 120_000,
          errorCount: 0,
          refusalCount: null,
          lastSpanAt: '2026-08-17 16:40:00',
          priorSpans: 0,
          priorP50Ms: null,
        },
      ],
    });
    const markup = markupOf(<LatencyBody block={block(allThin)} />);
    expect(markup).not.toContain('ops-latency-trend-filters');
    expect(markup).not.toMatch(/<th[^>]*>Trend<\/th>/);
  });

  it('shows every route, including a dash, when neither TREND pill is on', () => {
    const markup = markupOf(<LatencyBody block={block(latency())} />);
    const rendered = text(markup);

    expect(markup).toContain('aria-pressed="false"');
    expect(rendered).toContain('POST /api/insights/ask');
    expect(rendered).toContain('GET /api/preflight');
    expect(rendered).toContain('GET /api/storage');
    expect(rendered).toContain('Within baseline');
    expect(rendered).toContain('Slower than baseline');
  });

  it('shows only within-baseline rows when the green pill is on', () => {
    const rendered = render(<LatencyBody block={block(latency())} initialWithin />);

    expect(rendered).toContain('GET /api/storage');
    expect(rendered).toContain('Within baseline');
    expect(rendered).not.toContain('GET /api/preflight');
    expect(rendered).not.toContain('POST /api/insights/ask');
    expect(rendered).not.toContain('Slower than baseline');
  });

  it('shows only outside-baseline rows when the red pill is on', () => {
    const rendered = render(<LatencyBody block={block(latency())} initialOutside />);

    expect(rendered).toContain('GET /api/preflight');
    expect(rendered).toContain('Slower than baseline');
    expect(rendered).not.toContain('GET /api/storage');
    expect(rendered).not.toContain('POST /api/insights/ask');
  });

  it('keeps every row that has a trend when both pills are on', () => {
    const rendered = render(<LatencyBody block={block(latency())} initialWithin initialOutside />);

    expect(rendered).toContain('GET /api/storage');
    expect(rendered).toContain('GET /api/preflight');
    expect(rendered).toContain('Within baseline');
    expect(rendered).toContain('Slower than baseline');
    expect(rendered).not.toContain('POST /api/insights/ask');
    expect(rendered).not.toContain('GET /api/ops/cost');
  });

  it('uses the same empty-list escape when a TREND pill hides every row', () => {
    const onlyDashes = latency({
      routes: [
        {
          route: 'POST /api/insights/ask',
          spans: 8,
          p50Ms: 85_500,
          p95Ms: 90_000,
          p99Ms: 95_000,
          slowestMs: 120_000,
          errorCount: 0,
          refusalCount: null,
          lastSpanAt: '2026-08-17 16:40:00',
          priorSpans: 0,
          priorP50Ms: null,
        },
      ],
    });
    const markup = markupOf(<LatencyBody block={block(onlyDashes)} initialWithin />);
    const rendered = text(markup);

    expect(rendered).toContain('Nothing matches the selected trend.');
    expect(rendered).toContain('Clear filters');
    expect(markup).not.toContain('data-testid="ops-latency"');
  });

  it('shows only the header rail while the first latency read is loading', () => {
    const markup = markupOf(<LatencyBody block={block<OpsLatencyPayload>(null, { busy: true })} />);
    expect(markup).toContain('ops-latency-head-controls');
    expect(markup).not.toContain('ops-block-body');
    expect(markup).not.toContain('ops-skeleton');
  });

  it('shows no date window in its subheader', () => {
    const markup = markupOf(<LatencyBody block={block(latency())} />);
    expect(text(markup)).toContain('By route');
    expect(text(markup)).not.toContain('prior half');
    expect(text(markup)).not.toContain('Aug 16');
    expect(text(markup)).not.toContain('2026-08-16 19:30:59');
    expect(markup).not.toContain('title="2026-08-16 19:30:59 to 2026-08-17 16:43:41"');
  });

  /**
   * TEN ROUTES A PAGE, WHICH IS WHY THE BLOCK STAYS A BLOCK.
   *
   * Every route the deployment serves lands in this table, and on a live
   * deployment that is dozens: the block grew longer than the three above it put
   * together and the slow route somebody came here for was thirty rows down.
   *
   * The page count is the thing worth holding here rather than the layout. A
   * reader cannot tell by looking whether a table showing ten rows has ten rows
   * or has silently dropped the other fourteen, and dropping them is what an
   * off-by-one in the slice does.
   */
  it('shows ten routes and says which ten', () => {
    const many = Array.from({ length: 24 }, (_, i) => ({
      route: `GET /api/route-${i}`,
      spans: 100 + i,
      p50Ms: 100,
      p95Ms: 200,
      p99Ms: 250,
      slowestMs: 300,
      errorCount: 0,
      refusalCount: null,
      lastSpanAt: '2026-08-17 16:40:00',
      priorSpans: 100,
      priorP50Ms: 90,
    }));
    const rendered = render(<LatencyBody block={block(latency({ routes: many }))} />);

    expect(rendered).toContain('GET /api/route-0');
    expect(rendered).toContain('GET /api/route-9');
    expect(rendered).not.toContain('GET /api/route-10');
    // The rows on screen, and the total they are ten of.
    expect(rendered).toContain('1\u201310 of 24');
  });

  /** Controls over a single page are chrome for a decision nobody has to make. */
  it('offers no pager where every route already fits', () => {
    const markup = markupOf(<LatencyBody block={block(latency())} />);

    expect(markup).not.toContain('ops-pager');
    expect(markup).not.toContain('Next routes');
  });

  it('prints every figure it was given and invents none', () => {
    const rendered = render(<LatencyBody block={block(latency())} />);

    expect(rendered).toContain('POST /api/insights/ask');
    expect(rendered).toContain('85.5s');
    expect(rendered).toContain('8.7s');
    expect(rendered).toContain('170ms');
    // Sub-millisecond keeps its decimal rather than rounding to a bare zero,
    // which this tab does not print and which reads as nothing measured.
    expect(rendered).toContain('0.7ms');
  });

  /**
   * A 95th over eight spans is the slowest of eight wearing the name of a
   * percentile. Withheld as a mark; every substitute a reader could compare
   * against a real percentile is worse than no figure.
   */
  it('withholds the 95th below the floor and says why on the cell', () => {
    const markup = markupOf(<LatencyBody block={block(latency())} />);

    expect(markup).toContain('Withheld: 8 spans is under the 20 needed');
    expect(markup).toContain('\u2014');
    // The route that cleared the floor keeps its figure.
    expect(text(markup)).toContain('431ms');
  });

  /**
   * THIN SAMPLES ARE NOT FLAGGED, AND HIGH PERCENTILES ARE NOT FABRICATED.
   *
   * Three to eight spans is common on quieter routes. A red mark there trains
   * people to ignore red marks, and a p95 over eight is the slowest of eight
   * wearing a percentile's name. The labelled slowest stays; the verdict says
   * the sample is too thin to judge.
   */
  it('does not flag a thin-sample route or print a fabricated percentile', () => {
    const markup = markupOf(<LatencyBody block={block(latency())} />);
    const rendered = text(markup);

    // Ask is thin (8 spans): high percentiles withheld, slowest still labelled,
    // and the trend cell is a withheld mark rather than a flag.
    expect(markup).toMatch(/Withheld: 8 spans is under the 20 needed/);
    expect(rendered).toContain('2m 00s');
    // The thin ask row is not the one wearing the slower pill; preflight is.
    expect(rendered).toContain('Slower than baseline');
    expect(markup).toContain('ops-lat-trend');
    // The thin row carries no fabricated verdict word.
    expect(markup).toMatch(/Needs 20 requests in each all-time half/);
  });

  /**
   * ERRORS AND REFUSALS ARE NOT NARRATED ABOVE THE TABLE. The compact grid has
   * no error or refusal column, and the shared-facts strip no longer restates
   * those absences as copy.
   */
  it('does not narrate errors or refusals above the grid', () => {
    const rendered = render(<LatencyBody block={block(latency())} />);

    expect(rendered).not.toContain('error responses recorded across these routes');
    expect(rendered).not.toContain('Refusals are not reported');
    expect(rendered).not.toMatch(/2 errors? and \d+ refus/i);
    const markup = markupOf(<LatencyBody block={block(latency())} />);
    expect(markup).not.toMatch(/<th[^>]*>Errors<\/th>/);
    expect(markup).not.toMatch(/<th[^>]*>Refusals<\/th>/);
  });

  it('removes empty percentile columns without adding a second header row', () => {
    const allThin = latency({
      routes: [
        {
          route: 'POST /api/insights/ask',
          spans: 8,
          p50Ms: 85_500,
          p95Ms: null,
          p99Ms: null,
          slowestMs: 120_000,
          errorCount: 0,
          refusalCount: null,
          lastSpanAt: '2026-08-17 16:40:00',
          priorSpans: 0,
          priorP50Ms: null,
        },
        {
          route: 'GET /api/ops/cost',
          spans: 9,
          p50Ms: 65,
          p95Ms: null,
          p99Ms: null,
          slowestMs: 400,
          errorCount: 0,
          refusalCount: null,
          lastSpanAt: '2026-08-17 16:41:00',
          priorSpans: 5,
          priorP50Ms: 60,
        },
      ],
    });
    const markup = markupOf(<LatencyBody block={block(allThin)} />);
    const rendered = text(markup);

    expect(rendered).not.toContain('Every route is under 20 recorded requests');
    expect(markup).toContain('ops-block-body ops-block-body-flush');
    expect(rendered).not.toContain('No error responses recorded');
    expect(rendered).not.toContain('Refusals are not reported');
    // The columns are gone, not merely blank.
    expect(markup).not.toMatch(/<th[^>]*>p95<\/th>/);
    expect(markup).not.toMatch(/<th[^>]*>Trend<\/th>/);
    // The p50 log-scale column and its bar are still there.
    expect(markup).toContain('ops-lat-bar-fill');
    expect(rendered).toContain('P50 · log scale');
  });

  it('produces no slower verdict when there is no prior period', () => {
    const alone = latency({
      routes: [
        {
          route: 'POST /api/access-verification',
          spans: 40,
          p50Ms: 11_600,
          p95Ms: 20_000,
          p99Ms: 25_000,
          slowestMs: 30_000,
          errorCount: 0,
          refusalCount: null,
          lastSpanAt: '2026-08-17 16:40:00',
          priorSpans: 0,
          priorP50Ms: null,
        },
      ],
    });
    const markup = markupOf(<LatencyBody block={block(alone)} />);
    const rendered = text(markup);

    // No prior half means no verdict: the trend cell is withheld, not a flag.
    // The header pills name the two verdicts; the row itself must not wear either.
    expect(rendered).not.toContain('Slower than baseline');
    expect(markup).not.toMatch(/ops-lat-trend[\s\S]*?Within baseline/);
  });

  it('flags a route that cleared both floors and rose against its own baseline', () => {
    const rendered = render(<LatencyBody block={block(latency())} />);

    // preflight: 26 vs 22 spans, 169.9 vs 100 ms → slower.
    expect(rendered).toContain('Slower than baseline');
    // storage: 0.7 vs 0.6 is within its baseline.
    expect(rendered).toContain('Within baseline');
  });

  it('prints p99 and the slowest alongside p50 and p95', () => {
    const rendered = render(<LatencyBody block={block(latency())} />);

    expect(rendered).toContain('p99');
    expect(rendered).toContain('Slowest');
    expect(rendered).toContain('500ms');
  });

  it('prints what Databricks said when the read failed, and hardcodes no figures', () => {
    const rendered = render(
      <LatencyBody
        block={block(
          latency({
            state: 'unreadable',
            routes: [],
            coveredFrom: '',
            coveredTo: '',
            reason: 'a_table could not be read. Databricks said: TABLE_OR_VIEW_NOT_FOUND',
          })
        )}
      />
    );

    expect(rendered).toContain('Latency could not be read');
    expect(rendered).toContain('TABLE_OR_VIEW_NOT_FOUND');
    expect(rendered).not.toContain('p50');
  });

  it('offers the statement that fixes a missing grant', () => {
    const rendered = render(
      <LatencyBody
        block={block(
          latency({
            state: 'no-grant',
            routes: [],
            reason: 'you do not have SELECT on a_catalog.a_schema.',
            grant: {
              object: 'a_catalog.a_schema',
              privilege: 'SELECT',
              statement: 'GRANT SELECT ON SCHEMA a_catalog.a_schema TO `someone@example.com`',
            },
          })
        )}
      />
    );

    expect(rendered).toContain('GRANT SELECT ON SCHEMA a_catalog.a_schema');
  });

  /**
   * The design's central claim, held for the fourth block as it is for the other
   * three: a warehouse that will not answer this must leave the rest standing.
   */
  it('fails on its own without taking the other blocks with it', () => {
    const rendered = render(<LatencyBody block={block<OpsLatencyPayload>(null, { failed: 'the read timed out' })} />);

    expect(rendered).toContain('Latency could not be read');
    expect(rendered).toContain('the read timed out');
  });

  /** Figures only. The tab's rule, and the reason there is one qualifier. */
  it('adds no explanatory prose under the heading', () => {
    const rendered = render(<LatencyBody block={block(latency())} />);

    for (const prose of ['percentile is', 'This block', 'measures the', 'Note that']) {
      expect(rendered).not.toContain(prose);
    }
  });
});
