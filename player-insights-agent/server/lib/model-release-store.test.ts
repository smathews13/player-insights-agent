import { describe, expect, it } from 'vitest';
import { claimModelRelease, completeModelRelease, createModelRelease } from './model-release-store';
import type { LakebaseReader } from './lakebase-store';

function fakeStore() {
  let row: Record<string, unknown> | null = null;
  const query = (sql: string, values: unknown[] = []) => {
    if (/^INSERT INTO/i.test(sql.trim())) {
      row = {
        id: values[0],
        status: 'approved',
        requested_by: values[1],
        requested_at: new Date('2026-08-18T00:00:00Z'),
        declaration: JSON.parse(String(values[2])),
        declaration_revision: values[3],
        target: values[4],
        endpoint_name: values[5],
        model_name: values[6],
        v_from: values[7],
        v_to: null,
        preflight_at_request: typeof values[8] === 'string' ? JSON.parse(values[8]) : null,
        preflight_result: null,
        started_at: null,
        completed_at: null,
        execution_id: null,
        claimed_by: null,
        completed_by: null,
        error_summary: null,
      };
      return Promise.resolve({ rows: [row] });
    }
    if (/SET status = 'running'/i.test(sql) && row?.status === 'approved') {
      row = {
        ...row,
        status: 'running',
        execution_id: values[1],
        claimed_by: values[2],
        started_at: new Date('2026-08-18T00:01:00Z'),
      };
      return Promise.resolve({ rows: [row] });
    }
    if (/SET status = \$3/i.test(sql) && row?.status === 'running' && row.execution_id === values[1]) {
      row = {
        ...row,
        status: values[2],
        v_to: values[3],
        preflight_result: typeof values[4] === 'string' ? JSON.parse(values[4]) : null,
        error_summary: values[5],
        completed_by: values[6],
        completed_at: new Date('2026-08-18T00:02:00Z'),
      };
      return Promise.resolve({ rows: [row] });
    }
    if (/^UPDATE/i.test(sql.trim())) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: row && row.id === values[0] ? [row] : [] });
  };
  const store = { lakebase: { query } } as unknown as LakebaseReader;
  return { store, row: () => row };
}

const declaration = {
  source: 'connections-apply' as const,
  revision: 'sha256:abc',
  settings: { warehouse_id: 'wh-1' },
};

describe('model release request lifecycle', () => {
  it('keeps the approved declaration immutable through atomic transitions', async () => {
    const fake = fakeStore();
    const created = await createModelRelease(fake.store, {
      id: 'request-1',
      requestedBy: 'admin@example.com',
      declaration,
      target: 'customer',
      endpointName: 'agent-endpoint',
      modelName: 'catalog.schema.agent',
      vFrom: '9',
      preflightAtRequest: {
        status: 'ok',
        checkedAt: '2026-08-18T00:00:00Z',
        ok: 3,
        failed: 0,
        unverified: 0,
      },
    });
    expect(created.status).toBe('approved');
    expect(created.requestedBy).toBe('admin@example.com');

    const first = await claimModelRelease(fake.store, 'request-1', 'execution-a', 'admin@example.com');
    const retry = await claimModelRelease(fake.store, 'request-1', 'execution-a', 'admin@example.com');
    const competitor = await claimModelRelease(fake.store, 'request-1', 'execution-b', 'admin@example.com');
    expect(first.claimed).toBe(true);
    expect(retry.claimed).toBe(true);
    expect(competitor.claimed).toBe(false);

    const completed = await completeModelRelease(fake.store, 'request-1', 'admin@example.com', {
      executionId: 'execution-a',
      status: 'succeeded',
      vTo: '10',
      preflight: {
        status: 'ok',
        checkedAt: '2026-08-18T00:02:00Z',
        ok: 4,
        failed: 0,
        unverified: 0,
      },
    });
    const terminalRetry = await completeModelRelease(fake.store, 'request-1', 'admin@example.com', {
      executionId: 'execution-a',
      status: 'succeeded',
      vTo: '10',
    });
    expect(completed.updated).toBe(true);
    expect(terminalRetry.updated).toBe(true);
    expect(completed.release?.vFrom).toBe('9');
    expect(completed.release?.vTo).toBe('10');
    expect(completed.release?.preflightResult?.status).toBe('ok');
    expect(fake.row()?.declaration).toEqual(declaration);
  });

  it('bounds a failed release error in the persistence layer', async () => {
    const fake = fakeStore();
    await createModelRelease(fake.store, {
      id: 'request-2',
      requestedBy: 'admin@example.com',
      declaration,
      target: 'customer',
      endpointName: '',
      modelName: '',
      vFrom: null,
      preflightAtRequest: null,
    });
    await claimModelRelease(fake.store, 'request-2', 'execution-a', 'admin@example.com');
    const failed = await completeModelRelease(fake.store, 'request-2', 'admin@example.com', {
      executionId: 'execution-a',
      status: 'failed',
      errorSummary: 'x'.repeat(5000),
    });
    expect(failed.release?.errorSummary).toHaveLength(1000);
  });
});
