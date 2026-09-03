import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_FEEDBACK_SLACK_LABEL_ENV,
  ACCOUNT_FEEDBACK_SLACK_URL_ENV,
  accountFeedbackTargetsFromEnv,
  workspaceAppsHref,
} from './account-routes';

const SOURCE = readFileSync(new URL('account-routes.ts', import.meta.url), 'utf8');

describe('Databricks Apps link', () => {
  it('uses the configured workspace and never guesses one', () => {
    expect(workspaceAppsHref({ DATABRICKS_HOST: 'workspace.example.com/' })).toBe(
      'https://workspace.example.com/apps-v2'
    );
    expect(
      workspaceAppsHref({ DATABRICKS_HOST: 'workspace.example.com', DATABRICKS_WORKSPACE_ID: '<workspace-id>' })
    ).toBe('https://workspace.example.com/apps-v2?o=<workspace-id>');
    expect(workspaceAppsHref({})).toBe('');
  });
});

describe('account feedback targets', () => {
  it('serves only the validated payload from a private cached runtime endpoint', () => {
    expect(SOURCE).toContain("app.get('/api/account/feedback-targets'");
    expect(SOURCE).toContain("res.setHeader('Cache-Control', 'private, max-age=300')");
    expect(SOURCE).toContain('res.json(accountFeedbackTargetsFromEnv())');
  });

  it('publishes GitHub with no Slack identity by default', () => {
    const targets = accountFeedbackTargetsFromEnv({});
    expect(targets.github).toEqual({
      label: 'GitHub issue',
      url: 'https://github.com/smathews13/astrolabe_public/issues/new',
    });
    expect(targets.slack).toBeNull();
  });

  it('uses both documented environment variables only for a validated target', () => {
    const direct = `slack://user?team=T${'1'.repeat(8)}&id=U${'5'.repeat(8)}`;
    expect(
      accountFeedbackTargetsFromEnv({
        [ACCOUNT_FEEDBACK_SLACK_URL_ENV]: direct,
        [ACCOUNT_FEEDBACK_SLACK_LABEL_ENV]: 'Feedback contact',
      }).slack
    ).toEqual({
      label: 'Feedback contact',
      url: direct,
    });
    expect(
      accountFeedbackTargetsFromEnv({
        [ACCOUNT_FEEDBACK_SLACK_URL_ENV]: 'https://example.com/not-slack',
        [ACCOUNT_FEEDBACK_SLACK_LABEL_ENV]: 'Feedback contact',
      }).slack
    ).toBeNull();
  });
});
