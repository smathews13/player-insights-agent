import { BILLING_TAG } from '../../shared/billing-tag';
import type { AppMonthlySpend } from '../../shared/ops-contract';
import type { CostIdentifiers, StatementParameter } from './ops-billing';

export const RECENT_MONTHLY_SPEND_CACHE_MS = 15 * 60_000;

interface CompletedMonth {
  month: string;
  from: string;
  to: string;
}

interface MonthlySpendStatement {
  statement: string;
  parameters: StatementParameter[];
}

type CachedMonthlySpend =
  | { at: number; value: AppMonthlySpend[] }
  | { at: number; pending: Promise<AppMonthlySpend[]> };

const cache = new Map<string, CachedMonthlySpend>();

function day(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

/** The last three completed UTC calendar months, newest first. */
export function recentCompletedMonths(now: number): CompletedMonth[] {
  const instant = new Date(now);
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  return [1, 2, 3].map((offset) => {
    const start = Date.UTC(year, month - offset, 1);
    const end = Date.UTC(year, month - offset + 1, 0);
    return { month: day(start).slice(0, 7), from: day(start), to: day(end) };
  });
}

export function recentMonthlySpendPlaceholders(now: number): AppMonthlySpend[] {
  return recentCompletedMonths(now).map(({ month }) => ({ month, amount: null, dbus: null, currency: '' }));
}

/**
 * One bounded aggregate over exact configured resource identities or the app's
 * own billing tag. The OR predicate keeps a row that satisfies both from being
 * counted twice, while the requested-month relation preserves missing months.
 */
export function buildRecentMonthlySpendStatement(ids: CostIdentifiers, now: number): MonthlySpendStatement | null {
  if (!ids.workspaceId.trim()) return null;
  const parameters: StatementParameter[] = [{ name: 'workspaceId', value: ids.workspaceId.trim(), type: 'STRING' }];
  const predicates = [`u.custom_tags['${BILLING_TAG.key}'] = '${BILLING_TAG.value}'`];
  const bind = (name: string, value: string) => {
    if (!value.trim()) return;
    parameters.push({ name, value: value.trim(), type: 'STRING' });
  };
  bind('appName', ids.appName);
  if (ids.appName.trim()) {
    predicates.push(`(u.billing_origin_product = 'APPS' AND u.usage_metadata.app_name = :appName)`);
  }
  bind('agentEndpoint', ids.endpointName);
  if (ids.endpointName.trim()) {
    predicates.push(`(u.billing_origin_product = 'MODEL_SERVING' AND u.usage_metadata.endpoint_name = :agentEndpoint)`);
  }
  bind('foundationModel', ids.foundationModel);
  if (ids.foundationModel.trim()) {
    predicates.push(`(u.billing_origin_product IN ('MODEL_SERVING', 'AI_GATEWAY')
      AND REGEXP_REPLACE(LOWER(u.usage_metadata.endpoint_name), '[^a-z0-9]', '') =
          REGEXP_REPLACE(LOWER(:foundationModel), '[^a-z0-9]', ''))`);
  }
  bind('warehouseId', ids.warehouseId);
  if (ids.warehouseId.trim()) {
    predicates.push(`(u.billing_origin_product = 'SQL' AND u.usage_metadata.warehouse_id = :warehouseId)`);
  }
  if (ids.vectorEndpoint.trim() && ids.vectorEndpointIndexCount === 1) {
    bind('vectorEndpoint', ids.vectorEndpoint);
    predicates.push(
      `(u.billing_origin_product = 'VECTOR_SEARCH' AND u.usage_metadata.endpoint_name = :vectorEndpoint)`
    );
  }
  const months = recentCompletedMonths(now);
  for (const [index, month] of months.entries()) {
    parameters.push({ name: `month${index}From`, value: month.from, type: 'DATE' });
    parameters.push({ name: `month${index}To`, value: month.to, type: 'DATE' });
  }
  const requestedMonths = months
    .map(
      (_, index) =>
        `${index === 0 ? '' : 'UNION ALL '}` + `SELECT :month${index}From AS month_start, :month${index}To AS month_end`
    )
    .join('\n  ');
  return {
    parameters,
    statement: `WITH requested_months AS (
  ${requestedMonths}
),
attributed_usage AS (
  SELECT
    months.month_start,
    COALESCE(
      CAST(u.record_id AS STRING),
      CONCAT_WS('|', CAST(u.workspace_id AS STRING), u.sku_name,
        CAST(u.usage_start_time AS STRING), CAST(u.usage_end_time AS STRING))
    ) AS record_id,
    u.usage_quantity,
    u.usage_unit,
    u.sku_name,
    u.cloud,
    u.usage_end_time
  FROM requested_months months
  INNER JOIN system.billing.usage u
    ON u.usage_date BETWEEN months.month_start AND months.month_end
  WHERE u.workspace_id = :workspaceId
    AND (${predicates.join('\n      OR ')})
),
price_hits AS (
  SELECT
    usage.*,
    prices.pricing.default AS unit_price,
    prices.currency_code,
    COUNT(prices.sku_name) OVER (PARTITION BY usage.record_id) AS price_match_count
  FROM attributed_usage usage
  LEFT JOIN system.billing.list_prices prices
    ON usage.sku_name = prices.sku_name
   AND usage.cloud = prices.cloud
   AND usage.usage_unit = prices.usage_unit
   AND usage.usage_end_time >= prices.price_start_time
   AND (prices.price_end_time IS NULL OR usage.usage_end_time < prices.price_end_time)
),
deduped AS (
  SELECT
    month_start,
    record_id,
    MAX(usage_quantity) AS usage_quantity,
    MAX(usage_unit) AS usage_unit,
    MAX(unit_price) AS unit_price,
    MAX(currency_code) AS currency_code,
    MAX(price_match_count) AS price_match_count
  FROM price_hits
  GROUP BY month_start, record_id
)
SELECT
  DATE_FORMAT(months.month_start, 'yyyy-MM') AS month,
  CASE
    WHEN COUNT(usage.record_id) = 0 THEN CAST(NULL AS DOUBLE)
    WHEN COUNT(*) FILTER (WHERE usage.unit_price IS NULL OR usage.price_match_count <> 1) > 0
      THEN CAST(NULL AS DOUBLE)
    WHEN COUNT(DISTINCT usage.currency_code) <> 1 THEN CAST(NULL AS DOUBLE)
    ELSE SUM(usage.usage_quantity * usage.unit_price)
  END AS spend_usd,
  CASE
    WHEN COUNT(usage.record_id) = 0 THEN CAST(NULL AS DOUBLE)
    WHEN COUNT(*) FILTER (WHERE UPPER(TRIM(usage.usage_unit)) <> 'DBU') > 0 THEN CAST(NULL AS DOUBLE)
    ELSE SUM(usage.usage_quantity)
  END AS dbus,
  CASE WHEN COUNT(DISTINCT usage.currency_code) = 1 THEN MAX(usage.currency_code) ELSE '' END AS currency
FROM requested_months months
LEFT JOIN deduped usage ON usage.month_start = months.month_start
GROUP BY months.month_start
ORDER BY months.month_start DESC
LIMIT 3`,
  };
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse the Statement API rows while retaining missing months and genuine zeroes. */
export function readRecentMonthlySpendRows(rows: unknown, now: number): AppMonthlySpend[] {
  const byMonth = new Map<string, AppMonthlySpend>();
  if (Array.isArray(rows)) {
    for (const raw of rows) {
      if (!Array.isArray(raw)) continue;
      const [month, amount, dbus, currency] = raw as unknown[];
      if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) continue;
      byMonth.set(month, {
        month,
        amount: optionalNumber(amount),
        dbus: optionalNumber(dbus),
        currency: typeof currency === 'string' ? currency : '',
      });
    }
  }
  return recentCompletedMonths(now).map(
    ({ month }) => byMonth.get(month) ?? { month, amount: null, dbus: null, currency: '' }
  );
}

/** Coalesce concurrent reads and reuse the three-row snapshot with the Cost payload. */
export async function cachedRecentMonthlySpend(
  key: string,
  now: number,
  read: () => Promise<AppMonthlySpend[]>
): Promise<AppMonthlySpend[]> {
  const existing = cache.get(key);
  if (existing && now - existing.at < RECENT_MONTHLY_SPEND_CACHE_MS) {
    return 'value' in existing ? existing.value : existing.pending;
  }
  const pending = read();
  cache.set(key, { at: now, pending });
  try {
    const value = await pending;
    cache.set(key, { at: now, value });
    return value;
  } catch (error) {
    if (cache.get(key)?.at === now) cache.delete(key);
    throw error;
  }
}

export function forgetRecentMonthlySpend(): void {
  cache.clear();
}
