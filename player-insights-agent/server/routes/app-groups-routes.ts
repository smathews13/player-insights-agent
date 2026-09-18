import { z } from 'zod';
import type { Request, Response } from 'express';
import { AppGroupsPatchSchema } from '../../shared/app-groups';
import { recordAdminAction } from '../lib/admin-roles';
import { readAppGroupsSettings, writeAppGroupsSettings } from '../lib/app-groups-store';
import { SettingsRevisionConflict } from '../lib/versioned-settings-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

const AppGroupsWrite = z.strictObject({
  revision: z.number().int().nonnegative(),
  patch: AppGroupsPatchSchema,
});

export function setupAppGroupsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/admin/app-groups', async (_req, res) => {
      try {
        res.json(await readAppGroupsSettings(appkit));
      } catch (error) {
        res.status(503).json({
          error: 'app_groups_unavailable',
          detail: `Teams could not be read from Lakebase: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/app-groups', async (req: Request, res: Response) => {
      const parsed = AppGroupsWrite.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_app_groups', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      if (!actor) {
        res.status(401).json({ error: 'identity_unavailable', detail: 'A signed-in user is required.' });
        return;
      }
      try {
        const document = await writeAppGroupsSettings(appkit, parsed.data.patch, parsed.data.revision, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'app-groups-updated',
          subject: 'app-groups',
          detail: `Configured ${document.settings.groups.length} monitoring teams.`,
        }).catch((error) => console.warn('[app-groups] Team settings saved without an audit row:', error));
        res.json(document);
      } catch (error) {
        const conflict = error instanceof SettingsRevisionConflict;
        res.status(conflict ? 409 : 503).json({
          error: conflict ? 'app_groups_conflict' : 'app_groups_unavailable',
          detail: conflict ? error.message : `Teams were not saved: ${(error as Error).message}`,
        });
      }
    });
  });
}
