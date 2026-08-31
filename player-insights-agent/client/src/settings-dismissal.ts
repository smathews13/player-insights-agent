export function settingsDismissalAction(dirtyCount: number, saving: boolean): 'ignore' | 'confirm' | 'close' {
  if (saving) return 'ignore';
  return dirtyCount > 0 ? 'confirm' : 'close';
}
