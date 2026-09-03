const SLACK_TEAM_ID = 'T02EPKPG3';
const ESCALATION_RECIPIENT = 'U06BV72N4KY';

export function accountEscalationSlackHref(): string {
  const params = new URLSearchParams({ team: SLACK_TEAM_ID, channel: ESCALATION_RECIPIENT });
  return `https://slack.com/app_redirect?${params.toString()}`;
}
