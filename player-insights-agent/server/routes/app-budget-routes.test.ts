import type { Application, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { emptyAppBudgetStatus, appBudgetPeriod } from '../../shared/app-budget-guard';
import { isAdminRoute } from '../lib/admin-roles';
import { setupAppBudgetRoutes } from './app-budget-routes';

const period = appBudgetPeriod(Date.parse('2026-09-15T12:00:00Z'));
const fingerprint = 'a'.repeat(64);
const approvalRequired = emptyAppBudgetStatus(period, '2026-09-15T12:00:00Z', {
  level: 'approval-required',
  measured: 110,
  budget: 100,
  unit: 'USD',
  ratio: 1.1,
  percent: 110,
  coverage: 'complete',
  budgetFingerprint: fingerprint,
  code: 'BUDGET_APPROVAL_REQUIRED',
  detail: 'Approval required.',
});

function response() {
  const output: { status: number; body: unknown } = { status: 200, body: null };
  const res = {
    status(code: number) {
      output.status = code;
      return res;
    },
    json(body: unknown) {
      output.body = body;
      return res;
    },
  };
  return { output, res: res as unknown as Response };
}

describe('app budget routes', () => {
  it('leaves safe status readable while admin-gating approve and revoke', () => {
    expect(isAdminRoute('/api/budget-status')).toBe(false);
    expect(isAdminRoute('/api/admin/budget-approval')).toBe(true);
  });

  it('persists an explicit approval and records measured audit evidence', async () => {
    let approve: ((req: Request, res: Response) => Promise<void>) | undefined;
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    setupAppBudgetRoutes(
      {
        lakebase: {
          query: (sql: string, params: unknown[] = []) => {
            queries.push({ sql, params });
            if (sql.includes('app_budget_approvals')) {
              return Promise.resolve({
                rows: [
                  {
                    id: 'approval-1',
                    approved_by: 'admin@example.com',
                    approved_at: '2026-09-15T12:01:00Z',
                    revoked_by: null,
                    revoked_at: null,
                  },
                ],
              });
            }
            return Promise.resolve({ rows: [] });
          },
        },
        server: {
          extend: (register: (app: Application) => void) =>
            register({
              get: () => undefined,
              post: (_path: string, handler: typeof approve) => {
                approve = handler;
              },
              delete: () => undefined,
            } as unknown as Application),
        },
      } as never,
      { readStatus: vi.fn(() => Promise.resolve(approvalRequired)) }
    );
    const { output, res } = response();
    await approve!(
      {
        body: { budgetFingerprint: fingerprint },
        header: (name: string) => (name === 'x-forwarded-email' ? 'admin@example.com' : undefined),
      } as unknown as Request,
      res
    );
    expect(output.status).toBe(200);
    expect(output.body).toMatchObject({ status: { level: 'approved-overage' } });
    const approvalWrite = queries.find(
      (entry) => entry.sql.includes('INSERT INTO') && entry.sql.includes('app_budget')
    );
    expect(approvalWrite?.params).toContain('admin@example.com');
    const audit = queries.find((entry) => entry.sql.includes('admin_audit'));
    expect(audit?.params.join(' ')).toContain('Measured 110 USD against 100 USD');
    expect(audit?.params.join(' ')).toContain(fingerprint);
    expect(audit?.params.join(' ')).not.toContain('credential');
  });

  it('uses optimistic fingerprint matching and accepts no client spend or role claim', async () => {
    let approve: ((req: Request, res: Response) => Promise<void>) | undefined;
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    setupAppBudgetRoutes(
      {
        lakebase: { query },
        server: {
          extend: (register: (app: Application) => void) =>
            register({
              get: () => undefined,
              post: (_path: string, handler: typeof approve) => {
                approve = handler;
              },
              delete: () => undefined,
            } as unknown as Application),
        },
      } as never,
      { readStatus: vi.fn(() => Promise.resolve(approvalRequired)) }
    );
    const { output, res } = response();
    await approve!(
      {
        body: { budgetFingerprint: 'b'.repeat(64) },
        header: (name: string) => (name === 'x-forwarded-email' ? 'admin@example.com' : undefined),
      } as unknown as Request,
      res
    );
    expect(output.status).toBe(409);
    expect(output.body).toMatchObject({ error: 'budget_revision_changed' });
    expect(query).not.toHaveBeenCalled();

    const untrusted = response();
    await approve!(
      {
        body: { budgetFingerprint: fingerprint, measured: 0, role: 'admin' },
        header: (name: string) => (name === 'x-forwarded-email' ? 'admin@example.com' : undefined),
      } as unknown as Request,
      untrusted.res
    );
    expect(untrusted.output.status).toBe(400);
    expect(untrusted.output.body).toMatchObject({ error: 'invalid_budget_approval' });
  });
});
