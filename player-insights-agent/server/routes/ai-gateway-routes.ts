import type { Request, Response } from 'express';
import { AiGatewayModeSchema, AiGatewaySelectionSchema } from '../../shared/ai-gateway-contract';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import {
  discoverAiGatewayCandidates,
  stageAiGatewaySelection,
  summarizeAiGateway,
  validateAiGatewayCandidate,
  type AiGatewayWorkspaceOptions,
} from '../lib/ai-gateway';
import { readStoredSettings } from '../lib/app-settings';
import { recordAdminAction } from '../lib/admin-roles';
import { executionToken } from '../lib/execution-credential';
import { readModelRelease } from '../lib/model-release-store';
import type { InsightsAppKit } from './insights-routes';
import { userEmail } from './insights-routes';
import { liveConfiguration, readOrchestratorReport } from './settings-routes';

export const AI_GATEWAY_ROUTE_DEADLINE_MS = 12_000;

function query(req: Request, key: string, max = 200): string {
  const value = req.query[key];
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requestOptions(req: Request, res: Response): { options: AiGatewayWorkspaceOptions; cleanup: () => void } {
  const disconnected = new AbortController();
  const onAbort = () => disconnected.abort(new DOMException('Client disconnected', 'AbortError'));
  const onClose = () => {
    if (!res.writableEnded) onAbort();
  };
  req.once('aborted', onAbort);
  res.once('close', onClose);
  return {
    options: {
      host: normalizeWorkspaceHost(process.env.DATABRICKS_HOST),
      token: executionToken(req) ?? '',
      principal: userEmail(req),
      signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(AI_GATEWAY_ROUTE_DEADLINE_MS)]),
    },
    cleanup: () => {
      req.off('aborted', onAbort);
      res.off('close', onClose);
    },
  };
}

function statusForValidation(state: string): number {
  if (state === 'permission-blocked') return 403;
  if (state === 'unavailable') return 503;
  if (state === 'invalid') return 400;
  return 200;
}

function browserValidation(validation: Awaited<ReturnType<typeof validateAiGatewayCandidate>>) {
  return {
    state: validation.state,
    detail: validation.detail,
    validatedAt: validation.validatedAt,
    candidate: validation.candidate,
  };
}

async function currentSummary(req: Request, res: Response, appkit: InsightsAppKit): Promise<void> {
  const stored = await readStoredSettings(appkit);
  const { report } = await readOrchestratorReport();
  const active = liveConfiguration(report);
  const gateway = stored.get('llm-gateway');
  const model = stored.get('llm-endpoint');
  const stagedMode = gateway?.intent === 'intended' ? AiGatewayModeSchema.safeParse(gateway.value) : null;
  const mode = stagedMode?.success ? stagedMode.data : undefined;
  const candidateId = model?.intent === 'intended' ? model.value.trim() : '';
  const { options, cleanup } = requestOptions(req, res);
  try {
    // Empty active route is deliberately not probed. Direct is the normal state,
    // and Gateway discovery must not become answer-path health while inactive.
    const validation =
      mode !== undefined && candidateId
        ? await validateAiGatewayCandidate({ mode, candidateId, options })
        : active.llm_gateway && active.llm_endpoint
          ? await validateAiGatewayCandidate({
              mode: active.llm_gateway as 'mlflow' | 'openai',
              candidateId: active.llm_endpoint,
              options,
            })
          : undefined;
    if (!res.destroyed && !res.writableEnded) {
      res.json(
        summarizeAiGateway({
          activeMode: active.llm_gateway ?? '',
          activeModel: active.llm_endpoint ?? '',
          stored,
          validation,
        })
      );
    }
  } finally {
    cleanup();
  }
}

export function setupAiGatewayRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/admin/ai-gateway/summary', async (req, res) => {
      await currentSummary(req, res, appkit);
    });

    app.get('/api/admin/ai-gateway/candidates', async (req, res) => {
      const mode = AiGatewayModeSchema.safeParse(query(req, 'mode', 20));
      if (!mode.success) {
        res.status(400).json({ error: 'invalid_gateway_mode', detail: 'Choose Direct, MLflow, or OpenAI.' });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const payload = await discoverAiGatewayCandidates({
          mode: mode.data,
          query: query(req, 'q'),
          options,
        });
        if (!res.destroyed && !res.writableEnded) res.json(payload);
      } finally {
        cleanup();
      }
    });

    app.post('/api/admin/ai-gateway/validate', async (req, res) => {
      const parsed = AiGatewaySelectionSchema.omit({ expectedRevision: true }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_gateway_selection', detail: parsed.error.message });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const validation = await validateAiGatewayCandidate({ ...parsed.data, options });
        if (!res.destroyed && !res.writableEnded) {
          res.status(statusForValidation(validation.state)).json(browserValidation(validation));
        }
      } finally {
        cleanup();
      }
    });

    app.post('/api/admin/ai-gateway/stage', async (req, res) => {
      const parsed = AiGatewaySelectionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_gateway_selection', detail: parsed.error.message });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const validation = await validateAiGatewayCandidate({
          mode: parsed.data.mode,
          candidateId: parsed.data.candidateId,
          options,
        });
        if (validation.state !== 'validated') {
          res.status(statusForValidation(validation.state)).json(validation);
          return;
        }
        const staged = await stageAiGatewaySelection({
          store: appkit,
          ...parsed.data,
          actor: userEmail(req),
          validation,
        });
        if (!staged.ok) {
          res.status(409).json({
            error: 'stale_gateway_selection',
            detail: 'Gateway settings changed after this form was opened. Reload and review the current pair.',
          });
          return;
        }
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: 'ai-gateway-selection-staged',
          subject: parsed.data.candidateId,
          detail: `Staged ${parsed.data.mode || 'direct'} transport and model as one intended pair.`,
        });
        res.json({
          state: 'validated',
          detail: 'Staged for agent release. Existing direct model traffic is unchanged.',
          validatedAt: validation.validatedAt,
          candidate: validation.candidate,
          revision: staged.revision,
          stagedAt: staged.stagedAt,
        });
      } finally {
        cleanup();
      }
    });

    /**
     * Called by the notebook helper immediately before it claims a release.
     * This is a metadata-only gate: no inference and no Gateway PATCH/PUT.
     */
    app.post('/api/admin/ai-gateway/releases/:id/validate', async (req, res) => {
      const release = await readModelRelease(appkit, req.params.id);
      if (!release) {
        res.status(404).json({ error: 'no_such_release_request' });
        return;
      }
      const settings = release.declaration.settings;
      if (!Object.prototype.hasOwnProperty.call(settings, 'llm_gateway')) {
        res.json({ state: 'validated', detail: 'This release does not change AI Gateway routing.' });
        return;
      }
      const mode = AiGatewayModeSchema.safeParse(settings.llm_gateway);
      const candidateId = (settings.llm_endpoint ?? '').trim();
      if (!mode.success || !candidateId) {
        res.status(409).json({
          error: 'invalid_gateway_release_pair',
          detail: 'The approved release does not contain a coherent Gateway mode and foundation model pair.',
        });
        return;
      }
      const { options, cleanup } = requestOptions(req, res);
      try {
        const validation = await validateAiGatewayCandidate({ mode: mode.data, candidateId, options });
        const status = validation.state === 'validated' ? 200 : 409;
        res.status(status).json(browserValidation(validation));
      } finally {
        cleanup();
      }
    });
  });
}
