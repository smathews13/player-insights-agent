import { DATABRICKS_SYMBOL } from './brand-icons';
import type { OrganizationLogoKey } from '../../shared/organization-contract';

/**
 * Public product artwork. Deployment-provided organizations render their
 * validated monograms; no customer logo is compiled into the browser.
 */
export const ORGANIZATION_LOGOS: Partial<Record<OrganizationLogoKey, string>> = {
  databricks: DATABRICKS_SYMBOL,
};
