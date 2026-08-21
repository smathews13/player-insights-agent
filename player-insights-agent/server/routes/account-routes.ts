import { workspaceAppsUrl } from '../../shared/databricks-links';
import type { InsightsAppKit } from './insights-routes';

export function workspaceAppsHref(env: NodeJS.ProcessEnv = process.env): string {
  return workspaceAppsUrl(env.DATABRICKS_HOST ?? '', env.DATABRICKS_WORKSPACE_ID);
}

export function setupAccountRoutes(appkit: Pick<InsightsAppKit, 'server'>) {
  appkit.server.extend((app) => {
    app.get('/api/account/apps', (_req, res) => {
      const href = workspaceAppsHref();
      if (!href) {
        res.status(503).json({
          error: 'workspace_apps_unavailable',
          detail: 'This app does not know its Databricks workspace URL, so it cannot open the Apps page.',
        });
        return;
      }
      res.redirect(303, href);
    });
  });
}
