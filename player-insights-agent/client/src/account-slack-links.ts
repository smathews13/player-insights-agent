const SLACK_TEAM_ID = 'T02EPKPG3';
const SLACK_RECIPIENT = {
  feedback: 'U04H3555WMB',
  escalation: 'U06BV72N4KY',
} as const;

export function accountSlackHref(action: keyof typeof SLACK_RECIPIENT): string {
  const params = new URLSearchParams({ team: SLACK_TEAM_ID, channel: SLACK_RECIPIENT[action] });
  return `https://slack.com/app_redirect?${params.toString()}`;
}
