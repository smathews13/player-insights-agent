import { Building2 } from 'lucide-react';
import type { OrganizationMapping } from '../../shared/organization-contract';
import { ORGANIZATION_LOGOS } from './organization-logos';
import './styles/organization-avatar.css';

/**
 * The organization beside a roster identity.
 *
 * Canonical organizations use the local mark named by the shared manifest.
 * Configured organizations keep their supplied monogram; an unrecognized full
 * domain gets its stable derived monogram without claiming a company identity.
 * Only an identity with no resolvable domain uses the neutral building glyph.
 */
export function OrganizationAvatar({ organization }: { organization: OrganizationMapping }) {
  const logo = ORGANIZATION_LOGOS[organization.logoKey];
  const unknown = organization.fallback === 'building';

  return (
    <span
      className={`roster-organization-mark${logo ? ' roster-organization-mark--branded' : ''}${
        organization.logoKey === 'databricks' ? ' roster-organization-mark--databricks' : ''
      }`}
      role="img"
      aria-label={organization.ariaLabel}
      title={organization.name}
      data-organization-id={organization.id}
      data-organization-domain={organization.domain || undefined}
    >
      {logo ? (
        <span
          className={`roster-organization-logo${
            organization.logoKey === 'databricks' ? ' roster-databricks-symbol' : ''
          }`}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: logo }}
        />
      ) : unknown ? (
        <Building2 className="roster-organization-fallback" aria-hidden="true" />
      ) : (
        <span aria-hidden="true">{organization.monogram}</span>
      )}
    </span>
  );
}
