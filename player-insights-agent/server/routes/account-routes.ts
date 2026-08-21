import { z } from 'zod';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { userEmail, type InsightsAppKit } from './insights-routes';

const SlackMessageBody = z.object({
  kind: z.enum(['feedback', 'escalation']),
  message: z.string().trim().min(1).max(4_000),
  pageUrl: z.string().trim().url().max(2_048),
  user: z.string().trim().email().max(320),
});

type SlackMessage = z.infer<typeof SlackMessageBody>;
type SlackTransport = (input: string, init?: RequestInit) => Promise<Response>;

const DESTINATION_VARIABLE = {
  feedback: 'ASTROLABE_SLACK_FEEDBACK_USER_ID',
  escalation: 'ASTROLABE_SLACK_SUPER_ADMIN_USER_ID',
} as const;

export class SlackConfigurationError extends Error {
  constructor(readonly missing: string[]) {
    super(`Slack messaging is not configured. Missing ${missing.join(', ')}.`);
    this.name = 'SlackConfigurationError';
  }
}

class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly slackError: string
  ) {
    super(`Slack ${method} failed: ${slackError}`);
    this.name = 'SlackApiError';
  }
}

async function slackCall<T extends Record<string, unknown>>(
  method: string,
  token: string,
  body: Record<string, unknown>,
  transport: SlackTransport
): Promise<T> {
  const response = await transport(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || payload.ok !== true) {
    throw new SlackApiError(method, payload.error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

/**
 * Open the configured private Slack conversation and send one account-menu
 * message. Recipient IDs and the token stay in the app environment.
 */
export async function sendAccountSlackMessage(
  input: SlackMessage,
  env: NodeJS.ProcessEnv = process.env,
  transport: SlackTransport = fetch
): Promise<{ permalink: string }> {
  const destinationVariable = DESTINATION_VARIABLE[input.kind];
  const token = env.ASTROLABE_SLACK_BOT_TOKEN?.trim() ?? '';
  const destination = env[destinationVariable]?.trim() ?? '';
  const missing = [...(token ? [] : ['ASTROLABE_SLACK_BOT_TOKEN']), ...(destination ? [] : [destinationVariable])];
  if (missing.length > 0) throw new SlackConfigurationError(missing);

  const opened = await slackCall<{ ok: true; channel: { id: string } }>(
    'conversations.open',
    token,
    { users: destination },
    transport
  );
  const heading = input.kind === 'feedback' ? 'Astrolabe feedback' : 'Astrolabe super admin escalation';
  const posted = await slackCall<{ ok: true; channel: string; ts: string }>(
    'chat.postMessage',
    token,
    {
      channel: opened.channel.id,
      text: `${heading}\n\n${input.message}\n\nFrom: ${input.user}\nPage: ${input.pageUrl}`,
      unfurl_links: false,
      unfurl_media: false,
    },
    transport
  );
  return {
    permalink: `https://slack.com/archives/${encodeURIComponent(posted.channel)}/p${posted.ts.replace('.', '')}`,
  };
}

export function workspaceAppsHref(env: NodeJS.ProcessEnv = process.env): string {
  const host = normalizeWorkspaceHost(env.DATABRICKS_HOST);
  return host ? `${host}/apps` : '';
}

export function setupAccountRoutes(appkit: Pick<InsightsAppKit, 'server'>) {
  appkit.server.extend((app) => {
    app.post('/api/account/slack-message', async (req, res) => {
      const parsed = SlackMessageBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_slack_message',
          detail: 'Send one message, page URL, action, and signed-in user.',
        });
        return;
      }

      const signedInAs = userEmail(req);
      if (parsed.data.user.toLowerCase() !== signedInAs.toLowerCase()) {
        res.status(409).json({
          error: 'identity_changed',
          detail: 'Your signed-in identity changed. Reload the page before sending this message.',
        });
        return;
      }

      try {
        const sent = await sendAccountSlackMessage({ ...parsed.data, user: signedInAs });
        res.json(sent);
      } catch (error) {
        if (error instanceof SlackConfigurationError) {
          res.status(503).json({
            error: 'slack_not_configured',
            detail: error.message,
          });
          return;
        }
        console.error('[account] Slack message was not sent:', (error as Error).message);
        res.status(502).json({
          error: 'slack_send_failed',
          detail: 'Slack did not accept the message. Nothing was sent.',
        });
      }
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
