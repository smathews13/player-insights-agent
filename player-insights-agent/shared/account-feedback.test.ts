import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ESCALATION_DEFAULT_SLACK_LABEL,
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
      escalation: null,
    });
  });

  it('keeps validated feedback and escalation targets in their distinct routes', () => {
    const targets = accountFeedbackTargets(
      DIRECT,
      'Message Maintainer in Slack',
      SEARCH,
      'Find Customer Admin in Slack'
    );
    expect(targets.slack).toEqual({
      label: 'Message Maintainer in Slack',
      url: DIRECT,
    });
    expect(targets.escalation).toEqual({
      label: 'Find Customer Admin in Slack',
      url: SEARCH,
    });
    expect(accountFeedbackTargets(SEARCH, 'Find Feedback contact in Slack').slack).toEqual({
      label: 'Find Feedback contact in Slack',
      url: SEARCH,
    });
    expect(accountFeedbackTargets(undefined, undefined, DIRECT).escalation).toEqual({
      label: ACCOUNT_ESCALATION_DEFAULT_SLACK_LABEL,
      url: DIRECT,
    });
    expect(accountFeedbackTargets(DIRECT).slack).toEqual({
      label: ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL,
      url: DIRECT,
    });
    expect(accountFeedbackTargets(`https://example.slack.com/team/U${'8'.repeat(8)}`).slack).toEqual({
      label: ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL,
      url: `https://example.slack.com/team/U${'8'.repeat(8)}`,
    });
  });

  it('never swaps a feedback target into escalation or vice versa', () => {
    const escalation = `slack://user?team=T${'8'.repeat(8)}&id=W${'9'.repeat(8)}`;
    const targets = accountFeedbackTargets(DIRECT, 'Message Maintainer in Slack', escalation, 'Message Admin in Slack');
    expect(targets.slack).toEqual({
      label: 'Message Maintainer in Slack',
      url: DIRECT,
    });
    expect(targets.escalation).toEqual({
      label: 'Message Admin in Slack',
      url: escalation,
    });
    expect(targets.slack?.url).not.toBe(targets.escalation?.url);
  });

  it('uses action-appropriate labels for direct and search targets', () => {
    expect(accountFeedbackTargets(DIRECT, 'Feedback contact').slack).toEqual({
      label: ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL,
      url: DIRECT,
    });
    expect(accountFeedbackTargets(SEARCH).slack).toEqual({
      label: 'Find Feedback contact in Slack',
      url: SEARCH,
    });
    expect(accountFeedbackTargets(SEARCH, 'Message Somebody else in Slack').slack).toEqual({
      label: 'Find Feedback contact in Slack',
      url: SEARCH,
    });
    expect(accountFeedbackTargets(SEARCH, 'Find Feedback contact in Slack').slack).toEqual({
      label: 'Find Feedback contact in Slack',
      url: SEARCH,
    });
  });

  it.each([
    'javascript:alert(1)',
    'https://hooks.slack.com/team/U12345678',
    'https://example.com/team/U12345678',
    `slack://user?team=invalid&id=U${'7'.repeat(8)}`,
    'https://example.slack.com/team/not-a-member',
    `https://app.slack.com/client/T${'3'.repeat(8)}/search?q=`,
    `https://app.slack.com/client/T${'3'.repeat(8)}/search?q=one-name`,
    `https://app.slack.com/client/T${'3'.repeat(8)}/search?q=from%3Asomebody`,
    `https://app.slack.com/client/T${'3'.repeat(8)}/search?q=Feedback&redirect=1`,
  ])('rejects unsafe or inexact runtime target %s', (value) => {
    expect(accountFeedbackTargets(value).slack).toBeNull();
  });

  it('sanitizes and bounds labels without accepting tokens or wrong action verbs', () => {
    expect(accountFeedbackTargets(DIRECT, '  Message Feedback\ncontact\u0000 in Slack  ')?.slack?.label).toBe(
      'Message Feedback contact in Slack'
    );
    expect(accountFeedbackTargets(DIRECT, 'Find Maintainer in Slack').slack?.label).toBe(
      ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL
    );
    expect(accountFeedbackTargets(SEARCH, 'Message Maintainer in Slack').slack?.label).toBe(
      'Find Feedback contact in Slack'
    );
    expect(accountFeedbackTargets(DIRECT, 'x'.repeat(100)).slack?.label.length).toBeLessThanOrEqual(64);
    expect(accountFeedbackTargets(DIRECT, '\u0000').slack?.label).toBe(ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL);
    expect(accountFeedbackTargets(DIRECT, 'xoxb-not-a-label').slack?.label).toBe(ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL);
  });

  it('revalidates a compromised endpoint response and keeps Slack optional', () => {
    expect(
      safeAccountFeedbackTargets({
        github: { label: 'Wrong', url: 'https://example.com/phish' },
        slack: { label: 'Feedback contact', url: 'https://example.com/person' },
      })
    ).toEqual(accountFeedbackTargets());
    expect(
      safeAccountFeedbackTargets({
        slack: { label: 'Message Maintainer in Slack', url: DIRECT },
        escalation: { label: 'Customer Admin', url: SEARCH },
      })
    ).toEqual({
      github: { label: 'GitHub issue', url: ACCOUNT_FEEDBACK_GITHUB_URL },
      slack: { label: 'Message Maintainer in Slack', url: DIRECT },
      escalation: { label: 'Customer Admin', url: SEARCH },
    });
  });
});
