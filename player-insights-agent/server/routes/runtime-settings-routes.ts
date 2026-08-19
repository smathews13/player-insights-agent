import { RuntimeSettingsSchema } from '../../shared/runtime-settings';
import { recordAdminAction } from '../lib/admin-roles';
import { readRuntimeSettings, writeRuntimeSettings } from '../lib/runtime-settings-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

export function setupRuntimeSettingsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/runtime-settings', async (_req, res) => {
      res.json({ settings: await readRuntimeSettings(appkit, { maxAgeMs: 0 }) });
    });

    app.put('/api/admin/runtime-settings', async (req, res) => {
      const parsed = RuntimeSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_runtime_settings', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        const settings = await writeRuntimeSettings(appkit, parsed.data, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'runtime-settings-updated',
          subject: 'runtime-settings',
          detail: 'Updated live loop, answer presentation, and request-context settings.',
        });
        res.json({ settings, appliesNow: true });
      } catch (error) {
        res.status(503).json({
          error: 'runtime_settings_store_unavailable',
          detail: `The settings were not saved: ${(error as Error).message}`,
        });
      }
    });
  });
}
