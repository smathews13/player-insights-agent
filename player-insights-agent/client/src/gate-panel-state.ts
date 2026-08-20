import { ADMIN_PAGE_NAMES } from './role';

export function roleLostNotice(state: unknown): string {
  if (!state || typeof state !== 'object') return '';
  const said = (state as { roleLost?: unknown }).roleLost;
  return typeof said === 'string' ? said : '';
}

export function adminPageName(pathname: string): string {
  return ADMIN_PAGE_NAMES[pathname] ?? '';
}
