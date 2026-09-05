import twoK from './assets/organization/2k.svg?raw';
import northwind from './assets/organization/northwind.svg?raw';
import customer from './assets/organization/acme.svg?raw';
import { DATABRICKS_SYMBOL } from './brand-icons';
import type { OrganizationLogoKey } from '../../shared/organization-contract';

const XML_PROLOG = /^\s*<\?xml[^>]*\?>\s*/;

/**
 * Committed local organization artwork. Unknown and deployment-provided
 * organizations still render their validated monogram without a network fetch.
 */
export const ORGANIZATION_LOGOS: Partial<Record<OrganizationLogoKey, string>> = {
  databricks: DATABRICKS_SYMBOL,
  'acme': customer.replace(XML_PROLOG, '').trim(),
  '2k': twoK.replace(XML_PROLOG, '').trim(),
  northwind: northwind.replace(XML_PROLOG, '').trim(),
};
