type TableStatus = 'ok' | 'denied' | 'error';

export function tableCountLine<T extends {
  verdicts?: readonly { status: TableStatus }[];
  ok?: number;
  denied?: number;
  errored?: number;
}>(result: T): string {
  const verdicts = result.verdicts ?? [];
  const count = (status: TableStatus) => verdicts.filter((verdict) => verdict.status === status).length;
  const ok = result.ok ?? count('ok');
  const denied = result.denied ?? count('denied');
  const errored = result.errored ?? count('error');
  const total = ok + denied + errored;
  if (total === 0) return '';
  const parts = [`${ok} of ${total} table${total === 1 ? '' : 's'} readable`];
  if (denied > 0) parts.push(`${denied} refused`);
  if (errored > 0) parts.push(`${errored} not checked`);
  return parts.join(' \u00b7 ');
}

export const GATE_FOCUSABLE =
  'button:not([disabled]), summary, [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function gateKeyIntent(event: { key: string; shiftKey: boolean }): 'escape' | 'forward' | 'backward' | null {
  if (event.key === 'Escape') return 'escape';
  if (event.key !== 'Tab') return null;
  return event.shiftKey ? 'backward' : 'forward';
}

export function gateTabTarget<T>(
  focusable: readonly T[],
  active: T | null,
  direction: 'forward' | 'backward',
): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const at = active === null ? -1 : focusable.indexOf(active);
  if (at === -1) return direction === 'forward' ? first : last;
  if (direction === 'forward') return at === focusable.length - 1 ? first : null;
  return at === 0 ? last : null;
}
