export const REFRESH_LABEL = 'Refresh';
export const REFRESH_BUSY_LABEL = 'Refreshing\u2026';
export const NEVER_READ = 'Not read yet';
export const NEVER_CHECKED = 'Not checked yet';

/**
 * How long ago a read completed.
 *
 * This belongs to the shared refresh control rather than the Architecture
 * route. The login gate needs RefreshButton on the first visit; importing this
 * tiny formatter from Architecture made that gate pull the route's nodes,
 * edges, status copy, and semantic-freshness model into the initial Ask chunk.
 */
export function checkedAgo(iso: string, now: number): string {
  if (!iso) return 'not yet';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 'not yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

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
