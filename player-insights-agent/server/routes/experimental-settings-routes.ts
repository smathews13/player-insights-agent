import { z } from 'zod';
import { ExperimentalSettingsPatchSchema } from '../../shared/experimental-settings';
import { recordAdminAction } from '../lib/admin-roles';
import { readExperimentalSettings, writeExperimentalSettings } from '../lib/experimental-settings-store';
import { SettingsRevisionConflict } from '../lib/versioned-settings-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

const ExperimentalSettingsWrite = z.strictObject({
  revision: z.number().int().nonnegative(),
  patch: ExperimentalSettingsPatchSchema,
});

export function setupExperimentalSettingsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/experimental-settings', async (_req, res) => {
      try {
        res.json(await readExperimentalSettings(appkit, { maxAgeMs: 0 }));
      } catch (error) {
        res.status(503).json({
          error: 'experimental_settings_store_unavailable',
          detail: `Experimental settings could not be read from Lakebase: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/experimental-settings', async (req, res) => {
      const parsed = ExperimentalSettingsWrite.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_experimental_settings', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      let document: Awaited<ReturnType<typeof writeExperimentalSettings>>;
      try {
        document = await writeExperimentalSettings(appkit, parsed.data.patch, parsed.data.revision, actor);
      } catch (error) {
        const conflict = error instanceof SettingsRevisionConflict;
        res.status(conflict ? 409 : 503).json({
          error: conflict ? 'experimental_settings_conflict' : 'experimental_settings_store_unavailable',
          detail: conflict ? error.message : `The settings were not saved: ${(error as Error).message}`,
        });
        return;
      }
      try {
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'experimental-settings-updated',
          subject: 'experimental-settings',
          detail: 'Updated deployment-wide experimental feature visibility.',
        });
      } catch (error) {
        console.warn('[experimental-settings] Saved settings, but could not write the admin audit row:', error);
      }
      res.json(document);
    });
  });
}
