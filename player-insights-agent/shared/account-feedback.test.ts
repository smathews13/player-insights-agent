import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL,
  ACCOUNT_FEEDBACK_GITHUB_URL,
  accountFeedbackTargets,
  safeAccountFeedbackTargets,
} from './account-feedback';

const DIRECT = `slack://user?team=T${'1'.repeat(8)}&id=U${'2'.repeat(8)}`;
const SEARCH = `https://app.slack.com/client/T${'3'.repeat(8)}/search?q=Feedback%20contact`;

describe('account feedback destinations', () => {
  it('defaults to the fixed public issue form with no Slack identity', () => {
    expect(accountFeedbackTargets()).toEqual({
      github: { label: 'GitHub issue', url: ACCOUNT_FEEDBACK_GITHUB_URL },
      slack: null,
    });
  });

  it('uses the deployment label for validated direct and search targets', () => {
    expect(accountFeedbackTargets(DIRECT, 'Feedback contact').slack).toEqual({
      label: 'Feedback contact',
      url: DIRECT,
    });
    expect(accountFeedbackTargets(SEARCH, 'Find feedback contact').slack).toEqual({
      label: 'Find feedback contact',
      url: SEARCH,
    });
    expect(accountFeedbackTargets(`https://example.slack.com/team/U${'8'.repeat(8)}`).slack?.label).toBe(
      ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL
    );
  });

  it.each([
    'javascript:alert(1)',
    'https://hooks.slack.com/team/U12345678',
    'https://example.com/team/U12345678',
    `slack://user?team=invalid&id=U${'7'.repeat(8)}`,
    'https://example.slack.com/team/not-a-member',
    `https://app.slack.com/client/T${'3'.repeat(8)}/search?q=`,
    `https://app.slack.com/client/T${'3'.repeat(8)}/search?q=Feedback&redirect=1`,
  ])('rejects unsafe or inexact runtime target %s', (value) => {
    expect(accountFeedbackTargets(value).slack).toBeNull();
  });

  it('sanitizes and bounds the deployment label without inferring intent', () => {
    expect(accountFeedbackTargets(DIRECT, '  Feedback\ncontact\u0000  ')?.slack?.label).toBe('Feedback contact');
    expect(accountFeedbackTargets(DIRECT, 'x'.repeat(100)).slack?.label).toHaveLength(64);
    expect(accountFeedbackTargets(DIRECT, '\u0000').slack?.label).toBe(ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL);
  });

  it('revalidates a compromised endpoint response and keeps Slack optional', () => {
    expect(
      safeAccountFeedbackTargets({
        github: { label: 'Wrong', url: 'https://example.com/phish' },
        slack: { label: 'Feedback contact', url: 'https://example.com/person' },
      })
    ).toEqual(accountFeedbackTargets());
    expect(safeAccountFeedbackTargets({ slack: { label: 'Feedback contact', url: DIRECT } }).slack).toEqual({
      label: 'Feedback contact',
      url: DIRECT,
    });
  });
});
