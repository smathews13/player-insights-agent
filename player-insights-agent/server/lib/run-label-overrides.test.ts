import { describe, expect, it } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';
import {
  applyOverlayToRunRow,
  overlayFromRow,
  overlayJoinSql,
  overlayStatusSql,
  writeRunLabelOverride,
} from '../lib/run-label-overrides';

describe('run label overlay persistence', () => {
  it('is an admin route, so a consumer never reaches the handler', () => {
    expect(isAdminRoute('/api/admin/run-labels/msg-1')).toBe(true);
  });

  it('writes outcome and feedback and applies them on a later read of the run row', async () => {
    const rows = new Map<string, { run_id: string; status: string | null; rating: string | null }>();
    const query = (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT')) {
        const row = rows.get(String(params[0]));
        return Promise.resolve({ rows: row ? [{ status: row.status, rating: row.rating }] : [] });
      }
      if (sql.includes('INSERT')) {
        rows.set(String(params[0]), {
          run_id: String(params[0]),
          status: (params[1] as string | null) ?? null,
          rating: (params[2] as string | null) ?? null,
        });
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    };

    const saved = await writeRunLabelOverride(query, {
      runId: 'msg-1',
      actor: 'admin@example.com',
      status: 'complete',
      feedback: 'up',
    });
    expect(saved).toEqual({ status: 'complete', feedback: 'up' });
    expect(overlayFromRow({ status: 'complete', rating: 'up' })).toEqual({
      status: 'complete',
      feedback: 'up',
    });

    const listed = applyOverlayToRunRow({ id: 'msg-1', status: 'partial', feedback: null }, saved);
    expect(listed.status).toBe('complete');
    expect(listed.feedback).toBe('up');
  });

  it('wraps the classified status so every list read can COALESCE the overlay', () => {
    expect(overlayJoinSql('a.id')).toContain('run_label_overrides');
    expect(overlayStatusSql(`'partial'`)).toContain('COALESCE');
    expect(overlayStatusSql(`'partial'`)).toContain('label_overlay.status');
  });
});
