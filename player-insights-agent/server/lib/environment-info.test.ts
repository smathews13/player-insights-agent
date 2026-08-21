import { describe, expect, it } from 'vitest';
import {
  isSensitiveEnvironmentKey,
  maskedEnvironment,
  parsePipPackages,
} from './environment-info';

describe('environment details', () => {
  it('masks credentials before environment values leave the server', () => {
    const variables = maskedEnvironment({
      DATABRICKS_APP_NAME: 'astrolabe',
      DATABRICKS_CLIENT_ID: 'public-client-id',
      DATABRICKS_CLIENT_SECRET: 'never-send-this',
      SLACK_BOT_TOKEN: 'do-not-invent-or-send-this',
      DATABASE_URL: ['postgres://reader', 'password@example.invalid/app'].join(':'),
      DATABRICKS_HOST: 'https://workspace.invalid',
    });

    expect(variables).toEqual([
      { key: 'DATABASE_URL', value: '***' },
      { key: 'DATABRICKS_APP_NAME', value: 'astrolabe' },
      { key: 'DATABRICKS_CLIENT_ID', value: 'public-client-id' },
      { key: 'DATABRICKS_CLIENT_SECRET', value: '***' },
      { key: 'DATABRICKS_HOST', value: 'https://workspace.invalid' },
      { key: 'SLACK_BOT_TOKEN', value: '***' },
    ]);
    expect(JSON.stringify(variables)).not.toContain('never-send-this');
    expect(JSON.stringify(variables)).not.toContain('do-not-invent-or-send-this');
    expect(JSON.stringify(variables)).not.toContain('password');
  });

  it('recognizes common secret-bearing variable names without hiding client ids', () => {
    expect(isSensitiveEnvironmentKey('CLIENT_SECRET')).toBe(true);
    expect(isSensitiveEnvironmentKey('MY_API_KEY')).toBe(true);
    expect(isSensitiveEnvironmentKey('DATABRICKS_CLIENT_ID')).toBe(false);
  });

  it('reads and sorts the installed pip package list', () => {
    expect(
      parsePipPackages(
        JSON.stringify([
          { name: 'zod', version: '4.3.6' },
          { name: 'aiofiles', version: '23.2.1' },
        ])
      )
    ).toEqual([
      { name: 'aiofiles', version: '23.2.1' },
      { name: 'zod', version: '4.3.6' },
    ]);
  });
});
