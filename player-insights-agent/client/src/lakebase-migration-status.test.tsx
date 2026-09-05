import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LakebaseMigrationReadiness } from '../../shared/lakebase-migrations';
import { connectedResource } from '../../shared/deployment-config';
import { ConnectionRow, opensForLakebaseMigration } from './ConnectionsPage';
import { readConnection, type ResourceRow } from './connection-model';
import { LakebaseMigrationPanel } from './LakebaseMigrationPanel';
import {
  applyLakebaseMigrations,
  checkLakebaseMigrationStatus,
  claimLakebaseMigrationCheck,
  recallLakebaseMigrationStatus,
  resetLakebaseMigrationStatus,
} from './lakebase-migration-status';
import { autoLoadClaimed, claimAutoLoad, forgetMonitoringSession } from './monitoring-session';
import {
  cacheUserSpendTotal,
  cachedUserSpendTotal,
  clearUserSpendTotalCache,
  type UserSpendTotalCoordinates,
} from './user-spend-total-cache';

function readiness(overrides: Partial<LakebaseMigrationReadiness> = {}): LakebaseMigrationReadiness {
  return {
    schema: 'player_insights',
    currentVersion: 30,
    targetVersion: 36,
    pendingCount: 6,
    pending: [
      { version: 31, name: 'daily user spend read model' },
      { version: 32, name: 'hourly user spend read model' },
      { version: 33, name: 'canonical feedback sentiment' },
      { version: 34, name: 'user spend token coverage' },
      { version: 35, name: 'traffic run outcome totals' },
      { version: 36, name: 'service principal connection evidence' },
    ],
    status: 'update_required',
    canApply: true,
    checkedAt: '2026-09-03T20:00:00.000Z',
    detail: 'User spend tables and other app storage updates are pending.',
    action: 'Update Lakebase from this app.',
    ...overrides,
  };
}

function response(body: LakebaseMigrationReadiness): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

beforeEach(() => {
  resetLakebaseMigrationStatus();
  forgetMonitoringSession();
  clearUserSpendTotalCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the session migration check', () => {
  it('is claimed once and shares one status request', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(readiness())));
    vi.stubGlobal('fetch', fetcher);

    expect(claimLakebaseMigrationCheck()).toBe(true);
    expect(claimLakebaseMigrationCheck()).toBe(false);
    await Promise.all([checkLakebaseMigrationStatus(), checkLakebaseMigrationStatus()]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/admin/lakebase/migrations',
      expect.objectContaining({ credentials: 'same-origin' })
    );
    expect(recallLakebaseMigrationStatus()).toMatchObject({
      phase: 'ready',
      value: { status: 'update_required' },
    });
  });

  it('fences a late GET behind the one-click POST and invalidates spend views once', async () => {
    let resolveGet!: (value: Response) => void;
    const get = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });
    const fetcher = vi.fn((path: RequestInfo | URL, _init?: RequestInit) =>
      (typeof path === 'string' ? path : path instanceof URL ? path.href : path.url).endsWith('/apply')
        ? Promise.resolve(
            response(
              readiness({
                currentVersion: 36,
                pendingCount: 0,
                pending: [],
                status: 'up_to_date',
                canApply: false,
                detail: 'Schema v36.',
                action: '',
                appliedCount: 6,
              })
            )
          )
        : get
    );
    vi.stubGlobal('fetch', fetcher);

    const coordinates: UserSpendTotalCoordinates = {
      scope: 'admin@example.test|session-1',
      email: 'person@example.test',
      from: '2026-08-01',
      to: '2026-09-01',
      unit: 'USD',
    };
    cacheUserSpendTotal(coordinates, {
      amount: 3,
      quality: 'allocated',
      questions: 1,
      coveredDays: 1,
      currency: 'USD',
      profile: null,
      dataRevision: 1,
      snapshot: '2026-09-03T20:00:00Z|daily',
      seeded: false,
      complete: true,
    });
    claimAutoLoad('30d');

    const stale = checkLakebaseMigrationStatus();
    await applyLakebaseMigrations();
    resolveGet(response(readiness()));
    await stale;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    expect(recallLakebaseMigrationStatus()).toMatchObject({
      phase: 'ready',
      value: { status: 'up_to_date', appliedCount: 6 },
    });
    expect(autoLoadClaimed('30d')).toBe(false);
    expect(cachedUserSpendTotal(coordinates)).toBeNull();
  });

  it('coalesces double clicks and leaves the behind state retryable on failure', async () => {
    let resolveApply!: (value: Response) => void;
    const applying = new Promise<Response>((resolve) => {
      resolveApply = resolve;
    });
    const fetcher = vi.fn(() => applying);
    vi.stubGlobal('fetch', fetcher);

    const first = applyLakebaseMigrations();
    const second = applyLakebaseMigrations();
    resolveApply(
      response(
        readiness({
          status: 'blocked',
          canApply: true,
          detail: 'Lakebase stopped at the first update it could not complete. Existing data was preserved.',
          action: 'Retry the update.',
          appliedCount: 0,
        })
      )
    );

    expect(await first).toMatchObject({ value: { status: 'blocked', canApply: true } });
    expect(await second).toMatchObject({ value: { status: 'blocked', canApply: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('the Connections Lakebase migration detail', () => {
  it('uses the exact required, loading, success, and concise failure copy', () => {
    const required = text(
      renderToStaticMarkup(
        <LakebaseMigrationPanel state={{ phase: 'ready', value: readiness(), error: '' }} onApply={() => undefined} />
      )
    );
    expect(required).toContain('Lakebase update required');
    expect(required).toContain('User spend tables and other app storage updates are pending.');
    expect(required).toContain('Update Lakebase');

    const loading = renderToStaticMarkup(
      <LakebaseMigrationPanel state={{ phase: 'applying', value: readiness(), error: '' }} onApply={() => undefined} />
    );
    expect(text(loading)).toContain('Updating Lakebase');
    expect(loading).toContain('disabled=""');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('data-busy="true"');
    expect(loading).toContain('pia-loader-mark--button');
    expect(loading).toContain('width="16"');
    expect(loading).toContain('<span class="sr-only">Update Lakebase</span>');

    const success = text(
      renderToStaticMarkup(
        <LakebaseMigrationPanel
          state={{
            phase: 'ready',
            value: readiness({
              currentVersion: 36,
              pendingCount: 0,
              pending: [],
              status: 'up_to_date',
              canApply: false,
              detail: 'Schema v36.',
              action: '',
              appliedCount: 6,
            }),
            error: '',
          }}
          onApply={() => undefined}
        />
      )
    );
    expect(success).toContain('Lakebase updated');
    expect(success).toContain('Up to date');
    expect(success).toContain('Schema v36');

    const failure = text(
      renderToStaticMarkup(
        <LakebaseMigrationPanel
          state={{
            phase: 'ready',
            value: readiness({
              status: 'blocked',
              canApply: true,
              detail: 'Existing data was preserved.',
              appliedCount: 0,
            }),
            error: '',
          }}
          onApply={() => undefined}
        />
      )
    );
    expect(failure).toContain('Lakebase was not updated');
    expect(failure).not.toMatch(/SELECT|password|credential/i);
    expect(failure).toContain('Update Lakebase');
  });

  it('keeps schema status admin-only and separate from Connected', () => {
    expect(opensForLakebaseMigration({ phase: 'ready', value: readiness(), error: '' })).toBe(true);
    expect(
      opensForLakebaseMigration({
        phase: 'ready',
        value: readiness({ status: 'up_to_date', pendingCount: 0, pending: [] }),
        error: '',
      })
    ).toBe(false);

    const resource = connectedResource('lakebase');
    if (!resource) throw new Error('The Lakebase connection is missing from the resource registry.');
    const row: ResourceRow = {
      resource,
      configured: 'projects/example/branches/main/databases/app',
      configuredFrom: 'app',
      actual: 'projects/example/branches/main/databases/app',
      actualObserved: true,
      intended: null,
      intendedAt: '',
      intendedBy: '',
      editable: false,
      changedByLabel: '',
      changedByNote: '',
    };
    const reading = readConnection({
      row,
      check: {
        id: 'lakebase-storage',
        kind: 'lakebase',
        name: 'projects/example/branches/main/databases/app',
        label: 'Lakebase',
        status: 'ok',
        detail: 'The app storage connection answered.',
        checked_with: 'app service principal',
        duration_ms: 1,
        error: '',
        remedy: null,
      },
      findings: [],
    });
    const base = {
      reading,
      tone: 'reachable' as const,
      saving: false,
      refreshing: false,
      requested: true,
      onSave: () => Promise.resolve(true),
      onClear: () => Promise.resolve(),
    };

    const consumer = text(renderToStaticMarkup(<ConnectionRow {...base} allowMutations={false} />));
    expect(consumer).not.toContain('Lakebase update required');

    const admin = text(
      renderToStaticMarkup(
        <ConnectionRow
          {...base}
          allowMutations
          lakebaseMigration={{ state: { phase: 'ready', value: readiness(), error: '' }, apply: () => undefined }}
        />
      )
    );
    expect(admin).toContain('Lakebase update required');
    expect(admin).toContain('Connected');
    expect(admin).toContain('Update Lakebase');
  });
});
