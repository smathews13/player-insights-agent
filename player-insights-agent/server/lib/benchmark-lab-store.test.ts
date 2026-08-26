import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import { EMPTY_LAB_STATE } from '../../shared/benchmark-lab-v3';
import {
  BENCHMARK_LAB_TABLE,
  forgetLabState,
  patchLabState,
  readLabState,
  writeLabState,
} from './benchmark-lab-store';

function client(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('benchmark lab persistence', () => {
  it('qualifies the table with APP_SCHEMA', () => {
    expect(BENCHMARK_LAB_TABLE).toBe(`${APP_SCHEMA}.benchmark_lab`);
    const source = fs.readFileSync(path.join(__dirname, 'benchmark-lab-store.ts'), 'utf8');
    expect(source).toContain("appTable('benchmark_lab')");
  });

  it('reads empty state when nothing has been saved', async () => {
    forgetLabState();
    expect(await readLabState(client() as never, { maxAgeMs: 0 })).toEqual(EMPTY_LAB_STATE);
  });

  it('writes contract fields without inventing a Review App URL', async () => {
    const writer = client();
    await writeLabState(
      writer as never,
      {
        ...EMPTY_LAB_STATE,
        contract: {
          ...EMPTY_LAB_STATE.contract,
          candidateRunId: 'run_057',
          approver: 'approver@example.com',
        },
      },
      'admin@example.com'
    );
    expect(writer.calls[0]?.values?.[2]).toBe('admin@example.com');
    const saved = JSON.parse(String(writer.calls[0]?.values?.[1]));
    expect(saved.contract.candidateRunId).toBe('run_057');
    expect(JSON.stringify(saved)).not.toMatch(/https:\/\/example\.com/);
  });

  it('patches apply history onto the stored state', async () => {
    forgetLabState();
    const reader = client([{ state: EMPTY_LAB_STATE }]);
    const patched = await patchLabState(
      reader as never,
      { currentVersionId: 'ds_v001' },
      'admin@example.com'
    );
    expect(patched.currentVersionId).toBe('ds_v001');
  });
});
