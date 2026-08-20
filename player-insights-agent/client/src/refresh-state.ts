import { checkedAgo } from './architecture';

export const REFRESH_LABEL = 'Refresh';
export const REFRESH_BUSY_LABEL = 'Refreshing\u2026';
export const NEVER_READ = 'Not read yet';
export const NEVER_CHECKED = 'Not checked yet';

export function readAgo(checkedAt: string, now: number = Date.now()): string {
  if (!checkedAt) return NEVER_READ;
  const ago = checkedAgo(checkedAt, now);
  return ago === 'not yet' ? NEVER_READ : `Read ${ago}`;
}

export function checkedAgoLine(checkedAt: string, now: number = Date.now()): string {
  if (!checkedAt) return NEVER_CHECKED;
  const ago = checkedAgo(checkedAt, now);
  return ago === 'not yet' ? NEVER_CHECKED : `Checked ${ago}`;
}

export function ageAgo(at: string, now: number = Date.now()): string {
  if (!at) return '';
  const ago = checkedAgo(at, now);
  return ago === 'not yet' ? '' : ago;
}
