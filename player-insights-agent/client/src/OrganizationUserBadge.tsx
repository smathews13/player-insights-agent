import type { OrganizationMapping } from '../../shared/organization-contract';
import { organizationForEmail } from '../../shared/organization-mapping';
import { identityName } from './user-identity';
import { OrganizationAvatar } from './OrganizationAvatar';
import { UserDrilldownLink } from './UserDrilldownLink';
import { normalizedHumanEmail } from './user-drilldown';

/**
 * Compact person attribution with the person's organization as its identity
 * mark. The address remains available to assistive technology and on hover, but
 * the visible label is the familiar local handle used by compact user lists.
 */
export function OrganizationUserBadge({
  identity,
  organization,
  organizations = [],
  canOpen = false,
  showArrow = false,
  compact = true,
  showFullIdentity = false,
  label,
  testId,
  className,
}: {
  identity: string | null | undefined;
  organization?: OrganizationMapping;
  organizations?: readonly OrganizationMapping[];
  canOpen?: boolean;
  showArrow?: boolean;
  compact?: boolean;
  showFullIdentity?: boolean;
  label?: string;
  testId?: string;
  className?: string;
}) {
  const value = identity?.trim() ?? '';
  const resolved = organization ?? organizationForEmail(value, organizations);
  const user = identityName(value);
  const detail = value ? `${value} · ${resolved.name}` : `User identity not recorded · ${resolved.name}`;
  const accessible = `User ${value || user}; organization ${resolved.name}`;
  const opensUser = canOpen && Boolean(normalizedHumanEmail(value));

  return (
    <UserDrilldownLink
      identity={value}
      compact={compact}
      className={`organization-user-badge${className ? ` ${className}` : ''}`}
      canOpen={opensUser}
      showArrow={showArrow && opensUser}
      icon={<OrganizationAvatar organization={resolved} />}
      title={detail}
      ariaLabel={opensUser ? `Open user overview for ${accessible}` : accessible}
      label={label}
      showFullIdentity={showFullIdentity}
      testId={testId}
    />
  );
}
