import { accountFeedbackTargets } from '../../shared/account-feedback';
import { workspaceAppsUrl } from '../../shared/databricks-links';
import type { InsightsAppKit } from './insights-routes';

export const ACCOUNT_FEEDBACK_SLACK_URL_ENV = 'PLAYER_INSIGHTS_FEEDBACK_SLACK_URL';
export const ACCOUNT_FEEDBACK_SLACK_LABEL_ENV = 'PLAYER_INSIGHTS_FEEDBACK_SLACK_LABEL';
export const ACCOUNT_ESCALATION_SLACK_URL_ENV = 'PLAYER_INSIGHTS_ESCALATION_SLACK_URL';
export const ACCOUNT_ESCALATION_SLACK_LABEL_ENV = 'PLAYER_INSIGHTS_ESCALATION_SLACK_LABEL';

export function workspaceAppsHref(env: NodeJS.ProcessEnv = process.env): string {
  return workspaceAppsUrl(env.DATABRICKS_HOST ?? '', env.DATABRICKS_WORKSPACE_ID);
}

export function accountFeedbackTargetsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return accountFeedbackTargets(
    env[ACCOUNT_FEEDBACK_SLACK_URL_ENV],
    env[ACCOUNT_FEEDBACK_SLACK_LABEL_ENV],
    env[ACCOUNT_ESCALATION_SLACK_URL_ENV],
    env[ACCOUNT_ESCALATION_SLACK_LABEL_ENV]
  );
}

export function setupAccountRoutes(appkit: Pick<InsightsAppKit, 'server'>) {
  appkit.server.extend((app) => {
    app.get('/api/account/feedback-targets', (_req, res) => {
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.json(accountFeedbackTargetsFromEnv());
    });

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
