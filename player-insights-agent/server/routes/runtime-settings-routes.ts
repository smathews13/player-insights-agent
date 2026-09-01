import { z } from 'zod';
import { RuntimeSettingsPatchSchema } from '../../shared/runtime-settings';
import { recordAdminAction } from '../lib/admin-roles';
import { readRuntimeSettingsDocument, writeRuntimeSettingsPatch } from '../lib/runtime-settings-store';
import { SettingsRevisionConflict } from '../lib/versioned-settings-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

const RuntimeSettingsWrite = z.strictObject({
  revision: z.number().int().nonnegative(),
  patch: RuntimeSettingsPatchSchema,
});

export function setupRuntimeSettingsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/runtime-settings', async (_req, res) => {
      try {
        res.json(await readRuntimeSettingsDocument(appkit, { maxAgeMs: 0 }));
      } catch (error) {
        res.status(503).json({
          error: 'runtime_settings_store_unavailable',
          detail: `Runtime settings could not be read from Lakebase: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/runtime-settings', async (req, res) => {
      const parsed = RuntimeSettingsWrite.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_runtime_settings', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      let document: Awaited<ReturnType<typeof writeRuntimeSettingsPatch>>;
      try {
        document = await writeRuntimeSettingsPatch(appkit, parsed.data.patch, parsed.data.revision, actor);
      } catch (error) {
        const conflict = error instanceof SettingsRevisionConflict;
        res.status(conflict ? 409 : 503).json({
          error: conflict ? 'runtime_settings_conflict' : 'runtime_settings_store_unavailable',
          detail: conflict ? error.message : `The settings were not saved: ${(error as Error).message}`,
        });
        return;
      }
      try {
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'runtime-settings-updated',
          subject: 'runtime-settings',
          detail: 'Updated live loop, answer presentation, and request-context settings.',
        });
      } catch (error) {
        console.warn('[runtime-settings] Saved settings, but could not write the admin audit row:', error);
      }
      res.json({ ...document, appliesNow: true });
    });
  });
}
