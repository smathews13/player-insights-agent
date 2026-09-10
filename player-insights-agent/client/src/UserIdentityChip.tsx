/**
 * The app-wide presentation for a person: their organization mark and the
 * identity's local part inside the same bordered chip used in the header.
 *
 * Full addresses stay in `title`; the visible local part is enough to recognise
 * a colleague without repeating an identical domain across every list.
 */
import type { ReactNode } from 'react';
import type { OrganizationMapping } from '../../shared/organization-contract';
import { organizationForEmail } from '../../shared/organization-mapping';
import { OrganizationAvatar } from './OrganizationAvatar';
import { identityName } from './user-identity';

export function UserIdentityChip({
  identity,
  label,
  compact = false,
  className,
  testId,
  suffix,
  icon,
  organization,
  organizations = [],
  showFullIdentity = false,
  title,
  ariaLabel,
}: {
  identity: string | null | undefined;
  label?: string;
  compact?: boolean;
  className?: string;
  testId?: string;
  suffix?: ReactNode;
  /** Replace the resolved organization mark when the caller has a stronger identity mark. */
  icon?: ReactNode;
  /** Authoritative organization when the containing row already resolved it. */
  organization?: OrganizationMapping;
  /** Deployment-provided mappings used when the identity is resolved here. */
  organizations?: readonly OrganizationMapping[];
  /** Profile headers may show the full address; dense lists keep the local part. */
  showFullIdentity?: boolean;
  /** Accessible hover detail when a surface combines person and organization. */
  title?: string;
  /** Complete accessible name when the visible compact label omits detail. */
  ariaLabel?: string;
}) {
  const value = identity?.trim() ?? '';
  const name = identityName(value);
  const resolvedOrganization = organization ?? organizationForEmail(value, organizations);
  return (
    <span
      className={`identity-chip${compact ? ' identity-chip--compact' : ''}${className ? ` ${className}` : ''}`}
      data-testid={testId}
      title={title ?? (value || 'User identity not recorded')}
      aria-label={ariaLabel}
    >
      {icon ?? <OrganizationAvatar organization={resolvedOrganization} />}
      <span className="identity-chip-text">
        {label ? <span className="identity-chip-label">{label} </span> : null}
        <span className="identity-chip-name">{showFullIdentity && value ? value : name}</span>
      </span>
      {suffix}
    </span>
  );
}
