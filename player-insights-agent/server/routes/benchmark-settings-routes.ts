import { z } from 'zod';
import { BenchmarkSettingsPatchSchema } from '../../shared/benchmark-settings';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { recordAdminAction } from '../lib/admin-roles';
import {
  forgetResolvedExperimentIds,
  resolveExperimentId,
  resolveJudgeEndpoint,
  writeStoredSetting,
} from '../lib/app-settings';
import { readBenchmarkSettingsDocument, writeBenchmarkSettingsPatch } from '../lib/benchmark-settings-store';
import { SettingsRevisionConflict } from '../lib/versioned-settings-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

const BenchmarkSettingsWrite = z.strictObject({
  revision: z.number().int().nonnegative(),
  patch: BenchmarkSettingsPatchSchema,
});

function experimentUrl(experimentId: string): string | null {
  const named = experimentId.trim();
  const host = normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
  if (!named || !host) return null;
  return `${host}/ml/experiments/${encodeURIComponent(named)}`;
}

export function setupBenchmarkSettingsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/benchmark-settings', async (_req, res) => {
      try {
        const document = await readBenchmarkSettingsDocument(appkit, { maxAgeMs: 0 });
        const experimentId = document.settings.experimentId.trim() || (await resolveExperimentId(appkit));
        const judgeEndpoint = document.settings.judgeEndpoint.trim() || (await resolveJudgeEndpoint(appkit));
        res.json({
          settings: {
            ...document.settings,
            experimentId,
            judgeEndpoint,
          },
          revision: document.revision,
          experimentUrl: experimentUrl(experimentId),
          currentAgentEndpoint: (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim(),
          tracesAlwaysOnInAgent: true,
        });
      } catch (error) {
        res.status(503).json({
          error: 'benchmark_settings_store_unavailable',
          detail: `Benchmark settings could not be read from Lakebase: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/benchmark-settings', async (req, res) => {
      const parsed = BenchmarkSettingsWrite.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_benchmark_settings', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      let document: Awaited<ReturnType<typeof writeBenchmarkSettingsPatch>>;
      try {
        document = await writeBenchmarkSettingsPatch(appkit, parsed.data.patch, parsed.data.revision, actor);
      } catch (error) {
        const conflict = error instanceof SettingsRevisionConflict;
        res.status(conflict ? 409 : 503).json({
          error: conflict ? 'benchmark_settings_conflict' : 'benchmark_settings_store_unavailable',
          detail: conflict ? error.message : `The settings were not saved: ${(error as Error).message}`,
        });
        return;
      }
      const { settings } = document;
      try {
        if (parsed.data.patch.experimentId !== undefined && settings.experimentId) {
          await writeStoredSetting(appkit, {
            resourceId: 'experiment-id',
            value: settings.experimentId,
            intent: 'active',
            note: 'Saved from Settings → Experimental.',
            updatedBy: actor,
          });
          forgetResolvedExperimentIds();
        }
        if (parsed.data.patch.judgeEndpoint !== undefined && settings.judgeEndpoint) {
          await writeStoredSetting(appkit, {
            resourceId: 'judge-endpoint',
            value: settings.judgeEndpoint,
            intent: 'active',
            note: 'Saved from Settings → Experimental.',
            updatedBy: actor,
          });
        }
      } catch (error) {
        console.warn('[benchmark-settings] Saved settings, but could not synchronize Connections:', error);
      }
      try {
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'benchmark-settings-updated',
          subject: 'benchmark-settings',
          detail: 'Updated MLflow experiment, traces, judges, and baseline/candidate sides.',
        });
      } catch (error) {
        console.warn('[benchmark-settings] Saved settings, but could not write the admin audit row:', error);
      }
      const experimentId = settings.experimentId.trim() || (await resolveExperimentId(appkit));
      const judgeEndpoint = settings.judgeEndpoint.trim() || (await resolveJudgeEndpoint(appkit));
      res.json({
        settings: { ...settings, experimentId, judgeEndpoint },
        revision: document.revision,
        experimentUrl: experimentUrl(experimentId),
        currentAgentEndpoint: (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim(),
        tracesAlwaysOnInAgent: true,
        appliesNow: true,
      });
    });
  });
}
