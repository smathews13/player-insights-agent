import { describe, expect, it, vi } from 'vitest';
import type { ResourceTagSummary } from './resource-tagging';
import {
  CLEAR_RESOURCE_TAG_RESULT,
  RESOURCE_TAG_RESULT_MAX_BYTES,
  clearResourceTagResult,
  readResourceTagResult,
  writeResourceTagResult,
} from './resource-tag-state';
import type { LakebaseReader } from './lakebase-store';

const summary: ResourceTagSummary = {
  headline: '1 of 1 supported resources tagged',
  supportedTotal: 1,
  supportedCovered: 1,
  tagged: 1,
  alreadyCorrect: 0,
  supportedFailed: 0,
  permissionRequired: 0,
  unsupported: 0,
  notApplicable: 0,
  updatedAt: '2026-09-02T00:00:00.000Z',
  results: [
    {
      kind: 'sql-warehouse',
      name: 'warehouse',
      label: 'SQL warehouse · warehouse',
      support: 'supported',
      billingAttribution: true,
      status: 'tagged',
      detail: 'Applied system_billing=player-insights-agent.',
      nextAction: '',
    },
  ],
};

function store(query: LakebaseReader['lakebase']['query']): LakebaseReader {
  return { lakebase: { query } };
}

describe('durable Resource Tags result', () => {
  it('writes one bounded replacement row and reads it after a simulated reload', async () => {
    let saved = '';
    const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(
      (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO')) {
          saved = typeof params?.[1] === 'string' ? params[1] : '';
          return Promise.resolve({ rows: [{ resource_id: 'resource-tags-current-result' }] });
        }
        return Promise.resolve({ rows: [{ value: saved }] });
      }
    );
    const database = store(query);
    await writeResourceTagResult(database, summary, 'admin@example.com');
    expect(await readResourceTagResult(database)).toEqual(summary);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO'))).toHaveLength(1);
  });

  it('rejects an unbounded result instead of storing upstream payloads forever', async () => {
    const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>();
    const oversized = {
      ...summary,
      results: [{ ...summary.results[0], technicalDetail: 'x'.repeat(RESOURCE_TAG_RESULT_MAX_BYTES) }],
    };
    await expect(writeResourceTagResult(store(query), oversized, 'admin@example.com')).rejects.toThrow(
      'storage budget'
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('clears result and writes the minimal audit in one transactional statement', async () => {
    const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(() =>
      Promise.resolve({ rows: [{ removed: true, audited: true }] })
    );
    expect(await clearResourceTagResult(store(query), 'admin@example.com')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(CLEAR_RESOURCE_TAG_RESULT);
    expect(CLEAR_RESOURCE_TAG_RESULT).toContain("'resource-tags-cleared'");
    expect(CLEAR_RESOURCE_TAG_RESULT).toContain('Applied Databricks tags were not removed');
  });

  it('a failed clear commits neither delete nor audit through the single statement', async () => {
    const query = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(() =>
      Promise.reject(new Error('transaction failed'))
    );
    await expect(clearResourceTagResult(store(query), 'admin@example.com')).rejects.toThrow('transaction failed');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('drops malformed or oversized saved state without exposing it', async () => {
    const malformed = store(
      vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(() =>
        Promise.resolve({ rows: [{ value: '{"token":"secret"}' }] })
      )
    );
    expect(await readResourceTagResult(malformed)).toBeNull();
    const oversized = store(
      vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(() =>
        Promise.resolve({ rows: [{ value: 'x'.repeat(RESOURCE_TAG_RESULT_MAX_BYTES + 1) }] })
      )
    );
    expect(await readResourceTagResult(oversized)).toBeNull();
  });

  it('strips unknown secret-shaped fields from an otherwise valid stored result', async () => {
    const value = JSON.stringify({
      ...summary,
      authorization: 'Bearer secret',
      results: [{ ...summary.results[0], accessToken: 'secret' }],
    });
    const database = store(
      vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>(() =>
        Promise.resolve({ rows: [{ value }] })
      )
    );
    const read = await readResourceTagResult(database);
    expect(read).toEqual(summary);
    expect(read).not.toHaveProperty('authorization');
    expect(read?.results[0]).not.toHaveProperty('accessToken');
  });
});
