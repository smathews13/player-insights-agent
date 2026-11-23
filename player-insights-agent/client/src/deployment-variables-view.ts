export interface DeploymentVariable {
  scope: 'release';
  name: string;
  value: string;
  source: 'release' | 'migrated';
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

const SOURCE_LABELS: Record<DeploymentVariable['source'], string> = {
  release: 'Bundle release',
  migrated: 'Copied from earlier storage',
};

export function deploymentVariableSourceLabel(source: string): string {
  return SOURCE_LABELS[source as DeploymentVariable['source']] ?? source;
}

/** Grouped by scope, each alphabetical. */
export function sortedDeploymentVariables(rows: readonly DeploymentVariable[]): DeploymentVariable[] {
  return [...rows].sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}
