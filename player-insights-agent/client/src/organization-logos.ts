import twoK from './assets/organization/2k.svg?raw';
import northwind from './assets/organization/northwind.svg?raw';
import acmeImage from './assets/organization/publisher-logo.png';
import { DATABRICKS_SYMBOL } from './brand-icons';
import type { OrganizationLogoKey } from '../../shared/organization-contract';

const XML_PROLOG = /^\s*<\?xml[^>]*\?>\s*/;

/**
 * Committed local organization artwork. Unknown and deployment-provided
 * organizations still render their validated monogram without a network fetch.
 */
export const ORGANIZATION_LOGOS: Partial<Record<OrganizationLogoKey, string>> = {
  databricks: DATABRICKS_SYMBOL,
  '2k': twoK.replace(XML_PROLOG, '').trim(),
  northwind: northwind.replace(XML_PROLOG, '').trim(),
};

/** Supplied organization artwork shipped byte-for-byte as a build asset. */
export const ORGANIZATION_LOGO_IMAGES: Partial<Record<OrganizationLogoKey, string>> = {
  'acme': acmeImage,
};
