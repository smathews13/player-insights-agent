import { AppMultiSelect } from './AppMultiSelect';
import { OrganizationAvatar } from './OrganizationAvatar';
import {
  CONVERSATION_ORGANIZATION_FILTER_RULE,
  organizationSelectionSummary,
  toggleOrganizationSelection,
  type RailOrganization,
} from './conversation-organization-selection';

export function ConversationOrganizationOption({ organization }: { organization: RailOrganization }) {
  return (
    <span className="monitoring-organization-option-content">
      <OrganizationAvatar organization={organization} />
      <span>{organization.name}</span>
    </span>
  );
}

export function ConversationOrganizationSelect({
  organizations,
  total,
  selected,
  onChange,
}: {
  organizations: readonly RailOrganization[];
  total: number;
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}) {
  const summary = organizationSelectionSummary(selected, organizations);

  return (
    <AppMultiSelect
      label="Conversation organizations"
      ariaLabel="Filter conversations by organization"
      summary={summary}
      allLabel="All organizations"
      total={total}
      selected={selected}
      onChange={onChange}
      toggleValue={toggleOrganizationSelection}
      className="conversation-owner-select conversation-organization-select"
      contentClassName="conversation-owner-menu conversation-organization-menu"
      description={CONVERSATION_ORGANIZATION_FILTER_RULE}
      options={organizations.map((organization) => ({
        value: organization.id,
        label: organization.name,
        ariaLabel: `${organization.name}, ${organization.count} conversation${organization.count === 1 ? '' : 's'}`,
        title: organization.name,
        count: organization.count,
        content: <ConversationOrganizationOption organization={organization} />,
      }))}
    />
  );
}
