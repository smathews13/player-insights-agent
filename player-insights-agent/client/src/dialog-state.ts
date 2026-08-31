export const DIALOG_FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function dialogTabTarget<T>(
  focusable: readonly T[],
  active: T | null,
  direction: 'forward' | 'backward'
): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const at = active === null ? -1 : focusable.indexOf(active);
  if (at === -1) return direction === 'forward' ? first : last;
  if (direction === 'forward') return at === focusable.length - 1 ? first : null;
  return at === 0 ? last : null;
}

export function dialogKeyIntent(event: { key: string; shiftKey: boolean }): 'escape' | 'forward' | 'backward' | null {
  if (event.key === 'Escape') return 'escape';
  if (event.key !== 'Tab') return null;
  return event.shiftKey ? 'backward' : 'forward';
}
