/**
 * Admin overlay of Run Explorer rail labels: outcome and feedback after a run.
 *
 * `/api/admin/run-labels` sits under the existing `/api/admin` prefix, so the
 * identity and admin guards already refuse a consumer. Nothing here checks a
 * role a second time.
 */
import { z } from 'zod';
import { recordAdminAction } from '../lib/admin-roles';
import { readRunLabelOverride, writeRunLabelOverride } from '../lib/run-label-overrides';
import { userEmail, type InsightsAppKit } from './insights-routes';

const OverlayBody = z.object({
  status: z.enum(['complete', 'partial', 'failed']).optional(),
  feedback: z.enum(['none', 'up', 'down']).optional(),
});

export function setupRunLabelRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/admin/run-labels/:runId', async (req, res) => {
      const runId = req.params.runId?.trim() ?? '';
      if (!runId) {
        res.status(400).json({ error: 'run_id_required' });
        return;
      }
      try {
        const overlay = await readRunLabelOverride(appkit.lakebase.query.bind(appkit.lakebase), runId);
        if (!overlay) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        res.json(overlay);
      } catch (error) {
        res.status(503).json({
          error: 'run_labels_unreadable',
          detail: (error as Error).message,
        });
      }
    });

    app.put('/api/admin/run-labels/:runId', async (req, res) => {
      const runId = req.params.runId?.trim() ?? '';
      const parsed = OverlayBody.safeParse(req.body);
      if (!runId || !parsed.success || (parsed.data.status === undefined && parsed.data.feedback === undefined)) {
        res.status(400).json({ error: 'invalid_run_labels' });
        return;
      }
      const actor = userEmail(req);
      try {
        const overlay = await writeRunLabelOverride(appkit.lakebase.query.bind(appkit.lakebase), {
          runId,
          actor,
          ...parsed.data,
        });
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'run-labels-updated',
          subject: runId,
          detail: `Updated run rail labels${parsed.data.status ? ` outcome=${parsed.data.status}` : ''}${
            parsed.data.feedback ? ` feedback=${parsed.data.feedback}` : ''
          }.`,
        });
        res.json(overlay);
      } catch (error) {
        res.status(503).json({
          error: 'run_labels_not_saved',
          detail: (error as Error).message,
        });
      }
    });
  });
}
