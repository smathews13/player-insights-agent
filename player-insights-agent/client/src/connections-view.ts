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

export function tableReachabilityCopy(check: PreflightCheck, checkedAt: string): { row: string; title: string } {
  const evidence = `${check.error} ${check.detail}`.trim();
  const columns = /(\d+)\s+columns?/i.exec(evidence)?.[1] ?? '';
  const when = checkedAt ? formatCheckedAt(checkedAt) : 'time not reported';
  if (check.status === 'ok') {
    const count = columns ? `${columns} columns` : 'schema metadata reachable';
    return {
      row: `${count} · checked ${when}`,
      title: `Reachability confirmed. ${columns ? `Schema has ${columns} columns. ` : ''}Last checked ${when}.`,
    };
  }
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
