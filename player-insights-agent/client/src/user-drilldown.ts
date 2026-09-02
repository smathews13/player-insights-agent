import { openPerson } from './monitoring-filters';

export function normalizedHumanEmail(identity: string | null | undefined): string | null {
  const value = identity?.trim().toLowerCase() ?? '';
  if (!value || /\s/.test(value)) return null;
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !parts[1].includes('.')) return null;
  return value;
}

export function userOverviewHref(identity: string | null | undefined, currentSearch = ''): string | null {
  const email = normalizedHumanEmail(identity);
  if (!email) return null;
  const search = openPerson(currentSearch, email);
  return `/monitoring?${search}`;
}
