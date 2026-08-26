import type { ResourceRow } from './connection-model';

export interface ConnectedGenieSpace {
  id: string;
  label: string;
}

export function connectedGenieSpaces(resources: readonly ResourceRow[]): ConnectedGenieSpace[] {
  return resources
    .filter((row) => row.resource.kind === 'genie-space')
    .map((row) => ({
      id: (row.actual || row.configured || row.intended || '').trim(),
      label: row.resource.label,
    }))
    .filter((space) => space.id);
}
