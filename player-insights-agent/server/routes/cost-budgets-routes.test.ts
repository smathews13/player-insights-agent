import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Application, Request, Response } from 'express';

import { isAdminRoute } from '../lib/admin-roles';
import { setupCostBudgetsRoutes } from './cost-budgets-routes';
import type { InsightsAppKit } from './insights-routes';

describe('cost budget route permissions', () => {
  it('admin-gates both the read and the write', () => {
    expect(isAdminRoute('/api/admin/cost-budgets')).toBe(true);
    const source = fs.readFileSync(path.join(__dirname, 'cost-budgets-routes.ts'), 'utf8');
    expect(source).toContain("app.get('/api/admin/cost-budgets'");
    expect(source).toContain("app.put('/api/admin/cost-budgets'");
  });

  it('accepts older documents but withholds retired and unproven resource budgets', async () => {
    let put: ((req: Request, res: Response) => Promise<void>) | undefined;
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    setupCostBudgetsRoutes({
      lakebase: {
        query: (sql: string, params: unknown[] = []) => {
          writes.push({ sql, params });
          return Promise.resolve({ rows: [] });
        },
      },
      server: {
        extend: (register: (app: Application) => void) =>
          register({
            get: () => undefined,
            put: (_path: string, handler: (req: Request, res: Response) => Promise<void>) => {
              put = handler;
            },
          } as unknown as Application),
      },
    } as unknown as InsightsAppKit);

    let body: unknown;
    await put!(
      {
        body: {
          total: 100,
          resources: {
            'app-compute': 25,
            'foundation-model': 50,
            'index-rebuild-job': 75,
          },
        },
        header: (name: string) => (name === 'x-forwarded-email' ? 'admin@example.test' : undefined),
      } as unknown as Request,
      {
        json: (value: unknown) => {
          body = value;
        },
      } as unknown as Response
    );

    expect(body).toMatchObject({
      budgets: { total: 100, resources: { 'app-compute': 25 } },
      readable: true,
    });
    expect(writes[0].params[1]).toBe(JSON.stringify({ total: 100, resources: { 'app-compute': 25 } }));
  });
});
