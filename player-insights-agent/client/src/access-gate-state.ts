type TableStatus = 'ok' | 'denied' | 'error';

export function tableCountLine<
  T extends {
    verdicts?: readonly { status: TableStatus }[];
    ok?: number;
    denied?: number;
    errored?: number;
  },
>(result: T): string {
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
