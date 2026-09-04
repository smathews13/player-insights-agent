import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ESCALATION_SLACK_LABEL_ENV,
  ACCOUNT_ESCALATION_SLACK_URL_ENV,
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
    expect(targets.escalation).toBeNull();
  });

  it('maps each documented environment pair only to its owned route', () => {
    const direct = `slack://user?team=T${'1'.repeat(8)}&id=U${'5'.repeat(8)}`;
    const search = `https://app.slack.com/client/T${'2'.repeat(8)}/search?q=Customer%20Admin`;
    expect(
      accountFeedbackTargetsFromEnv({
        [ACCOUNT_FEEDBACK_SLACK_URL_ENV]: direct,
        [ACCOUNT_FEEDBACK_SLACK_LABEL_ENV]: 'Message Maintainer in Slack',
        [ACCOUNT_ESCALATION_SLACK_URL_ENV]: search,
        [ACCOUNT_ESCALATION_SLACK_LABEL_ENV]: 'Find Customer Admin in Slack',
      })
    ).toMatchObject({
      slack: {
        label: 'Message Maintainer in Slack',
        url: direct,
      },
      escalation: {
        label: 'Find Customer Admin in Slack',
        url: search,
      },
    });
    const escalationOnly = accountFeedbackTargetsFromEnv({
      [ACCOUNT_ESCALATION_SLACK_URL_ENV]: search,
    });
    expect(escalationOnly.slack).toBeNull();
    expect(escalationOnly.escalation?.url).toBe(search);
    const unsafe = accountFeedbackTargetsFromEnv({
      [ACCOUNT_FEEDBACK_SLACK_URL_ENV]: 'https://example.com/not-slack',
      [ACCOUNT_FEEDBACK_SLACK_LABEL_ENV]: 'Feedback contact',
      [ACCOUNT_ESCALATION_SLACK_URL_ENV]: 'javascript:alert(1)',
    });
    expect(unsafe.slack).toBeNull();
    expect(unsafe.escalation).toBeNull();
  });
});
