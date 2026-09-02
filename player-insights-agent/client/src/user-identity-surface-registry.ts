export type UserIdentitySurface = {
  id: string;
  file: string;
  policy: 'drilldown' | 'static';
  reason?: string;
};

/**
 * Human-identity surfaces are registered here so new raw chips cannot quietly
 * bypass the admin-only Monitoring drilldown policy.
 */
export const USER_IDENTITY_SURFACES: readonly UserIdentitySurface[] = [
  { id: 'monitoring-question-asker', file: 'MonitoringPage.tsx', policy: 'drilldown' },
  { id: 'monitoring-question-detail', file: 'MonitoringPage.tsx', policy: 'drilldown' },
  { id: 'ask-conversation-owner', file: 'HomePage.tsx', policy: 'drilldown' },
  { id: 'ask-transcript-asker', file: 'HomePage.tsx', policy: 'drilldown' },
  { id: 'run-list-identity', file: 'RunExplorer.tsx', policy: 'drilldown' },
  { id: 'run-overview-identity', file: 'RunHeader.tsx', policy: 'drilldown' },
  { id: 'benchmark-history-identity', file: 'BenchmarkLab.tsx', policy: 'drilldown' },
  { id: 'settings-human-roster', file: 'UserRoleEditor.tsx', policy: 'drilldown' },
  { id: 'connection-audit-identity', file: 'ConnectionsPage.tsx', policy: 'drilldown' },
  { id: 'declared-connection-owner', file: 'DeclaredConnectionsCard.tsx', policy: 'drilldown' },
  {
    id: 'monitoring-browser-row',
    file: 'MonitoringPage.tsx',
    policy: 'static',
    reason: 'The entire row is already the accessible control that opens this same profile.',
  },
  {
    id: 'monitoring-profile-heading',
    file: 'MonitoringPage.tsx',
    policy: 'static',
    reason: 'The identity already names the currently open profile.',
  },
  {
    id: 'signed-in-account-controls',
    file: 'Layout.tsx',
    policy: 'static',
    reason: 'Header identity opens account controls; changing its destination would remove that control.',
  },
  {
    id: 'access-gate-identity',
    file: 'AccessGate.tsx',
    policy: 'static',
    reason: 'These preflight surfaces may render before admin authorization is established.',
  },
  {
    id: 'first-open-identity',
    file: 'FirstOpenGate.tsx',
    policy: 'static',
    reason: 'This preflight surface renders before admin authorization is established.',
  },
] as const;
