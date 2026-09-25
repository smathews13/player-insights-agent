import { z } from 'zod';
import type { Request, Response } from 'express';
import { RuntimeSettingsPatchSchema } from '../../shared/runtime-settings';
import { ownsPreferenceDefaults } from '../../shared/preference-default-owner';
import { recordAdminAction } from '../lib/admin-roles';
import {
  deleteUserRuntimeSettings,
  readResolvedRuntimeSettings,
  readRuntimeSettingsDocument,
  writeRuntimeSettingsPatch,
  writeUserRuntimeSettingsPatch,
} from '../lib/runtime-settings-store';
import { SettingsRevisionConflict } from '../lib/versioned-settings-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

const RuntimeSettingsWrite = z.strictObject({
  revision: z.number().int().nonnegative(),
  patch: RuntimeSettingsPatchSchema,
});

const APPEARANCE_KEYS = new Set([
  'colorScheme',
  'entityStyles',
  'fontBodyColor',
  'fontMutedColor',
  'fontFamily',
  'fontSize',
  'mobileFontSize',
  'backgroundGraphics',
  'animations',
  'density',
]);

export function isAppearancePatch(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).every((key) => APPEARANCE_KEYS.has(key));
}

export function setupRuntimeSettingsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/runtime-settings', async (req, res) => {
      const actor = userEmail(req);
      if (!actor) {
        res.status(401).json({ error: 'identity_unavailable', detail: 'A signed-in user is required.' });
        return;
      }
      try {
        res.json(await readResolvedRuntimeSettings(appkit, actor));
      } catch (error) {
        res.status(503).json({
          error: 'runtime_settings_store_unavailable',
          detail: `Runtime settings could not be read from Lakebase: ${(error as Error).message}`,
        });
      }
    });

    app.get('/api/admin/runtime-settings', async (_req, res) => {
      try {
        res.json(await readRuntimeSettingsDocument(appkit, { maxAgeMs: 0 }));
      } catch (error) {
        res.status(503).json({
          error: 'runtime_settings_store_unavailable',
          detail: `Runtime settings could not be read from Lakebase: ${(error as Error).message}`,
        });
      }
    });

    const parseWrite = (req: Request, res: Response) => {
      const parsed = RuntimeSettingsWrite.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_runtime_settings', detail: parsed.error.message });
        return null;
      }
      return parsed.data;
    };

    app.put('/api/runtime-settings', async (req, res) => {
      const input = parseWrite(req, res);
      if (!input) return;
      const actor = userEmail(req);
      if (!actor) {
        res.status(401).json({ error: 'identity_unavailable', detail: 'A signed-in user is required.' });
        return;
      }
      if (!isAppearancePatch(input.patch)) {
        res.status(403).json({
          error: 'appearance_settings_only',
          detail: 'This route only changes the signed-in user’s Appearance preferences.',
        });
        return;
      }
      try {
        const document = ownsPreferenceDefaults(actor)
          ? await writeRuntimeSettingsPatch(appkit, input.patch, input.revision, actor).then((value) => ({
              ...value,
              source: 'default' as const,
              canReset: false,
            }))
          : await writeUserRuntimeSettingsPatch(appkit, actor, input.patch, input.revision);
        res.json({ ...document, appliesNow: true });
      } catch (error) {
        const conflict = error instanceof SettingsRevisionConflict;
        res.status(conflict ? 409 : 503).json({
          error: conflict ? 'runtime_settings_conflict' : 'runtime_settings_store_unavailable',
          detail: conflict ? error.message : `The settings were not saved: ${(error as Error).message}`,
        });
      }
    });

    app.delete('/api/runtime-settings', async (req, res) => {
      const actor = userEmail(req);
      if (!actor) {
        res.status(401).json({ error: 'identity_unavailable', detail: 'A signed-in user is required.' });
        return;
      }
      if (ownsPreferenceDefaults(actor)) {
        res.status(409).json({ error: 'default_owner_cannot_reset', detail: 'Rida’s settings are the default.' });
        return;
      }
      try {
        res.json({ ...(await deleteUserRuntimeSettings(appkit, actor)), appliesNow: true });
      } catch (error) {
        res.status(503).json({
          error: 'runtime_settings_store_unavailable',
          detail: `The Appearance override was not reset: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/runtime-settings', async (req, res) => {
      const input = parseWrite(req, res);
      if (!input) return;
      const actor = userEmail(req);
      let document: Awaited<ReturnType<typeof writeRuntimeSettingsPatch>>;
      try {
        document = await writeRuntimeSettingsPatch(appkit, input.patch, input.revision, actor);
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
