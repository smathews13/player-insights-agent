/* eslint-disable react-refresh/only-export-components -- selection helpers share the dropdown's canonical behavior */
import type { OrganizationFilterOption } from '../../shared/organization-mapping';
import { AppMultiSelect, type AppMultiSelectOption } from './AppMultiSelect';
import { OrganizationAvatar } from './OrganizationAvatar';

const MAX_ORGANIZATION_SELECTIONS = 20;

export function organizationSelectionSummary(
  selected: readonly string[],
  organizations: readonly OrganizationFilterOption[]
): string {
  if (selected.length === 0) return 'All organizations';
  const chosen = organizations.filter((organization) => selected.includes(organization.id));
  if (chosen.length === 1) return chosen[0].name;
  return `${selected.length} organizations`;
}

export function toggleOrganizationSelection(selected: readonly string[], id: string): string[] {
  const normalized = id.trim().toLocaleLowerCase();
  if (!normalized) return [];
  if (selected.includes(normalized)) return selected.filter((value) => value !== normalized);
  return selected.length >= MAX_ORGANIZATION_SELECTIONS ? [...selected] : [...selected, normalized];
}

export function organizationSelectOptions(
  organizations: readonly OrganizationFilterOption[]
): AppMultiSelectOption<string>[] {
  return organizations.map((organization) => ({
    value: organization.id,
    label: organization.name,
    ariaLabel: `${organization.name}, ${organization.count} user${organization.count === 1 ? '' : 's'}`,
    title: organization.name,
    count: organization.count,
    content: (
      <span className="monitoring-organization-option-content">
        <OrganizationAvatar organization={organization} />
        <span>{organization.name}</span>
      </span>
    ),
  }));
}

export function UserOrganizationSelect({
  organizations,
  total,
  selected,
  onChange,
}: {
  organizations: readonly OrganizationFilterOption[];
  total: number;
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
}) {
  const summary = organizationSelectionSummary(selected, organizations);

  return (
    <AppMultiSelect
      label="Organizations represented in Identity settings"
      ariaLabel="Filter users by organization"
      summary={summary}
      allLabel="All organizations"
      total={total}
      selected={selected}
      onChange={onChange}
      toggleValue={toggleOrganizationSelection}
      className="monitoring-organization-select"
      triggerClassName="monitoring-organization-trigger"
      contentClassName="monitoring-organization-menu"
      options={organizationSelectOptions(organizations)}
    />
  );
}
