import { Building2 } from 'lucide-react';
import type { OrganizationMapping } from '../../shared/organization-mapping';
import { DATABRICKS_SYMBOL } from './brand-icons';

/**
 * The organization beside a roster identity.
 *
 * Databricks uses the committed official corporate symbol. Configured
 * organizations keep their supplied monogram; an unrecognized domain gets a
 * neutral organization glyph rather than an invented logo.
 */
export function OrganizationAvatar({ organization }: { organization: OrganizationMapping }) {
  const databricks = organization.domain === 'databricks.com';
  const unknown = organization.monogram === '•';

  return (
    <span
      className={`roster-organization-mark${databricks ? ' roster-organization-mark--databricks' : ''}`}
      role="img"
      aria-label={`Organization: ${organization.name}`}
      title={organization.name}
      data-organization-domain={organization.domain || undefined}
    >
      {databricks ? (
        <span
          className="roster-databricks-symbol"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: DATABRICKS_SYMBOL }}
        />
      ) : unknown ? (
        <Building2 className="roster-organization-fallback" aria-hidden="true" />
      ) : (
        <span aria-hidden="true">{organization.monogram}</span>
      )}
    </span>
  );
}
