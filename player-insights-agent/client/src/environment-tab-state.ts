export type EnvironmentTab = 'variables' | 'packages';

const ENVIRONMENT_TABS: readonly EnvironmentTab[] = ['variables', 'packages'];

export function environmentTabKeyTarget(current: EnvironmentTab, key: string): EnvironmentTab | null {
  const at = ENVIRONMENT_TABS.indexOf(current);
  if (key === 'Home') return ENVIRONMENT_TABS[0];
  if (key === 'End') return ENVIRONMENT_TABS[ENVIRONMENT_TABS.length - 1];
  if (key === 'ArrowRight' || key === 'ArrowDown') return ENVIRONMENT_TABS[(at + 1) % ENVIRONMENT_TABS.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return ENVIRONMENT_TABS[(at - 1 + ENVIRONMENT_TABS.length) % ENVIRONMENT_TABS.length];
  }
  return null;
}
