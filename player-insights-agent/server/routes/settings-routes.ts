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
import { APP_SCHEMA } from '../../shared/app-schema';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  userEmail,
  type InsightsAppKit,
  type PreflightCheck,
  type PreflightConfiguration,
  type PreflightReport,
} from './insights-routes';
import { configurationFromRelease } from '../lib/release-configuration';
import type { StoredSetting } from '../lib/app-settings';
import { lakebaseStorageCheck } from '../lib/lakebase-store';
import {
  appBuildAncestors,
  appBuildSha,
  appEnvironment,
  classifyWrite,
  clearStoredSetting,
  readStoredSettings,
  resourceStates,
  settingsPayload,
  writeStoredSetting,
} from '../lib/app-settings';
import { resolveExperimentId, resolveNotebookDeclaration } from '../lib/app-settings';
import { recordAdminAction, requireAdmin } from '../lib/admin-roles';
import { readAgentModel } from '../lib/agent-model';
import { readAppFacts } from '../lib/app-metadata';
import { probeConnections } from '../lib/dependency-probes';
import { accessDependenciesFrom } from './access-verification';
import { validateNotebookPath } from '../lib/browse-assets';
import { checkExperimentAsApp } from '../lib/experiment-probe';
import { forwardedUserToken } from './access-verification';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { readPublishedDeclaration, type DeclarationRead } from '../lib/notebook-declaration-read';
import { compareDeclaration, type DeclarationComparison } from '../../shared/notebook-declaration';
import {
  addFault,
  addedConnectionEffect,
  forgetDeclaredConnection,
  readDeclaredConnections,
  removalImpact,
  restoreDeclaredConnection,
  withdrawDeclaredConnection,
  writeDeclaredConnection,
  type RemovalImpact,
  type StoredDeclaredConnection,
} from '../lib/declared-connections';
import {
  intendedFromResources,
  resolveApplyPlan,
  settingsFromDeclaration,
  type ApplyPlan,
} from '../../shared/apply-declaration';
import type { ResourceKind } from '../../shared/deployment-config';
import {
  claimModelRelease,
  completeModelRelease,
  createModelRelease,
  listModelReleases,
  readModelRelease,
} from '../lib/model-release-store';
import type { ModelReleaseDeclaration, ReleasePreflight } from '../../shared/model-release';
import { applyAstrolabeTags } from '../lib/resource-tagging';

const WriteBody = z.object({
  value: z.string().trim().max(500),
  intent: z.enum(['active', 'intended']),
  note: z.string().trim().max(500).default(''),
});

const NotebookPathBody = z.strictObject({
  path: z.string().trim().min(1).max(1024),
});

export async function validateAndStoreNotebookPath(input: {
  appkit: InsightsAppKit;
  path: string;
  host: string;
  token: string;
  updatedBy: string;
  validate?: typeof validateNotebookPath;
  write?: typeof writeStoredSetting;
}): Promise<{ ok: true; saved: StoredSetting } | { ok: false; status: 400 | 403 | 404 | 503; detail: string }> {
  const validate = input.validate ?? validateNotebookPath;
  const validation = await validate(input.path, {
    host: input.host,
    token: input.token,
  });
  if (!validation.ok) return validation;
  const write = input.write ?? writeStoredSetting;
  const saved = await write(input.appkit, {
    resourceId: 'notebook-path',
    value: validation.path,
    intent: 'active',
    note: 'Workspace notebook selected from Connections.',
    updatedBy: input.updatedBy,
  });
  return { ok: true, saved };
}

/**
 * An asset somebody is adding to the list the agent may consider.
 *
 * `kind` is checked against the declarable set by `addFault` rather than by an
 * enum here, so there is ONE list of what may be added and the refusal text comes
 * from the same place whether the entry arrived from this route or from a notebook.
 */
const ConnectionBody = z.object({
  id: z.string().trim().max(80),
  label: z.string().trim().max(200).default(''),
  kind: z.string().trim().max(60),
  value: z.string().trim().max(500),
  note: z.string().trim().max(500).default(''),
});

const ClaimBody = z.strictObject({
  executionId: z.string().trim().min(8).max(200),
});

const CompletionBody = z.strictObject({
  executionId: z.string().trim().min(8).max(200),
  status: z.enum(['succeeded', 'failed']),
  vTo: z.string().trim().max(100).nullable().optional(),
  preflight: z
    .strictObject({
      status: z.string().trim().max(40),
      checkedAt: z.string().trim().max(100),
      ok: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      unverified: z.number().int().nonnegative(),
      detail: z.string().trim().max(1000).optional(),
    })
    .nullable()
    .optional(),
  errorSummary: z.string().trim().max(1000).nullable().optional(),
});

/**
 * What this release was wired to: a configuration list, never a live serving ping.
 *
 * `answered` stays false. The app used to treat a serving reply as proof the
 * agent was reachable; that ping is gone, so this must not claim one ran.
 */
interface OrchestratorRead {
  report: PreflightReport | null;
  /** Always false: this path no longer invokes the serving endpoint. */
  answered: boolean;
}

/**
 * What this release was wired to, and nothing about live agent health.
 *
 * Lakebase is included because the app can ask its own store. Every other field
 * is empty ON PURPOSE: this path no longer invokes serving, so it must not
 * stamp a check time, a serving principal, or an "ok" on the agent endpoint.
 *
 * `build_sha` is lifted out of the configuration when the release wrote one.
 */
function configurationOnlyReport(configuration: PreflightConfiguration[]): PreflightReport {
  const stamped = configuration.find((entry) => entry.key === 'build_sha');
  return {
    checked_at: '',
    status: 'unverified',
    principal: '',
    principal_resolved: false,
    table_source: '',
    build_sha: typeof stamped?.value === 'string' ? stamped.value : '',
    configuration,
    checks: [lakebaseStorageCheck()],
    assumptions: [],
    counts: { ok: 0, failed: 0, unverified: 0 },
    source: 'configuration',
  };
}

/**
 * The release's configuration, never a serving invoke.
 *
 * Connections still needs catalog, schema, Genie ids and the declared table
 * list. Those come from the app container (filled at app-release from the same
 * bundle variables a log uses) and, when catalog+schema are present, from the
 * committed data contract. Unity Catalog then answers whether the signed-in
 * user can reach those objects.
 */
export async function readOrchestratorReport(): Promise<OrchestratorRead> {
  return {
    report: configurationOnlyReport(configurationFromRelease(process.env)),
    answered: false,
  };
}

export function setupSettingsRoutes(appkit: InsightsAppKit) {
  appkit.server.extend((app) => {
    /**
     * The deployment facts needed by the global header.
     *
     * This is the same Apps API read as the Connections Build card, kept on a
     * small route so opening any page does not also invoke the orchestrator,
     * dependency probes, notebook read and connection reads in `/api/settings`.
     *
     * `buildSha` is the SAME stamp the Build card's App row prints, read from
     * the one function that owns it rather than re-derived here. The header
     * names the release and the card names the release, and two readings of one
     * fact is how a reader ends up comparing this app against itself.
     */
    app.get('/api/deployment', async (_req, res) => {
      const facts = await readAppFacts();
      res.json({ deployedAt: facts.deployedAt, deployedBy: facts.deployedBy, buildSha: appBuildSha() });
    });

    /**
     * Where the running agent's own code can be read.
     *
     * Its own route rather than a field on `/api/settings`, for the reason
     * `/api/deployment` above is: this is one endpoint description, and the
     * Settings pane that draws it must not have to invoke the orchestrator,
     * every dependency probe, the notebook read and the connection reads to get
     * it. Deliberately NOT under an admin prefix -- reading which version of the
     * agent answered is the same class of fact as `GET /api/settings`, and the
     * people who most need to read the code are the ones evaluating the answers.
     */
    app.get('/api/settings/agent-model', async (_req, res) => {
      res.json(await readAgentModel());
    });

    /**
     * Backfill the Astrolabe billing tag on platform resources this deployment
     * manages. WorkspaceClient uses the app service principal injected by
     * Databricks Apps; the viewer's forwarded token is deliberately not read.
     */
    app.post('/api/settings/resource-tags', async (req, res) => {
      try {
        const { report } = await readOrchestratorReport();
        const experimentId = await resolveExperimentId(appkit);
        const summary = await applyAstrolabeTags({
          report,
          environment: {
            ...process.env,
            PLAYER_INSIGHTS_EXPERIMENT_ID: experimentId,
          },
        });
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: 'resource-tags-applied',
          subject: 'system_billing=astrolabe',
          detail: summary.headline,
        });
        res.json(summary);
      } catch (error) {
        console.error('[settings] Resource tags could not be applied:', (error as Error).message);
        res.status(503).json({
          error: 'resource_tagging_unavailable',
          detail: 'Databricks did not start the resource tag update. No viewer credential was used.',
        });
      }
    });

    /**
     * Every connection, with what it was configured as, what the running system
     * used, and what somebody intends it to be.
     *
     * Answers 200 even when the orchestrator is unreachable. The payload then
     * says so (`orchestratorReported: false` plus a drift finding), because a
     * deployer arriving here to find out why nothing works is the main audience,
     * and a 503 would leave them with the app-side half they can already see.
     */
    app.get('/api/settings', async (req, res) => {
      const { report, answered } = await readOrchestratorReport();
      const stored = await readStoredSettings(appkit);
      const environment = appEnvironment();
      const payload = settingsPayload({
        report,
        endpointAnswered: answered,
        environment,
        stored,
        appBuildSha: appBuildSha(),
        appBuildAncestors: appBuildAncestors(),
        // Asked separately, because `readStoredSettings` degrades an outage to
        // an empty map and that is indistinguishable from "nothing saved yet"
        // unless the state of the store is reported beside it. The same
        // distinction /api/storage draws, for the same reason.
        storeAvailable: await storeAnswers(appkit),
        // The app's own record: the host, the description, the compute and the
        // release. Read here rather than on its own route so the Build card
        // cannot end up describing one moment while the rows below it describe
        // another, which is the reason every other fact on this page arrives on
        // this payload too.
        app: await readAppFacts(),
      });
      const states = resourceStates({ report, environment, stored });
      res.json({
        ...payload,
        checks: await readReachability(req, { report, environment, stored }),
        // Assembled here rather than inside `settingsPayload` for the reason that
        // function's own comment gives: it is pure, and both of these need a round
        // trip. The notebook read also needs the request, because it is made as the
        // signed-in user.
        notebook: await readNotebook(req, appkit, report, stored),
        connections: await readConnections(appkit, states),
      });
    });

    app.put('/api/settings/notebook-path', requireAdmin(appkit.lakebase, userEmail), async (req, res) => {
      const parsed = NotebookPathBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_notebook_path', detail: parsed.error.message });
        return;
      }
      try {
        const savedResult = await validateAndStoreNotebookPath({
          appkit,
          path: parsed.data.path,
          host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
          token: forwardedUserToken(req) ?? '',
          updatedBy: userEmail(req),
        });
        if (!savedResult.ok) {
          res.status(savedResult.status).json({
            error: 'notebook_path_not_usable',
            detail: savedResult.detail,
          });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: 'connection-setting-saved',
          subject: 'notebook-path',
          detail: 'Configured the workspace notebook shown on Connections.',
        });
        res.json({ path: savedResult.saved.value });
      } catch (error) {
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail: `The notebook path was validated but not saved: ${(error as Error).message}`,
        });
      }
    });

    /**
     * Add an asset to the list the agent may consider.
     *
     * 201 carries `effect`, which says in one sentence that this granted nobody
     * anything. It is on the response rather than only in the client because a
     * caller that reported "connected" without it would be telling a customer the
     * opposite of what happened.
     */
    app.post('/api/settings/connections', async (req, res) => {
      const parsed = ConnectionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_connection_body', detail: parsed.error.message });
        return;
      }
      const fault = addFault(parsed.data);
      if (fault) {
        res.status(400).json({ error: 'connection_not_allowed', detail: fault });
        return;
      }
      try {
        const connection = await writeDeclaredConnection(appkit, {
          id: parsed.data.id,
          label: parsed.data.label || parsed.data.id,
          kind: parsed.data.kind as ResourceKind,
          value: parsed.data.value,
          note: parsed.data.note,
          origin: 'app',
          changedBy: userEmail(req),
        });
        res.status(201).json({ connection, effect: addedConnectionEffect() });
      } catch (error) {
        console.error('[connections] The connection could not be added:', (error as Error).message);
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail:
            'The connection was not added. The app stores these in Lakebase, and it is not ' +
            'answering: reporting success here would leave a row on screen that no restart would keep.',
        });
      }
    });

    /**
     * What withdrawing this connection would cost, without withdrawing it.
     *
     * A route of its own so the confirmation a reader sees is computed from the
     * stored row and the live configuration rather than from what the client
     * happens to be holding. The dangerous case is the one where the running model
     * is configured with the same value and withdrawal changes nothing about the
     * deployment, and a client-side guess would get that wrong.
     */
    app.get('/api/settings/connections/:id/impact', async (req, res) => {
      const connections = await readDeclaredConnections(appkit);
      const connection = connections.find((entry) => entry.id === req.params.id);
      if (!connection) {
        res.status(404).json({ error: 'no_such_connection', detail: 'Nothing is declared under that name.' });
        return;
      }
      res.json({ impact: await impactFor(appkit, connection) });
    });

    /**
     * Withdraw a connection, keeping the row so it can be put back.
     *
     * The impact is returned WITH the withdrawal as well as being available before
     * it, so a caller that skipped the preview still has to be handed what stopped
     * working rather than a bare success.
     */
    app.delete('/api/settings/connections/:id', async (req, res) => {
      try {
        const connections = await readDeclaredConnections(appkit);
        const connection = connections.find((entry) => entry.id === req.params.id);
        if (!connection || connection.state === 'withdrawn') {
          res.status(404).json({
            error: 'no_such_connection',
            detail: connection ? 'That connection is already withdrawn.' : 'Nothing is declared under that name.',
          });
          return;
        }
        const impact = await impactFor(appkit, connection);
        const withdrawn = await withdrawDeclaredConnection(appkit, req.params.id, userEmail(req));
        if (!withdrawn) {
          res.status(404).json({ error: 'no_such_connection', detail: 'That connection is already withdrawn.' });
          return;
        }
        res.json({ connection: withdrawn, impact, restorable: true });
      } catch (error) {
        console.error('[connections] The connection could not be withdrawn:', (error as Error).message);
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail: 'The connection was not withdrawn.',
        });
      }
    });

    /** Put a withdrawn connection back. */
    app.post('/api/settings/connections/:id/restore', async (req, res) => {
      try {
        const restored = await restoreDeclaredConnection(appkit, req.params.id, userEmail(req));
        if (!restored) {
          res.status(404).json({
            error: 'no_such_connection',
            detail: 'There is no withdrawn connection under that name to put back.',
          });
          return;
        }
        res.json({ connection: restored, effect: addedConnectionEffect() });
      } catch (error) {
        console.error('[connections] The connection could not be restored:', (error as Error).message);
        res.status(503).json({ error: 'settings_store_unavailable', detail: 'The connection was not restored.' });
      }
    });

    /**
     * Permanently forget one stored connection.
     *
     * The ordinary DELETE above is intentionally recoverable and leaves a
     * withdrawn row behind. This narrower route backs the explicitly destructive
     * confirmation in the client; success therefore means the Lakebase row is
     * gone, not merely hidden from the active list.
     */
    app.delete('/api/settings/connections/:id/forever', async (req, res) => {
      try {
        const forgotten = await forgetDeclaredConnection(appkit, req.params.id);
        if (!forgotten) {
          res.status(404).json({
            error: 'no_such_connection',
            detail: 'There is no remembered connection under that name.',
          });
          return;
        }
        res.json({ forgotten: { id: req.params.id }, restorable: false });
      } catch (error) {
        console.error('[connections] The connection could not be forgotten:', (error as Error).message);
        res.status(503).json({
          error: 'settings_store_unavailable',
          detail: 'The remembered connection was not removed. Nothing changed.',
        });
      }
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
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: 'connection-setting-saved',
          subject: resourceId,
          detail: `${decision.intent} value recorded for ${resourceId}`,
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
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: 'connection-setting-cleared',
          subject: req.params.resourceId,
          detail: `cleared stored setting for ${req.params.resourceId}`,
        });
        res.json({ cleared: req.params.resourceId });
      } catch (error) {
        console.error(`[settings] ${req.params.resourceId} could not be cleared:`, (error as Error).message);
        res.status(503).json({ error: 'settings_store_unavailable', detail: 'The value was not cleared.' });
      }
    });

    /** Preview the declaration the canonical admin release endpoint snapshots. */
    app.get('/api/settings/apply', async (req, res) => {
      res.json(await buildApplyResponse(req, appkit));
    });

    /**
     * Create the immutable approval record Connections hands to a notebook.
     *
     * There is intentionally no request body: the server snapshots the same
     * current plan it just displayed and takes the actor from the trusted
     * forwarded identity. A caller cannot swap either after review.
     */
    app.post('/api/admin/model-releases', async (req, res) => {
      try {
        const current = await buildApplyResponse(req, appkit);
        if (!current.plan.hasOverrides) {
          res.status(409).json({
            error: 'nothing_to_release',
            detail: 'Nothing is waiting on a new model version.',
          });
          return;
        }
        if (!current.target || current.target.startsWith('<')) {
          res.status(409).json({
            error: 'release_target_unavailable',
            detail:
              'This app was not released with its bundle target recorded. Redeploy the app before approving a notebook release.',
          });
          return;
        }
        const declaration = releaseDeclaration(current.plan);
        const release = await createModelRelease(appkit, {
          id: randomUUID(),
          requestedBy: userEmail(req),
          declaration,
          target: current.target,
          endpointName: textEnv(process.env.DATABRICKS_SERVING_ENDPOINT_NAME),
          modelName: current.modelName,
          vFrom: current.vFrom,
          preflightAtRequest: current.preflight,
        });
        res.status(201).json({ release });
      } catch (error) {
        console.error('[model-release] The approval could not be recorded:', (error as Error).message);
        res.status(503).json({
          error: 'release_store_unavailable',
          detail: 'The release request was not recorded. Lakebase did not accept the audit row.',
        });
      }
    });

    app.get('/api/admin/model-releases', async (req, res) => {
      const requested = Number(req.query.limit ?? 20);
      const releases = await listModelReleases(appkit, Number.isFinite(requested) ? requested : 20);
      res.json({ releases });
    });

    app.get('/api/admin/model-releases/:id', async (req, res) => {
      const release = await readModelRelease(appkit, req.params.id);
      if (!release) {
        res.status(404).json({ error: 'no_such_release_request' });
        return;
      }
      res.json({ release });
    });

    app.post('/api/admin/model-releases/:id/claim', async (req, res) => {
      const parsed = ClaimBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_claim', detail: parsed.error.message });
        return;
      }
      const result = await claimModelRelease(appkit, req.params.id, parsed.data.executionId, userEmail(req));
      if (!result.release) {
        res.status(404).json({ error: 'no_such_release_request' });
        return;
      }
      if (!result.claimed) {
        res.status(409).json({
          error: 'release_request_already_claimed',
          detail: 'Another helper already claimed this request, or it is already complete.',
          release: result.release,
        });
        return;
      }
      res.json({ release: result.release });
    });

    app.post('/api/admin/model-releases/:id/status', async (req, res) => {
      const parsed = CompletionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_release_status', detail: parsed.error.message });
        return;
      }
      const result = await completeModelRelease(appkit, req.params.id, userEmail(req), parsed.data);
      if (!result.release) {
        res.status(404).json({ error: 'no_such_release_request' });
        return;
      }
      if (!result.updated) {
        res.status(409).json({
          error: 'invalid_release_transition',
          detail: 'Only the helper that claimed a running request may complete it.',
          release: result.release,
        });
        return;
      }
      res.json({ release: result.release });
    });
  });
}

/** Apply plan plus UI status fields, built from the live settings + notebook. */
async function buildApplyResponse(
  req: Request,
  appkit: InsightsAppKit
): Promise<{
  status: 'idle' | 'ready';
  plan: ApplyPlan;
  target: string;
  vFrom: string | null;
  modelName: string;
  preflight: ReleasePreflight | null;
}> {
  const { report, answered } = await readOrchestratorReport();
  const stored = await readStoredSettings(appkit);
  const environment = appEnvironment();
  const payload = settingsPayload({
    report,
    endpointAnswered: answered,
    environment,
    stored,
    appBuildSha: appBuildSha(),
    appBuildAncestors: appBuildAncestors(),
    storeAvailable: await storeAnswers(appkit),
    app: await readAppFacts(),
  });
  const notebookPanel = await readNotebook(req, appkit, report, stored);
  const intended = intendedFromResources(payload.resources);
  const notebook = settingsFromDeclaration(notebookPanel.read.declaration);
  const target =
    textEnv(process.env.PLAYER_INSIGHTS_TARGET) || textEnv(process.env.DATABRICKS_BUNDLE_TARGET) || '<your-target>';
  const plan = resolveApplyPlan({ intended, notebook, target });
  const live = liveConfiguration(report);
  const vFrom = live.model_version || null;
  return {
    status: plan.hasOverrides ? 'ready' : 'idle',
    plan,
    target,
    vFrom,
    modelName: live.model_name || textEnv(process.env.PLAYER_INSIGHTS_MODEL_NAME),
    preflight: releasePreflight(report),
  };
}

function releasePreflight(report: PreflightReport | null): ReleasePreflight | null {
  if (!report) return null;
  return {
    status: report.status,
    checkedAt: report.checked_at,
    ok: report.counts.ok,
    failed: report.counts.failed,
    unverified: report.counts.unverified,
  };
}

function canonicalSettings(settings: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)))
  );
}

/** The exact declaration document persisted and later handed to Python. */
export function releaseDeclaration(plan: ApplyPlan): ModelReleaseDeclaration {
  const settings = Object.fromEntries(plan.knobs.map((knob) => [knob.key, knob.value]));
  const body = `connections-apply\n${canonicalSettings(settings)}`;
  return {
    source: 'connections-apply',
    revision: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    settings,
  };
}

function textEnv(value: string | undefined): string {
  return (value ?? '').trim();
}

export function configuredNotebookPath(
  stored: ReadonlyMap<string, StoredSetting>,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const saved = stored.get('notebook-path');
  if (saved?.intent === 'active' && saved.value.trim()) return saved.value.trim();
  return environment.PLAYER_INSIGHTS_NOTEBOOK_PATH?.trim() ?? '';
}

/** What the notebook published, and how it compares with what is running. */
export interface NotebookPanel {
  /** The table the declaration is read from, or '' when none is configured. */
  location: string;
  /** Workspace notebook selected by an administrator, if one is saved. */
  configuredPath: string;
  /** Workspace notebook recorded by the latest declaration, if one was read. */
  observedPath: string;
  read: DeclarationRead;
  /** One entry per published setting. Empty when nothing was read. */
  comparison: DeclarationComparison[];
}

/**
 * The values the running orchestrator reported, keyed by its own field names.
 *
 * Taken from the configuration report rather than from `resourceStates`, because a
 * declaration is compared against agent field names and the states are keyed by
 * this app's registry ids. A value that is not a readable scalar is skipped, so a
 * key nobody can read is compared against nothing and reads as unknown rather than
 * as a disagreement.
 */
export function liveConfiguration(report: PreflightReport | null): Record<string, string> {
  const live: Record<string, string> = {};
  for (const entry of report?.configuration ?? []) {
    const key = String(entry.key ?? '');
    if (!key) continue;
    const value = entry.value;
    if (typeof value === 'string') live[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') live[key] = String(value);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      live[key] = value.join(',');
    }
  }
  return live;
}

/**
 * Read the notebook's declaration and line it up against the running model.
 *
 * Never rejects, for the same reason as `readReachability`: the notebook row is one
 * of the things this page reports on, and a page opened to diagnose a deployment
 * must not be taken down by one of its subjects.
 */
async function readNotebook(
  req: Request,
  appkit: InsightsAppKit,
  report: PreflightReport | null,
  storedInput?: ReadonlyMap<string, StoredSetting>
): Promise<NotebookPanel> {
  try {
    const stored = storedInput ?? (await readStoredSettings(appkit));
    const configuredPath = configuredNotebookPath(stored);
    const location = await resolveNotebookDeclaration(appkit);
    const read = await readPublishedDeclaration({
      location,
      // The APP's own warehouse, which is what app.yaml binds. The orchestrator's
      // is in the model artifact and is not the app's to run statements on.
      warehouseId: process.env.DATABRICKS_SQL_WAREHOUSE_ID?.trim() ?? '',
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      // Absent reads as "nobody to read as", which the reader is told. It is never
      // replaced by the app's own credential.
      token: forwardedUserToken(req) ?? '',
    });
    return {
      location,
      configuredPath,
      observedPath: read.declaration?.source?.trim() ?? '',
      read,
      comparison: read.declaration ? compareDeclaration(read.declaration, liveConfiguration(report)) : [],
    };
  } catch (error) {
    console.warn('[settings] The notebook declaration could not be read:', (error as Error).message);
    return {
      location: '',
      configuredPath: '',
      observedPath: '',
      read: {
        declaration: null,
        failure: 'unavailable',
        detail: 'The published declaration could not be read just now.',
      },
      comparison: [],
    };
  }
}

/** Every declared asset, with what withdrawing it would cost. */
export interface ConnectionEntry {
  connection: StoredDeclaredConnection;
  impact: RemovalImpact;
}

/**
 * The values the running deployment is configured with, as plain strings.
 *
 * Used only to decide whether withdrawing a declaration would change anything
 * about the running agent. Read from the same states the rows show, so the warning
 * agrees with the page it appears on.
 */
function configuredValues(states: ReturnType<typeof resourceStates>): string[] {
  const values: string[] = [];
  for (const state of states) {
    if (state.configured) values.push(state.configured);
    if (state.actual) values.push(state.actual);
  }
  return values;
}

async function impactFor(appkit: InsightsAppKit, connection: StoredDeclaredConnection): Promise<RemovalImpact> {
  const { report } = await readOrchestratorReport();
  const stored = await readStoredSettings(appkit);
  const states = resourceStates({ report, environment: appEnvironment(), stored });
  return removalImpact(connection, configuredValues(states));
}

async function readConnections(
  appkit: InsightsAppKit,
  states: ReturnType<typeof resourceStates>
): Promise<ConnectionEntry[]> {
  const live = configuredValues(states);
  const connections = await readDeclaredConnections(appkit);
  return connections.map((connection) => ({
    connection,
    impact: removalImpact(connection, live),
  }));
}

/**
 * What the signed-in user can actually reach, asked of the workspace.
 *
 * THE JOB THE PAGE PROMISED AND NOBODY PICKED UP. `/api/preflight` has said for
 * releases that "whether a principal can reach a table, a warehouse or a Genie
 * space is answered by Unity Catalog and the workspace, which hold the grants",
 * because the orchestrator retired its own dependency report. That sentence
 * names where the answer lives; nothing went and got it, so the page carried on
 * offering to report reachability and answered `Not checked` for everything but
 * the two things the app probes for itself.
 *
 * Asked under the SIGNED-IN USER's forwarded token rather than the app's own
 * credential, because this app runs on behalf of the user and a reachability
 * answer computed under a service principal describes somebody who is not
 * reading the page. That is also why nothing here throws on a missing token:
 * `/api/settings` is one of the diagnostics that must keep answering when the
 * rest of the API is refusing, and the absent token is itself part of the
 * explanation a reader came for. It is reported as unchecked, which is what it
 * is.
 *
 * Never rejects. A dependency probe that took the settings route down would take
 * down the page somebody opens to find out why the deployment is misbehaving.
 */
async function readReachability(
  req: Request,
  input: {
    report: PreflightReport | null;
    environment: Record<string, string>;
    stored: Map<string, StoredSetting>;
  }
): Promise<PreflightCheck[]> {
  try {
    // Probed against the value each ROW SHOWS as configured, which is the
    // resolved one: the artifact's where the orchestrator owns it, and a saved
    // override ahead of the variable ahead of the compiled default where the app
    // does. Reading the raw configuration instead would answer about a value the
    // reader cannot see.
    const configured = Object.fromEntries(resourceStates(input).map((state) => [state.resource.id, state.configured]));
    const checks = await probeConnections({
      configured,
      tables: accessDependenciesFrom({
        configuration: input.report?.configuration ?? [],
        env: process.env,
      }).tables,
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      token: forwardedUserToken(req),
      principal: req.header('x-forwarded-email')?.trim() ?? '',
    });
    // The MLflow experiment, asked as the APPLICATION rather than as the reader,
    // because Databricks Apps has no MLflow scope to forward -- see
    // experiment-probe.ts, which carries the list of names the Apps API rejects.
    // Appended rather than folded into the probe set above so the scope
    // derivation, and the test that holds the bundle to it, are untouched.
    const experiment = await checkExperimentAsApp(configured['experiment-id'] ?? '');
    return experiment ? [...checks, experiment] : checks;
  } catch (error) {
    console.warn('[settings] The dependency probes could not be run:', (error as Error).message);
    return [];
  }
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
    await appkit.lakebase.query(`SELECT 1 FROM ${APP_SCHEMA}.deployment_settings LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}
