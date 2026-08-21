import { describe, expect, it } from 'vitest';
import { sendAccountSlackMessage, SlackConfigurationError, workspaceAppsHref } from './account-routes';

type RecordedCall = { input: string; init?: RequestInit };

function parsedBody(call: RecordedCall): Record<string, unknown> {
  const body = call.init?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

describe('account Slack messages', () => {
  it('refuses missing server configuration without calling Slack', async () => {
    let calls = 0;
    const transport = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(new Response());
    };
    await expect(
      sendAccountSlackMessage(
        {
          kind: 'escalation',
          message: 'Please help with this deployment.',
          pageUrl: 'https://astrolabe.example/runs/one',
          user: 'jordan.lee@example.com',
        },
        {},
        transport
      )
    ).rejects.toEqual(
      new SlackConfigurationError(['ASTROLABE_SLACK_BOT_TOKEN', 'ASTROLABE_SLACK_SUPER_ADMIN_USER_ID'])
    );
    expect(calls).toBe(0);
  });

  it('opens the configured DM and sends message, page, and signed-in user', async () => {
    const calls: RecordedCall[] = [];
    const responses = [
      new Response(JSON.stringify({ ok: true, channel: { id: 'D-SUPER' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({ ok: true, channel: 'D-SUPER', ts: '172419.1234' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ];
    const transport = (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected Slack call');
      return Promise.resolve(response);
    };

    const result = await sendAccountSlackMessage(
      {
        kind: 'escalation',
        message: 'Please help with this deployment.',
        pageUrl: 'https://astrolabe.example/runs/one',
        user: 'jordan.lee@example.com',
      },
      {
        ASTROLABE_SLACK_BOT_TOKEN: 'test-token',
        ASTROLABE_SLACK_SUPER_ADMIN_USER_ID: 'U-SUPER',
      },
      transport
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].input).toBe('https://slack.com/api/conversations.open');
    expect(parsedBody(calls[0])).toEqual({ users: 'U-SUPER' });
    expect(calls[1].input).toBe('https://slack.com/api/chat.postMessage');
    const posted = parsedBody(calls[1]);
    expect(posted.channel).toBe('D-SUPER');
    if (typeof posted.text !== 'string') throw new Error('Expected Slack message text');
    expect(posted.text).toContain('Please help with this deployment.');
    expect(posted.text).toContain('jordan.lee@example.com');
    expect(posted.text).toContain('https://astrolabe.example/runs/one');
    expect(result.permalink).toBe('https://slack.com/archives/D-SUPER/p1724191234');
  });

  it('routes feedback through its separate configured DM', async () => {
    const calls: RecordedCall[] = [];
    const responses = [
      new Response(JSON.stringify({ ok: true, channel: { id: 'D-FEEDBACK' } })),
      new Response(JSON.stringify({ ok: true, channel: 'D-FEEDBACK', ts: '1.2' })),
    ];
    const transport = (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected Slack call');
      return Promise.resolve(response);
    };

    await sendAccountSlackMessage(
      {
        kind: 'feedback',
        message: 'The label should be clearer.',
        pageUrl: 'https://astrolabe.example/',
        user: 'jordan.lee@example.com',
      },
      {
        ASTROLABE_SLACK_BOT_TOKEN: 'test-token',
        ASTROLABE_SLACK_FEEDBACK_USER_ID: 'U-FEEDBACK',
      },
      transport
    );

    expect(parsedBody(calls[0])).toEqual({ users: 'U-FEEDBACK' });
  });
});

describe('Databricks Apps link', () => {
  it('uses the configured workspace and never guesses one', () => {
    expect(workspaceAppsHref({ DATABRICKS_HOST: 'workspace.example.com/' })).toBe('https://workspace.example.com/apps');
    expect(workspaceAppsHref({})).toBe('');
  });
});
