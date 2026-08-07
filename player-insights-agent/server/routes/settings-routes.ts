/**
 * What this deployment is connected to, and the narrow set of changes it can
 * actually make.
 *
 * The write route's job is mostly to REFUSE. Three of the five mutability tiers
 * cannot be changed by saving a value, and a caller that asks to make one active
 * is told so rather than quietly having its request downgraded to a note. The
 * refusal lives in the route rather than in the screen that calls it: a caller
 * that believed it had applied a customer's Genie space id would ship the same
 * silent misconfiguration this whole surface was built to expose.
 */
import { z } from 'zod';
import {
  agentEndpointCheck,
  extractPreflightReport,
  invokePreflight,
  userEmail,
  type InsightsAppKit,
  type PreflightReport,
} from './insights-routes';
import { lakebaseStorageCheck } from '../lib/lakebase-store';
import {
  appBuildSha,
  appEnvironment,
  classifyWrite,
  clearStoredSetting,
  readStoredSettings,
  settingsPayload,
  writeStoredSetting,
} from '../lib/app-settings';

const WriteBody = z.object({
  value: z.string().trim().max(500),
  intent: z.enum(['active', 'intended']),
  note: z.string().trim().max(500).default(''),
});

/**
 * The orchestrator's report, with the two checks only the app can make.
 *
 * The same two `/api/preflight` adds, from the same exported helpers rather than
 * from a second copy of them: the endpoint cannot report on whether the app can
 * reach it, and it has no view of the app's own store. `source` is what tells a
 * reader whether anything behind the endpoint was measured at all, so it is set
 * from whether a report came back and never assumed.
 */
async function readOrchestratorReport(appkit: InsightsAppKit): Promise<PreflightReport | null> {
  const endpointName = process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '';
  let raw: unknown;
  try {
    raw = await invokePreflight(appkit);
  } catch (error) {
    console.warn('[settings] The orchestrator could not be asked what it is configured with:', (error as Error).message);
    return null;
  }
  const report = extractPreflightReport(raw);
  if (!report) return null;
  return {
    ...report,
    checks: [
      agentEndpointCheck(endpointName, {
        status: 'ok',
        detail: 'The app invoked the orchestrator and it reported its configuration.',
      }),
      lakebaseStorageCheck(),
      ...report.checks,
    ],
    counts: { ok: 0, failed: 0, unverified: 0 },
    source: 'agent',
  };
}

export function setupSettingsRoutes(appkit: InsightsAppKit) {
  appkit.server.extend((app) => {
    /**
     * Every connection, with what it was configured as, what the running system
     * used, and what somebody intends it to be.
     *
     * Answers 200 even when the orchestrator is unreachable. The payload then
     * says so (`orchestratorReported: false` plus a drift finding), because a
     * deployer arriving here to find out why nothing works is the main audience,
     * and a 503 would leave them with the app-side half they can already see.
     */
    app.get('/api/settings', async (_req, res) => {
      const report = await readOrchestratorReport(appkit);
      const stored = await readStoredSettings(appkit);
      res.json(settingsPayload({
          report,
          environment: appEnvironment(),
          stored,
          appBuildSha: appBuildSha(),
          // Asked separately, because `readStoredSettings` degrades an outage to
          // an empty map and that is indistinguishable from "nothing saved yet"
          // unless the state of the store is reported beside it. The same
          // distinction /api/storage draws, for the same reason.
          storeAvailable: await storeAnswers(appkit),
        })
      );
    });

    /**
     * Record a value for one resource.
     *
     * 409, not 400, when the tier refuses it: the request was well formed and the
     * resource exists, what cannot be done is the thing being asked for. The
     * body carries the reason and the exact command that would work, so a client
     * can show the refusal without knowing the rules itself.
     */
    app.put('/api/settings/values/:resourceId', async (req, res) => {
      const parsed = WriteBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_settings_body', detail: parsed.error.message });
        return;
      }
      const { resourceId } = req.params;
      const decision = classifyWrite(resourceId, parsed.data.intent);
      if (!decision.ok) {
        res.status(409).json({ error: 'not_changeable_here', detail: decision.reason });
        return;
      }
      if (!parsed.data.value) {
        res.status(400).json({
          error: 'empty_value',
          detail: 'Saving an empty value would read as "configured as nothing". Delete it instead.',
        });
        return;
      }
      try {
        const saved = await writeStoredSetting(appkit, {
          resourceId,
          value: parsed.data.value,
          intent: decision.intent,
          note: parsed.data.note,
          updatedBy: userEmail(req),
        });
        res.json({
          saved,
          appliesNow: decision.intent === 'active',
        });
      } catch (error) {
        console.error(`[settings] ${resourceId} could not be saved:`, (error as Error).message);
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail:
            'The value was not saved. The app stores settings in Lakebase, and it is not answering: ' +
            'reporting success here would leave a value on screen that no restart would keep.',
        });
      }
    });

    app.delete('/api/settings/values/:resourceId', async (req, res) => {
      try {
        const removed = await clearStoredSetting(appkit, req.params.resourceId);
        if (!removed) {
          res.status(404).json({ error: 'no_such_setting', detail: 'Nothing was stored for that resource.' });
          return;
        }
        res.json({ cleared: req.params.resourceId });
      } catch (error) {
        console.error(`[settings] ${req.params.resourceId} could not be cleared:`, (error as Error).message);
        res.status(503).json({ error: 'settings_store_unavailable', detail: 'The value was not cleared.' });
      }
    });
  });
}

/**
 * Whether the store answers, as opposed to simply being empty.
 *
 * A read through the app's own schema rather than a bare connection probe: the
 * failure that matters here is a lost grant on `player_insights`, which a
 * connection-level check passes straight through.
 */
async function storeAnswers(appkit: InsightsAppKit): Promise<boolean> {
  try {
    await appkit.lakebase.query('SELECT 1 FROM player_insights.deployment_settings LIMIT 1');
    return true;
  } catch {
    return false;
  }
}
