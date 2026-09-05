import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONNECTED_RESOURCES } from '../shared/deployment-config';
import { readReleaseIntentions, RELEASE_INTENTION_KEYS, sanitizeReleaseError } from './read-release-intentions.mjs';

function fixtureCli(options: { tokenError?: Error } = {}) {
  const calls: string[][] = [];
  const cli = (args: string[]) => {
    calls.push(args);
    const command = args.slice(0, 2).join(' ');
    if (command === 'apps get') {
      return {
        resources: [
          {
            postgres: {
              branch: 'projects/project/branches/production',
              database: 'projects/project/branches/production/databases/app',
            },
          },
        ],
      };
    }
    if (command === 'postgres get-branch') return { status: { hosts: { host: 'direct.example' } } };
    if (command === 'postgres list-databases') {
      return [{ database_id: 'app', status: { postgres_database: 'app_database' } }];
    }
    if (command === 'current-user me') return { userName: 'release@example.com' };
    if (command === 'auth token') {
      if (options.tokenError) throw options.tokenError;
      return { access_token: 'oauth-secret' };
    }
    throw new Error(`unexpected CLI call: ${args.join(' ')}`);
  };
  return { calls, cli };
}

class FakeClient {
  static lastConfig: Record<string, unknown> | null = null;
  static rows: Record<string, unknown>[] = [
    {
      resource_id: 'catalog',
      value: 'target_catalog',
      updated_at: new Date('2026-09-05T00:00:00Z'),
      updated_by: 'admin@example.com',
    },
  ];

  constructor(config: Record<string, unknown>) {
    FakeClient.lastConfig = config;
  }

  async connect() {}
  async query() {
    return { rows: FakeClient.rows };
  }
  async end() {}
}

describe('machine-authenticated release intentions', () => {
  it('reads the app-owned settings with the release profile OAuth token', async () => {
    const { calls, cli } = fixtureCli();
    const payload = await readReleaseIntentions({
      profile: 'release-profile',
      appName: 'player-insights-agent',
      appSchema: 'player_insights',
      cli,
      Client: FakeClient,
    });

    expect(calls.some((args) => args.slice(0, 2).join(' ') === 'auth token')).toBe(true);
    expect(FakeClient.lastConfig).toMatchObject({
      host: 'direct.example',
      database: 'app_database',
      user: 'release@example.com',
      password: 'oauth-secret',
    });
    expect(payload).toEqual({
      source: 'lakebase-direct-oauth',
      resources: [
        {
          resource: { id: 'catalog', agentKey: 'catalog', label: 'catalog' },
          intended: 'target_catalog',
          intendedBy: 'admin@example.com',
          intendedAt: '2026-09-05T00:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('oauth-secret');
  });

  it('fails closed on a 401 credential error and redacts its bearer token', async () => {
    const { cli } = fixtureCli({ tokenError: new Error('401 Unauthorized: Bearer leaked-secret') });
    await expect(
      readReleaseIntentions({
        profile: 'release-profile',
        appName: 'player-insights-agent',
        appSchema: 'player_insights',
        cli,
        Client: FakeClient,
      })
    ).rejects.toThrow('401 Unauthorized: Bearer [REDACTED]');
  });

  it('has no browser-route or session fallback', () => {
    const source = readFileSync(new URL('read-release-intentions.mjs', import.meta.url), 'utf8');
    expect(source).not.toContain("execFileSync('curl'");
    expect(source).not.toContain("fetch('");
    expect(source).not.toContain('headers: { cookie:');
  });

  it('rejects a stored intention absent from the committed source contract', async () => {
    const previous = FakeClient.rows;
    FakeClient.rows = [{ resource_id: 'unknown-setting', value: 'x' }];
    const { cli } = fixtureCli();
    await expect(
      readReleaseIntentions({
        profile: 'release-profile',
        appName: 'player-insights-agent',
        appSchema: 'player_insights',
        cli,
        Client: FakeClient,
      })
    ).rejects.toThrow('absent from the release contract');
    FakeClient.rows = previous;
  });

  it('keeps the machine-reader map equal to every stageable model setting', () => {
    const expected = Object.fromEntries(
      CONNECTED_RESOURCES.filter((resource) => resource.stageable && resource.agentKey).map((resource) => [
        resource.id,
        resource.agentKey,
      ])
    );
    expect(RELEASE_INTENTION_KEYS).toEqual(expected);
  });

  it('redacts tokens, passwords, and Postgres URL credentials', () => {
    const message = sanitizeReleaseError(
      ['Bearer bearer-secret password=db-secret postgresql:', '//reader:url-secret@host access token-secret'].join(''),
      ['token-secret']
    );
    expect(message).toContain('Bearer [REDACTED]');
    expect(message).toContain('password=[REDACTED]');
    expect(message).toContain('postgresql://reader:[REDACTED]@host');
    expect(message).not.toMatch(/bearer-secret|db-secret|url-secret|token-secret/);
  });
});
