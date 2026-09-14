import type { RailOwner } from './conversation-rail';
import type { RailOrganization } from './conversation-organization-selection';
import { ConversationOwnerSelect } from './ConversationOwnerSelect';
import { ConversationOrganizationSelect } from './ConversationOrganizationSelect';

export function ConversationFilters({
  owners,
  organizations,
  total,
  selectedOwners,
  selectedOrganizations,
  onOwnersChange,
  onOrganizationsChange,
}: {
  owners: readonly RailOwner[];
  organizations: readonly RailOrganization[];
  total: number;
  selectedOwners: readonly string[];
  selectedOrganizations: readonly string[];
  onOwnersChange: (selected: readonly string[]) => void;
  onOrganizationsChange: (selected: readonly string[]) => void;
}) {
  return (
    <>
      <ConversationOwnerSelect owners={owners} total={total} selected={selectedOwners} onChange={onOwnersChange} />
      <ConversationOrganizationSelect
        organizations={organizations}
        total={total}
        selected={selectedOrganizations}
        onChange={onOrganizationsChange}
      />
    </>
  );
}
