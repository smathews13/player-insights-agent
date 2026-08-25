import { BenchmarkSettingsSchema } from '../../shared/benchmark-settings';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { recordAdminAction } from '../lib/admin-roles';
import {
  forgetResolvedExperimentIds,
  resolveExperimentId,
  resolveJudgeEndpoint,
  writeStoredSetting,
} from '../lib/app-settings';
import { readBenchmarkSettings, writeBenchmarkSettings } from '../lib/benchmark-settings-store';
import { userEmail, type InsightsAppKit } from './insights-routes';

function experimentUrl(experimentId: string): string | null {
  const named = experimentId.trim();
  const host = normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
  if (!named || !host) return null;
  return `${host}/ml/experiments/${encodeURIComponent(named)}`;
}

export function setupBenchmarkSettingsRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/benchmark-settings', async (_req, res) => {
      const stored = await readBenchmarkSettings(appkit, { maxAgeMs: 0 });
      const experimentId = stored.experimentId.trim() || (await resolveExperimentId(appkit));
      const judgeEndpoint = stored.judgeEndpoint.trim() || (await resolveJudgeEndpoint(appkit));
      res.json({
        settings: {
          ...stored,
          experimentId,
          judgeEndpoint,
        },
        experimentUrl: experimentUrl(experimentId),
        currentAgentEndpoint: (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim(),
        tracesAlwaysOnInAgent: true,
      });
    });

    app.put('/api/admin/benchmark-settings', async (req, res) => {
      const parsed = BenchmarkSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_benchmark_settings', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        const settings = await writeBenchmarkSettings(appkit, parsed.data, actor);
        if (settings.experimentId) {
          await writeStoredSetting(appkit, {
            resourceId: 'experiment-id',
            value: settings.experimentId,
            intent: 'active',
            note: 'Saved from Settings → Experimental.',
            updatedBy: actor,
          });
          forgetResolvedExperimentIds();
        }
        if (settings.judgeEndpoint) {
          await writeStoredSetting(appkit, {
            resourceId: 'judge-endpoint',
            value: settings.judgeEndpoint,
            intent: 'active',
            note: 'Saved from Settings → Experimental.',
            updatedBy: actor,
          });
        }
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'benchmark-settings-updated',
          subject: 'benchmark-settings',
          detail: 'Updated MLflow experiment, traces, eval set, judge, and bake-off sides.',
        });
        res.json({
          settings,
          experimentUrl: experimentUrl(settings.experimentId),
          currentAgentEndpoint: (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim(),
          tracesAlwaysOnInAgent: true,
          appliesNow: true,
        });
      } catch (error) {
        res.status(503).json({
          error: 'benchmark_settings_store_unavailable',
          detail: `The settings were not saved: ${(error as Error).message}`,
        });
      }
    });
  });
}
