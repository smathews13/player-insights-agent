export const ACCOUNT_FEEDBACK_GITHUB_URL = 'https://github.com/smathews13/astrolabe_public/issues/new';
export const ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL = 'Message feedback maintainer in Slack';
export const ACCOUNT_FEEDBACK_DEFAULT_SEARCH_LABEL = 'Find feedback maintainer in Slack';
export const ACCOUNT_ESCALATION_DEFAULT_SLACK_LABEL = 'Open Super Admin escalation in Slack';
export const ACCOUNT_FEEDBACK_MAX_LABEL_LENGTH = 64;

export interface AccountFeedbackTarget {
  label: string;
  url: string;
}

export interface AccountFeedbackTargets {
  github: AccountFeedbackTarget;
  slack: AccountFeedbackTarget | null;
  escalation: AccountFeedbackTarget | null;
}

const githubTarget: AccountFeedbackTarget = {
  label: 'GitHub issue',
  url: ACCOUNT_FEEDBACK_GITHUB_URL,
};

interface SafeSlackTarget {
  kind: 'direct' | 'search';
  url: string;
  searchName?: string;
}

function safeExactNameSearch(value: string | null): string | null {
  if (!value || value.length > 120) return null;
  const name = value.trim();
  const unquoted = name.startsWith('"') && name.endsWith('"') && name.length > 2 ? name.slice(1, -1).trim() : name;
  return /^[\p{L}][\p{L}'’-]{0,49}(?: [\p{L}][\p{L}'’-]{0,49}){1,4}$/u.test(unquoted) ? unquoted : null;
}

function safeSlackTarget(value: unknown): SafeSlackTarget | null {
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
      return { kind: 'direct', url: parsed.toString() };
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
      return { kind: 'direct', url: parsed.toString() };
    }
    const searchName = safeExactNameSearch(parsed.searchParams.get('q'));
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'app.slack.com' &&
      /^\/client\/T[A-Z0-9]{8,}\/search\/?$/.test(parsed.pathname) &&
      searchName &&
      parsed.searchParams.getAll('q').length === 1 &&
      [...parsed.searchParams.keys()].every((key) => key === 'q') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    ) {
      return { kind: 'search', url: parsed.toString(), searchName };
    }
  } catch {
    return null;
  }
  return null;
}

function safeSlackLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
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
  return plain && !/xox[a-z]-/i.test(plain) ? plain : fallback;
}

function safeFeedbackSlackLabel(value: unknown, target: SafeSlackTarget): string {
  const fallback =
    target.kind === 'direct'
      ? ACCOUNT_FEEDBACK_DEFAULT_SLACK_LABEL
      : target.searchName
        ? `Find ${target.searchName} in Slack`
        : ACCOUNT_FEEDBACK_DEFAULT_SEARCH_LABEL;
  const label = safeSlackLabel(value, fallback);
  const expected = target.kind === 'direct' ? /^Message .+ in Slack$/ : /^Find .+ in Slack$/;
  return expected.test(label) ? label : fallback;
}

export function accountFeedbackTargets(
  slackUrl?: unknown,
  slackLabel?: unknown,
  escalationSlackUrl?: unknown,
  escalationSlackLabel?: unknown
): AccountFeedbackTargets {
  const safeFeedback = safeSlackTarget(slackUrl);
  const safeEscalation = safeSlackTarget(escalationSlackUrl);
  return {
    github: githubTarget,
    slack: safeFeedback
      ? {
          label: safeFeedbackSlackLabel(slackLabel, safeFeedback),
          url: safeFeedback.url,
        }
      : null,
    escalation: safeEscalation
      ? {
          label: safeSlackLabel(escalationSlackLabel, ACCOUNT_ESCALATION_DEFAULT_SLACK_LABEL),
          url: safeEscalation.url,
        }
      : null,
  };
}

export function safeAccountFeedbackTargets(value: unknown): AccountFeedbackTargets {
  if (!value || typeof value !== 'object') return accountFeedbackTargets();
  const candidate = value as {
    github?: { url?: unknown };
    slack?: { label?: unknown; url?: unknown } | null;
    escalation?: { label?: unknown; url?: unknown } | null;
  };
  return accountFeedbackTargets(
    candidate.slack?.url,
    candidate.slack?.label,
    candidate.escalation?.url,
    candidate.escalation?.label
  );
}
