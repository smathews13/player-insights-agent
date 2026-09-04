import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { canMutateConnections } from '../../shared/user-roster-contract';
import { recordAdminAction, resolveRoleForRequest } from '../lib/admin-roles';
import { browseRequestContext, validateLakebaseDatabase } from '../lib/browse-assets';
import { executionToken } from '../lib/execution-credential';
import {
  activeLakebaseBinding,
  LakebaseBindingNoOp,
  LakebaseBindingPlanConflict,
  lakebaseRedeployPlan,
  readDesiredLakebaseBinding,
  writeDesiredLakebaseBinding,
} from '../lib/lakebase-binding-plan';
import { APP_NAME_ENV } from '../lib/app-metadata';
import type { InsightsAppKit } from './insights-routes';
import { userEmail } from './insights-routes';

const StageBody = z.strictObject({
  database: z.string().trim().min(1).max(1024),
  expectedRevision: z.number().int().nonnegative(),
  expectedActiveDatabase: z.string().trim().max(1024),
});

function requestSignal(req: Request): AbortSignal {
  const disconnected = new AbortController();
  req.once('aborted', () => disconnected.abort(new DOMException('Client disconnected', 'AbortError')));
  return AbortSignal.any([disconnected.signal, AbortSignal.timeout(10_000)]);
}

function target(): string {
  return process.env.PLAYER_INSIGHTS_TARGET?.trim() || process.env.DATABRICKS_BUNDLE_TARGET?.trim() || '';
}

async function currentPlan(appkit: InsightsAppKit) {
  return lakebaseRedeployPlan({
    active: activeLakebaseBinding(),
    desired: await readDesiredLakebaseBinding(appkit),
    target: target(),
    workspaceHost: process.env.DATABRICKS_HOST,
    appName: process.env[APP_NAME_ENV],
  });
}

export async function mayManageLakebaseBinding(
  appkit: InsightsAppKit,
  req: Request,
  dependencies: {
    readRole?: () => ReturnType<typeof resolveRoleForRequest>;
  } = {}
): Promise<boolean> {
  const role = await (dependencies.readRole?.() ?? resolveRoleForRequest(appkit.lakebase, req, userEmail));
  return mayRoleManageLakebaseBinding(role.role);
}

export function mayRoleManageLakebaseBinding(role: string): boolean {
  return canMutateConnections(role);
}

/**
 * A bundle-managed plan, not a pool switch.
 *
 * These routes deliberately expose no PATCH/PUT to the Apps API. The app
 * service principal reads its own metadata, but a binding update replaces the
 * full App spec and requires reviewed bundle variables, grants, and restart.
 */
export function setupLakebaseBindingRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    const manager = async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (await mayManageLakebaseBinding(appkit, req)) {
          next();
          return;
        }
      } catch {
        // An unresolved role is not evidence of this capability.
      }
      res.status(403).json({
        error: 'lakebase_binding_manager_required',
        detail: 'This deployment restricts Lakebase binding plans to Admin and Super Admin.',
      });
    };

    app.get('/api/lakebase-binding', manager, async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        res.json(await currentPlan(appkit));
      } catch (error) {
        res.status(503).json({
          error: 'lakebase_binding_plan_unavailable',
          detail: `The active Lakebase binding is unchanged, but its staged plan could not be read: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/lakebase-binding/stage', manager, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const parsed = StageBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_lakebase_binding',
          detail: 'Choose a Lakebase database and reload the editor if its revision is missing.',
        });
        return;
      }
      const active = activeLakebaseBinding();
      if (parsed.data.expectedActiveDatabase !== active.database) {
        res.status(409).json({
          error: 'lakebase_binding_stale',
          detail: 'The active Lakebase binding changed after this editor opened. Reload and review the new deployment.',
        });
        return;
      }
      const validation = await validateLakebaseDatabase(
        parsed.data.database,
        browseRequestContext({
          token: executionToken(req),
          principal: userEmail(req),
          signal: requestSignal(req),
        })
      );
      if (!validation.ok) {
        res.status(validation.status).json({
          error: 'lakebase_binding_not_validated',
          detail: validation.detail,
        });
        return;
      }
      try {
        await writeDesiredLakebaseBinding(appkit, {
          ...parsed.data,
          updatedBy: userEmail(req),
          active,
        });
        const plan = await currentPlan(appkit);
        await recordAdminAction(appkit.lakebase, {
          actor: userEmail(req),
          action: 'connection-setting-saved',
          subject: plan.desired?.database ?? parsed.data.database,
          detail: 'Staged a bundle-managed Lakebase App resource replacement; the runtime pool was not changed.',
        });
        res.status(201).json(plan);
      } catch (error) {
        if (error instanceof LakebaseBindingPlanConflict) {
          res.status(409).json({ error: 'lakebase_binding_stale', detail: error.message });
          return;
        }
        if (error instanceof LakebaseBindingNoOp) {
          res.status(409).json({ error: 'lakebase_binding_noop', detail: error.message });
          return;
        }
        res.status(503).json({
          error: 'lakebase_binding_plan_unavailable',
          detail: `Nothing was staged. The active Lakebase binding is unchanged: ${(error as Error).message}`,
        });
      }
    });
  });
}
