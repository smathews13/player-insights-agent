import { z } from 'zod';
import type { Request, Response } from 'express';
import { recordAdminAction } from '../lib/admin-roles';
import { applyAstrolabeTags, type ResourceTagSummary } from '../lib/resource-tagging';
import { clearResourceTagResult, readResourceTagResult, writeResourceTagResult } from '../lib/resource-tag-state';
import { forwardedUserToken } from './access-verification';
import { userEmail, type InsightsAppKit, type PreflightReport } from './insights-routes';

const ApplyBody = z
  .strictObject({
    mode: z.enum(['unresolved', 'full']).default('unresolved'),
  })
  .default({ mode: 'unresolved' });

export interface ResourceTagRouteDependencies {
  readReport: () => Promise<PreflightReport | null>;
  resolveExperimentId: () => Promise<string>;
  apply?: typeof applyAstrolabeTags;
  read?: typeof readResourceTagResult;
  write?: typeof writeResourceTagResult;
  clear?: typeof clearResourceTagResult;
}

function requestCancellation(req: Request, res: Response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', abort);
  res.once('close', close);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abort);
      res.off('close', close);
    },
  };
}

export function setupResourceTagRoutes(appkit: InsightsAppKit, dependencies: ResourceTagRouteDependencies): void {
  const apply = dependencies.apply ?? applyAstrolabeTags;
  const read = dependencies.read ?? readResourceTagResult;
  const write = dependencies.write ?? writeResourceTagResult;
  const clear = dependencies.clear ?? clearResourceTagResult;

  appkit.server.extend((app) => {
    app.get('/api/settings/resource-tags', async (_req, res) => {
      try {
        res.json({ summary: await read(appkit) });
      } catch (error) {
        console.error('[resource-tags] Saved result could not be read:', (error as Error).message);
        res.status(503).json({
          error: 'resource_tag_result_unavailable',
          detail: 'The saved Resource Tags result could not be read from Lakebase.',
        });
      }
    });

    app.post('/api/settings/resource-tags', async (req, res) => {
      const parsed = ApplyBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_resource_tag_request', detail: parsed.error.message });
        return;
      }
      const cancellation = requestCancellation(req, res);
      try {
        const [report, experimentId, previous] = await Promise.all([
          dependencies.readReport(),
          dependencies.resolveExperimentId(),
          read(appkit),
        ]);
        const summary = await apply({
          report,
          environment: { ...process.env, PLAYER_INSIGHTS_EXPERIMENT_ID: experimentId },
          token: forwardedUserToken(req),
          host: process.env.DATABRICKS_HOST,
          previous,
          mode: parsed.data.mode,
          signal: cancellation.signal,
        });
        await write(appkit, summary, userEmail(req));
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: 'resource-tags-applied',
          subject: 'system_billing=player-insights-agent',
          detail: summary.headline,
        });
        res.json(summary);
      } catch (error) {
        if (cancellation.signal.aborted) return;
        console.error('[resource-tags] Apply failed before a result could be saved:', (error as Error).message);
        res.status(503).json({
          error: 'resource_tagging_unavailable',
          detail: 'The Resource Tags run did not complete, so the previous saved result was kept.',
        });
      } finally {
        cancellation.dispose();
      }
    });

    app.delete('/api/settings/resource-tags', async (req, res) => {
      try {
        const removed = await clear(appkit, userEmail(req));
        res.json({
          cleared: true,
          removed,
          detail: 'Saved results cleared. Applied Databricks tags were not removed.',
        });
      } catch (error) {
        console.error('[resource-tags] Clear failed:', (error as Error).message);
        res.status(503).json({
          error: 'resource_tag_clear_failed',
          detail: 'Results were not cleared. The saved result is unchanged.',
        });
      }
    });
  });
}

export type { ResourceTagSummary };
