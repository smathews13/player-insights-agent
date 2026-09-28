import { describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_RUN_REPAIR_CANDIDATES,
  DOCUMENT_RUN_REPAIR_REMAINING,
  DOCUMENT_TRACE_MISSING_SQL,
  repairHistoricalDocumentRuns,
} from './document-run-repair';

function stage(id: string, status = 'complete') {
  return {
    id,
    name: id,
    kind: id === 'orchestrator' ? 'agent' : 'tool',
    start: 0,
    duration: id === 'orchestrator' ? 10_000 : 4_000,
    status,
    calls: 1,
    depth: id === 'orchestrator' ? 0 : 1,
    parent_id: id === 'orchestrator' ? '' : 'orchestrator',
  };
}

describe('historical document run repair', () => {
  it('treats an empty trace object as missing evidence', () => {
    expect(DOCUMENT_TRACE_MISSING_SQL).toContain("m.response_json->'trace' = '{}'::jsonb");
    expect(DOCUMENT_RUN_REPAIR_CANDIDATES).toContain(DOCUMENT_TRACE_MISSING_SQL);
    expect(DOCUMENT_RUN_REPAIR_REMAINING).toContain(DOCUMENT_TRACE_MISSING_SQL);
  });

  it('reconstructs only the sidecar trace from linked run and stage evidence', async () => {
    let written: Record<string, unknown> | null = null;
    const query = vi.fn((sql: string, params: unknown[] = []) => {
      if (sql === DOCUMENT_RUN_REPAIR_CANDIDATES) {
        return Promise.resolve({
          rows: [
            {
              message_id: 'msg-dashboard',
              run_id: 'run-dashboard',
              trace_id: 'tr-a87e1e2613d6b9bcdbb3e687766ba8b0',
              created_at: '2026-09-24T05:37:08.000Z',
              completed_at: '2026-09-24T05:42:33.000Z',
              stages: [stage('orchestrator'), stage('dashboard-render', 'running')],
            },
          ],
        });
      }
      if (sql === DOCUMENT_RUN_REPAIR_REMAINING) return Promise.resolve({ rows: [{ count: 0 }] });
      expect(sql).toContain("response_json->'trace' = '{}'::jsonb");
      written = JSON.parse(String(params[1])) as Record<string, unknown>;
      return Promise.resolve({ rows: [{ id: params[0] }] });
    });

    await expect(repairHistoricalDocumentRuns({ query })).resolves.toEqual({
      candidates: 1,
      repaired: 1,
      unrepairable: 0,
      remaining: 0,
    });
    expect(written).toMatchObject({
      id: 'tr-a87e1e2613d6b9bcdbb3e687766ba8b0',
      totalMs: 10_000,
      toolCalls: 1,
      stages: [
        expect.objectContaining({ id: 'orchestrator', status: 'complete' }),
        expect.objectContaining({ id: 'dashboard-render', status: 'failed' }),
      ],
    });
    expect(written).not.toHaveProperty('total_tokens');
  });

  it('leaves rows with no linked stage evidence untouched and reports them', async () => {
    const query = vi.fn((sql: string) => {
      if (sql === DOCUMENT_RUN_REPAIR_CANDIDATES) {
        return Promise.resolve({ rows: [{ message_id: 'msg-orphan', run_id: null, stages: [] }] });
      }
      if (sql === DOCUMENT_RUN_REPAIR_REMAINING) return Promise.resolve({ rows: [{ count: 1 }] });
      throw new Error('The repair must not write an unproven trace.');
    });
    await expect(repairHistoricalDocumentRuns({ query })).resolves.toEqual({
      candidates: 1,
      repaired: 0,
      unrepairable: 1,
      remaining: 1,
    });
  });
});
