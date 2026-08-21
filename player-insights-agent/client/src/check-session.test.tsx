/**
 * That the Architecture tab stops forgetting what it checked, and does not lie
 * about when it checked it.
 *
 * WHAT WAS WRONG. The settings payload and the preflight report lived in the
 * page's own `useState`. Both are behind Refresh because each invokes the
 * serving endpoint, so they are expensive and deliberately never run on load.
 * Navigating away unmounted the page and took them with it, so coming back gave
 * every dependency `Not checked`, em-dashes in the tile strip, no index-age
 * pill, and "Not read yet" beside the button -- identical to a deployment
 * nobody had ever checked. The results were not slow to reproduce; it was
 * invisible that they needed reproducing.
 *
 * THE SECOND HALF IS THE HARDER ONE. A cache that restored the results and
 * re-stamped the clock would be worse than the defect: the page would say a
 * check had just run when nothing had run at all, and a reader would trust a
 * verdict about a deployment that may have changed hours ago. So the timestamp
 * is not remembered. It is read out of the payloads, where the SERVER recorded
 * it, and there is no field in the store that could be re-stamped. The
 * assertions below are mostly about that.
 *
 * The page is rendered rather than inspected, because the defect was a
 * relationship between a store, a mount and a header control and no one file
 * could see it. `renderToStaticMarkup` runs no effects, which is the state the
 * page opens in and the state this is about.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { ArchitecturePage } from './ArchitecturePage';
import {
  checkedAtOf,
  forgetChecks,
  recallChecks,
  rememberChecks,
  type CheckSession,
} from './check-session';
import { connectedResource } from '../../shared/deployment-config';
import type { SettingsPayload } from './connection-model';
import type { PreflightCheck, PreflightReport } from './preflight';

const PAGE_SOURCE = readFileSync(fileURLToPath(new URL('./ArchitecturePage.tsx', import.meta.url)), 'utf8');
const CONNECTIONS_SOURCE = readFileSync(fileURLToPath(new URL('./ConnectionsPage.tsx', import.meta.url)), 'utf8');
const SESSION_SOURCE = readFileSync(fileURLToPath(new URL('./check-session.ts', import.meta.url)), 'utf8');
/** Comments stripped, so prose about a call is not read as the call. */
const PAGE = PAGE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/** A time far enough back to be beyond every rounding boundary in play. */
const WHEN = '2026-08-16T01:00:00.000Z';

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    resource: connectedResource(id)!,
    configured: '',
    configuredFrom: 'artifact',
    actual: '',
    actualObserved: false,
    intended: null,
    intendedAt: '',
    intendedBy: '',
    editable: false,
    changedByLabel: '',
    changedByNote: '',
    ...over,
  } as SettingsPayload['resources'][number];
}

function check(id: string, status: PreflightCheck['status'], name = ''): PreflightCheck {
  return { id, label: id, status, name, detail: '', error: '', kind: 'dependency' } as unknown as PreflightCheck;
}

/** One completed run of the checks, as the two routes would have answered it. */
function ranAt(checkedAt = WHEN): CheckSession {
  const settings: SettingsPayload = {
    resources: [
      row('agent-endpoint', { configured: 'an-endpoint', actual: 'an-endpoint', actualObserved: true }),
      row('sql-warehouse', { configured: 'a-warehouse', actual: 'a-warehouse', actualObserved: true }),
      row('genie-data', { configured: 'a-space' }),
      row('catalog', { configured: 'a_catalog' }),
      row('lakebase', { configured: 'a-branch' }),
    ],
    drift: [],
    status: 'ok',
    appBuildSha: '',
    modelBuildSha: '',
    orchestratorReported: true,
    storeAvailable: true,
    checkedAt,
  } as unknown as SettingsPayload;
  const report = {
    checked_at: checkedAt,
    status: 'ok',
    principal: 'someone',
    principal_resolved: true,
    table_source: '',
    checks: [
      check('agent-endpoint', 'ok', 'an-endpoint'),
      check('sql-warehouse', 'ok', 'a-warehouse'),
      check('genie-data', 'ok', 'a-space'),
    ],
    assumptions: [],
    counts: { ok: 3, failed: 0, unverified: 0 },
    source: 'agent',
  } as unknown as PreflightReport;
  return { settings, report, error: '' };
}

function pageMarkup(): string {
  return renderToStaticMarkup(<MemoryRouter>
      <ArchitecturePage />
    </MemoryRouter>
  );
}

/** The text a reader sees, tags removed and entities put back. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

beforeEach(() => {
  forgetChecks();
});

describe('opening the tab having never checked anything', () => {
  it('still says Not checked rather than inventing a clean bill of health', () => {
    // The store being empty is a real state and must not read as a passing one.
    // Every honesty rule this page has depends on it.
    expect(recallChecks()).toBeNull();
    const shown = text(pageMarkup());
    expect(shown).toContain('Not read yet');
    expect(shown).not.toContain('These are the results of the last check');
  });

  /**
   * THIS USED TO ASSERT THAT NOTHING WAS PROBED ON LOAD, and that requirement is
   * gone rather than relaxed. The page opened on `Not checked` down its whole
   * length, which the person it was built for read as broken -- twice. The cost
   * argument for gating the probes was right; the conclusion that a reader should
   * therefore find an unchecked page was not.
   *
   * What survives is the part that was actually load-bearing: THE EXPENSIVE PAIR IS
   * SOMEBODY ELSE'S DECISION. Restoring is still not the same as re-running -- that
   * is now enforced by the latch in this module, exercised for real in
   * session-checks.test.ts, rather than by reading this page's source.
   *
   * IT USED TO ASSERT THE PAGE OWNED EXACTLY ONE FETCH, which was a proxy for the
   * real rule and stopped being one: the loop-bounds strip above the diagram reads
   * the app's own stored settings row, which costs no round trip to the workspace
   * and is the same kind of read `/api/architecture` is. Naming the two forbidden
   * paths says what the rule is rather than counting, so a third cheap read does
   * not have to argue with this test.
   */
  it('leaves the expensive pair to the session and keeps only cheap reads', () => {
    const fetches = [...PAGE.matchAll(/fetchWithTimeout\('([^']+)'/g)].map((match) => match[1]);
    expect(fetches).toContain('/api/architecture');
    expect(fetches).not.toContain('/api/settings');
    expect(fetches).not.toContain('/api/preflight');
    expect(PAGE).toContain('useSessionChecks()');
  });
});

describe('coming back to the tab after the checks have run', () => {
  it('draws the results again instead of resetting to Not checked', () => {
    // The defect, stated as plainly as it can be. Unmounting the page no longer
    // throws the run away.
    rememberChecks(ranAt());
    const shown = text(pageMarkup());
    expect(shown).not.toContain('Not read yet');
    expect(shown).toContain('Reachable');
  });

  it('restores the tile strip, which is the other half a reader notices', () => {
    // "Reachable 3" rather than the em-dash the strip falls back to when nothing
    // has been checked. A restored page that redrew the cards and not the tiles
    // would be a page disagreeing with itself.
    rememberChecks(ranAt());
    const markup = pageMarkup();
    const tiles = markup.match(/data-testid="architecture-tiles"[\s\S]*?<\/ul>/)?.[0] ?? '';
    expect(tiles, 'the page still draws a tile strip').not.toEqual('');
    expect(tiles).not.toContain('\u2014');
  });

  it('keeps the readings behind one store, so the page cannot half-restore', () => {
    // The settings payload and the report are remembered as ONE object. Two
    // stores could be restored singly, and a page holding this run's statuses
    // against the last run's configuration would report drift that does not
    // exist.
    const session = ranAt();
    rememberChecks(session);
    expect(recallChecks()).toBe(session);
  });
});

describe('a restored view does not backdate its timestamp to when the tab was reopened', () => {
  it('reads the time out of the payloads, where the server put it', () => {
    expect(checkedAtOf(ranAt())).toBe(WHEN);
  });

  it('prefers the settings stamp and falls back to the report, as Connections does', () => {
    // One run cannot be given two times by two pages.
    const session = ranAt();
    expect(checkedAtOf({ ...session, settings: null })).toBe(WHEN);
    expect(checkedAtOf({ settings: null, report: null, error: '' })).toBe('');
    expect(checkedAtOf(null)).toBe('');
  });

  it('has no remembered timestamp that a reopen could re-stamp', () => {
    // Structural, and the point of the design. There is no clock field in the
    // stored shape, so no code path exists that could write "now" into it on the
    // way back in. A test of a rendered time would pass on the day it was
    // written and say nothing about the field that made the bug possible.
    const stored = Object.keys(ranAt()).sort();
    expect(stored).toEqual(['error', 'report', 'settings']);
  });

  it('no longer stamps the page clock when a check finishes either', () => {
    // It was `new Date().toISOString()`, recorded when the two fetches returned
    // rather than when the workspace was asked. Wrong before any of this, and
    // the shape that made a truthful restore impossible.
    expect(PAGE).not.toMatch(/setCheckedAt|new Date\(\)\.toISOString\(\)/);
    expect(PAGE).toContain('checkedAtOf(session)');
  });
});

describe('restored checks use only the header freshness control', () => {
  it('renders no narrative banner under Architecture', () => {
    rememberChecks(ranAt());
    const shown = text(pageMarkup());
    expect(shown).toContain('Read');
    expect(shown).not.toContain('These are the results of the last check');
    expect(shown).not.toContain('Nothing has been re-checked');
    expect(shown).not.toContain('Refresh to ask again');
  });

  it('keeps the same banner family out of both deployment panes', () => {
    for (const source of [PAGE_SOURCE, CONNECTIONS_SOURCE, SESSION_SOURCE]) {
      expect(source).not.toContain('These are the results of the last check');
      expect(source).not.toContain('Nothing has been re-checked');
      expect(source).not.toContain('That check is over an hour old');
      expect(source).not.toContain('Refresh to ask again');
    }
    expect(PAGE_SOURCE).not.toContain('architecture-restored');
    expect(CONNECTIONS_SOURCE).not.toContain('connections-restored');
  });
});

describe('the store outlives a route change and nothing else', () => {
  it('is not written to storage that outlives the running app', () => {
    // Results that outlive the build they were taken against can describe a
    // deployment that no longer exists -- after a redeploy most of all, which is
    // exactly when somebody opens this page.
    const source = readFileSync(fileURLToPath(new URL('./check-session.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(source).not.toMatch(/sessionStorage|localStorage|document\.cookie/);
  });

  it('can be emptied, so one test cannot seed the next', () => {
    rememberChecks(ranAt());
    forgetChecks();
    expect(recallChecks()).toBeNull();
  });
});
