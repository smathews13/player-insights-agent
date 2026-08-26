import type { BrandProduct } from './BrandIcon';
import type { ResourceKind } from '../../shared/deployment-config';
import { formatCheckedAt, type PreflightCheck } from './preflight';

export const RESOURCE_PRODUCT: Record<ResourceKind, BrandProduct> = {
  agent: 'mosaic-ai',
  model: 'mosaic-ai',
  'vector-search': 'mosaic-ai',
  'sql-warehouse': 'databricks-sql',
  'genie-space': 'genie',
  lakebase: 'lakebase',
  'unity-catalog': 'unity-catalog',
  volume: 'unity-catalog',
  observability: 'mlflow',
  'app-behaviour': 'apps',
};

export function unityCatalogNameParts(name: string): { catalog: string; schema: string; table: string } {
  const parts = name.split('.').filter((part) => part.length > 0);
  if (parts.length >= 3) {
    return { catalog: parts[0], schema: parts[1], table: parts.slice(2).join('.') };
  }
  if (parts.length === 2) return { catalog: '', schema: parts[0], table: parts[1] };
  return { catalog: '', schema: '', table: parts[0] ?? name };
}

export function declaredTableFilterOptions(
  checks: readonly PreflightCheck[],
  catalog = ''
): { catalogs: string[]; schemas: string[] } {
  const catalogs = [
    ...new Set(checks.map((check) => unityCatalogNameParts(check.name).catalog).filter(Boolean)),
  ].sort();
  const schemas = [
    ...new Set(
      checks
        .filter((check) => !catalog || unityCatalogNameParts(check.name).catalog === catalog)
        .map((check) => unityCatalogNameParts(check.name).schema)
        .filter(Boolean)
    ),
  ].sort();
  return { catalogs, schemas };
}

export function filterDeclaredTables(
  checks: readonly PreflightCheck[],
  filters: { query: string; catalog: string; schema: string }
): PreflightCheck[] {
  const needle = filters.query.trim().toLocaleLowerCase();
  return checks.filter((check) => {
    const parts = unityCatalogNameParts(check.name);
    if (filters.catalog && parts.catalog !== filters.catalog) return false;
    if (filters.schema && parts.schema !== filters.schema) return false;
    if (!needle) return true;
    return check.name.toLocaleLowerCase().includes(needle);
  });
}

/**
 * The workspace's own column count, from "answered: N columns".
 *
 * A looser `/(\d+)\s+columns?/` on the whole detail string can pick an earlier
 * decoy ("7 columns in the extract") and leave the hover reading the probe's
 * "17 columns". Row and hover both call this, so they cannot disagree.
 */
export function tableColumnCount(check: PreflightCheck): number | null {
  const evidence = `${check.detail} ${check.error}`;
  const matched = /answered(?:\s+as\s+[^:]+)?:\s*(\d+)\s+columns?/i.exec(evidence);
  if (!matched) return null;
  const count = Number(matched[1]);
  return Number.isFinite(count) ? count : null;
}

export function tableReachabilityCopy(check: PreflightCheck, checkedAt: string): { row: string; title: string } {
  const columns = tableColumnCount(check);
  const countLabel = columns === null ? '' : `${columns} column${columns === 1 ? '' : 's'}`;
  const when = checkedAt ? formatCheckedAt(checkedAt) : 'time not reported';
  if (check.status === 'ok') {
    const count = countLabel || 'schema metadata reachable';
    return {
      row: `${count} · checked ${when}`,
      title: `Reachability confirmed. ${countLabel ? `Schema has ${countLabel}. ` : ''}Last checked ${when}.`,
    };
  }
  const evidence = `${check.error} ${check.detail}`.trim();
  const permission = /403|permission|denied|grant/i.test(evidence);
  if (check.stopped === 'refused' || permission) {
    return {
      row: `Permission not confirmed · checked ${when}`,
      title: `The workspace refused the metadata read, so reachability under this sign-in is not confirmed. Last checked ${when}.`,
    };
  }
  return {
    row: `Reachability not confirmed · checked ${when}`,
    title: `The metadata read did not establish reachability. Last checked ${when}.`,
  };
}

export function configurationValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === 'true') return 'on';
  if (trimmed === 'false') return 'off';
  return trimmed;
}
