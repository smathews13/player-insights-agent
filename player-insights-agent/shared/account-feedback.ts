export const ACCOUNT_FEEDBACK_GITHUB_URL = 'https://github.com/smathews13/astrolabe_public/issues/new';
export const ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL = 'Slack message';
export const ACCOUNT_FEEDBACK_MAX_LABEL_LENGTH = 64;

export interface AccountFeedbackTarget {
  label: string;
  url: string;
}

export interface AccountFeedbackTargets {
  github: AccountFeedbackTarget;
  slack: AccountFeedbackTarget | null;
}

const githubTarget: AccountFeedbackTarget = {
  label: 'GitHub issue',
  url: ACCOUNT_FEEDBACK_GITHUB_URL,
};

function safeSlackTarget(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol === 'slack:' &&
      parsed.hostname === 'user' &&
      parsed.pathname.replace(/\//g, '') === '' &&
      /^T[A-Z0-9]{8,}$/.test(parsed.searchParams.get('team') ?? '') &&
      /^[UW][A-Z0-9]{8,}$/.test(parsed.searchParams.get('id') ?? '') &&
      parsed.searchParams.getAll('team').length === 1 &&
      parsed.searchParams.getAll('id').length === 1 &&
      [...parsed.searchParams.keys()].every((key) => key === 'team' || key === 'id')
    ) {
      return parsed.toString();
    }
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname.endsWith('.slack.com') &&
      parsed.hostname !== 'hooks.slack.com' &&
      /^\/team\/[UW][A-Z0-9]{8,}\/?$/.test(parsed.pathname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    ) {
      return parsed.toString();
    }
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'app.slack.com' &&
      /^\/client\/T[A-Z0-9]{8,}\/search\/?$/.test(parsed.pathname) &&
      typeof parsed.searchParams.get('q') === 'string' &&
      Boolean(parsed.searchParams.get('q')?.trim()) &&
      (parsed.searchParams.get('q')?.length ?? 0) <= 200 &&
      parsed.searchParams.getAll('q').length === 1 &&
      [...parsed.searchParams.keys()].every((key) => key === 'q') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    ) {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function safeSlackLabel(value: unknown): string {
  if (typeof value !== 'string') return ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL;
  const printable = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  const plain = printable
    .replace(/[<>&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACCOUNT_FEEDBACK_MAX_LABEL_LENGTH)
    .trim();
  return plain || ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL;
}

export function accountFeedbackTargets(slackUrl?: unknown, slackLabel?: unknown): AccountFeedbackTargets {
  const safeUrl = safeSlackTarget(slackUrl);
  return {
    github: githubTarget,
    slack: safeUrl
      ? {
          label: safeSlackLabel(slackLabel),
          url: safeUrl,
        }
      : null,
  };
}

export function safeAccountFeedbackTargets(value: unknown): AccountFeedbackTargets {
  if (!value || typeof value !== 'object') return accountFeedbackTargets();
  const candidate = value as {
    github?: { url?: unknown };
    slack?: { label?: unknown; url?: unknown } | null;
  };
  return accountFeedbackTargets(candidate.slack?.url, candidate.slack?.label);
}
