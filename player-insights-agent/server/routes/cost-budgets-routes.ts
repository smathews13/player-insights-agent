import { CostBudgetsSchema } from '../../shared/cost-budgets';
import { recordAdminAction } from '../lib/admin-roles';
import { readCostBudgets, writeCostBudgets } from '../lib/cost-budgets-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

export function setupCostBudgetsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/admin/cost-budgets', async (_req, res) => {
      const stored = await readCostBudgets(appkit, { maxAgeMs: 0 });
      res.json({ budgets: stored.budgets, readable: stored.readable });
    });

    app.put('/api/admin/cost-budgets', async (req, res) => {
      const parsed = CostBudgetsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_cost_budgets', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        const budgets = await writeCostBudgets(appkit, parsed.data, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'cost-budgets-updated',
          subject: 'cost-budgets',
          detail: 'Updated nominal Cost budgets for the app total and resource tiles.',
        });
        res.json({ budgets, readable: true });
      } catch (error) {
        res.status(503).json({
          error: 'cost_budgets_store_unavailable',
          detail: `The budgets were not saved: ${(error as Error).message}`,
        });
      }
    });
  });
}
