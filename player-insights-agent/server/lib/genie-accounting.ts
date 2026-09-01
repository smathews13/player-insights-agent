import type { GenieAccounting, GenieUserAccounting } from '../../shared/ops-contract';
import type { CostRange, StatementParameter } from './ops-billing';

export const GENIE_ALLOWANCE_DBUS_PER_USER = 150;
export const GENIE_PROMOTION_END = '2027-01-31';
export const GENIE_FREE_SKU = 'GENIE_FREE_USAGE';
const ELIGIBLE_SURFACES = new Set(['GENIE_CODE', 'GENIE_ONE', 'GENIE_AGENTS']);

export interface GenieAccountingStatement {
  statement: string;
  parameters: StatementParameter[];
}

/**
 * One month of identity-grain Genie usage.
 *
 * The live the demo workspace audit established the persisted fields used here:
 * `usage_metadata.genie.surface`, `.channel`,
 * `product_features.genie.offering_type`, and `identity_metadata.run_as`.
 * No Genie space id is present, so this model never claims space-level billing.
 */
export function buildGenieAccountingStatement(workspaceId: string, range: CostRange): GenieAccountingStatement | null {
  if (!workspaceId.trim()) return null;
  return {
    parameters: [
      { name: 'workspaceId', value: workspaceId.trim(), type: 'STRING' },
      { name: 'through_day', value: range.to, type: 'DATE' },
    ],
    statement: `WITH genie_usage AS (
  SELECT
    COALESCE(CAST(u.record_id AS STRING),
      CONCAT_WS('|', CAST(u.workspace_id AS STRING), u.sku_name,
        CAST(u.usage_start_time AS STRING), CAST(u.usage_end_time AS STRING))) AS record_id,
    u.usage_date,
    u.usage_end_time,
    u.cloud,
    u.sku_name,
    u.usage_unit,
    u.usage_quantity,
    COALESCE(u.record_type, 'ORIGINAL') AS record_type,
    NULLIF(TRIM(u.identity_metadata.run_as), '') AS run_as,
    NULLIF(UPPER(TRIM(u.usage_metadata.genie.surface)), '') AS surface,
    NULLIF(UPPER(TRIM(u.usage_metadata.genie.channel)), '') AS channel,
    NULLIF(UPPER(TRIM(u.product_features.genie.offering_type)), '') AS offering_type
  FROM system.billing.usage u
  WHERE u.billing_origin_product = 'GENIE'
    AND u.workspace_id = :workspaceId
    AND u.usage_date >= DATE_TRUNC('MONTH', :through_day)
    AND u.usage_date <= :through_day
    AND UPPER(TRIM(u.usage_unit)) = 'DBU'
),
price_hits AS (
  SELECT
    usage.*,
    p.pricing.default AS unit_price,
    p.currency_code,
    COUNT(p.sku_name) OVER (PARTITION BY usage.record_id) AS price_match_count
  FROM genie_usage usage
  LEFT JOIN system.billing.list_prices p
    ON usage.sku_name <> '${GENIE_FREE_SKU}'
   AND usage.sku_name = p.sku_name
   AND usage.cloud = p.cloud
   AND usage.usage_unit = p.usage_unit
   AND usage.usage_end_time >= p.price_start_time
   AND (p.price_end_time IS NULL OR usage.usage_end_time < p.price_end_time)
),
deduped AS (
  SELECT
    record_id, usage_date, sku_name, usage_quantity, record_type, run_as, surface, channel, offering_type,
    MAX(price_match_count) AS price_match_count,
    MAX(unit_price) AS unit_price,
    MAX(currency_code) AS currency_code
  FROM price_hits
  GROUP BY record_id, usage_date, sku_name, usage_quantity, record_type, run_as, surface, channel, offering_type
)
SELECT
  usage_date AS usage_day,
  COALESCE(run_as, '') AS identity,
  CASE WHEN run_as LIKE '%@%' THEN 'human'
       WHEN run_as IS NULL THEN 'unknown'
       ELSE 'service_principal' END AS identity_kind,
  COALESCE(surface, '') AS surface,
  COALESCE(channel, '') AS channel,
  COALESCE(offering_type, '') AS offering_type,
  sku_name,
  SUM(usage_quantity) AS dbus,
  CASE
    WHEN sku_name = '${GENIE_FREE_SKU}' THEN CAST(0 AS DOUBLE)
    WHEN COUNT(*) FILTER (WHERE price_match_count <> 1 OR unit_price IS NULL) > 0 THEN CAST(NULL AS DOUBLE)
    ELSE SUM(usage_quantity * unit_price)
  END AS paid_usd,
  COUNT(*) FILTER (WHERE sku_name <> '${GENIE_FREE_SKU}' AND price_match_count = 1 AND unit_price IS NOT NULL)
    AS priced_rows,
  COUNT(*) FILTER (WHERE sku_name <> '${GENIE_FREE_SKU}' AND (price_match_count <> 1 OR unit_price IS NULL))
    AS unpriced_rows,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  MAX(usage_date) AS through_day
FROM deduped
GROUP BY usage_date, run_as, identity_kind, surface, channel, offering_type, sku_name
ORDER BY usage_date, identity_kind, identity, surface, sku_name`,
  };
}

export interface GenieAccountingRow {
  usageDay: string;
  identity: string;
  identityKind: 'human' | 'service_principal' | 'unknown';
  surface: string;
  channel: string;
  offeringType: string;
  skuName: string;
  dbus: number;
  paidUsd: number | null;
  pricedRows: number;
  unpricedRows: number;
  correctionRows: number;
  throughDay: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || text(value) === '') return null;
  const parsed = typeof value === 'number' ? value : Number(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse SQL rows without turning malformed quantities into measured zeroes. */
export function readGenieAccountingRows(rows: readonly Record<string, unknown>[]): GenieAccountingRow[] {
  const parsed: GenieAccountingRow[] = [];
  for (const row of rows) {
    const dbus = number(row.dbus);
    const kind = text(row.identity_kind);
    if (dbus === null || !['human', 'service_principal', 'unknown'].includes(kind)) continue;
    parsed.push({
      usageDay: text(row.usage_day),
      identity: text(row.identity),
      identityKind: kind as GenieAccountingRow['identityKind'],
      surface: text(row.surface).toUpperCase(),
      channel: text(row.channel).toUpperCase(),
      offeringType: text(row.offering_type).toUpperCase(),
      skuName: text(row.sku_name),
      dbus,
      paidUsd: number(row.paid_usd),
      pricedRows: Math.max(0, number(row.priced_rows) ?? 0),
      unpricedRows: Math.max(0, number(row.unpriced_rows) ?? 0),
      correctionRows: Math.max(0, number(row.correction_rows) ?? 0),
      throughDay: text(row.through_day),
    });
  }
  return parsed;
}

interface MutableUser {
  allowance: number;
  promotional: number;
  chargedEffective: number;
  chargedRaw: number;
  paidUsd: number;
  paidUsdComplete: boolean;
}

function userResult(identity: string, value: MutableUser): GenieUserAccounting {
  const allowanceUsed = Math.min(GENIE_ALLOWANCE_DBUS_PER_USER, Math.max(0, value.allowance));
  return {
    identity,
    allowanceUsedDbus: allowanceUsed,
    allowanceRemainingDbus: Math.max(0, GENIE_ALLOWANCE_DBUS_PER_USER - allowanceUsed),
    promotionalDbus: Math.max(0, value.promotional),
    chargedEffectiveDbus: Math.max(0, value.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, value.chargedRaw),
    paidUsd: value.paidUsdComplete ? Math.max(0, value.paidUsd) : null,
  };
}

/**
 * Reconcile free allowance, promotion, and paid usage without double counting.
 *
 * During the promotion a paid row's metered DBUs are the effective quantity
 * after the 25% promotion, so its underlying/raw equivalent is `effective ×
 * 0.75`. After 2027-01-31 the metered quantity is both effective and raw.
 */
export function classifyGenieAccounting(rows: readonly GenieAccountingRow[], throughDay: string): GenieAccounting {
  const promo = throughDay <= GENIE_PROMOTION_END;
  const users = new Map<string, MutableUser>();
  const diagnostics = new Set<string>();
  let promotional = 0;
  let chargedEffective = 0;
  let chargedRaw = 0;
  let paidUsd = 0;
  let paidUsdComplete = true;
  let newest = '';

  const human = (identity: string): MutableUser => {
    const existing = users.get(identity);
    if (existing) return existing;
    const created: MutableUser = {
      allowance: 0,
      promotional: 0,
      chargedEffective: 0,
      chargedRaw: 0,
      paidUsd: 0,
      paidUsdComplete: true,
    };
    users.set(identity, created);
    return created;
  };

  for (const row of rows) {
    newest = row.throughDay > newest ? row.throughDay : newest;
    const quantity = row.dbus;
    const isFree = row.skuName === GENIE_FREE_SKU;
    const knownSurface = ELIGIBLE_SURFACES.has(row.surface);
    const person = row.identityKind === 'human' ? human(row.identity || 'Unknown human') : null;

    if (isFree && row.identityKind === 'human' && knownSurface) {
      if (promo && row.surface !== 'GENIE_CODE') {
        promotional += quantity;
        if (person) person.promotional += quantity;
      } else {
        if (person) person.allowance += quantity;
      }
      continue;
    }

    if (isFree && row.identityKind === 'human' && !knownSurface) {
      diagnostics.add('Free-SKU rows with an unknown Genie surface were withheld from allowance and promotion.');
      continue;
    }

    const raw = promo ? quantity * 0.75 : quantity;
    const effective = promo && isFree ? quantity / 0.75 : quantity;
    chargedEffective += effective;
    chargedRaw += isFree ? quantity : raw;
    if (person) {
      person.chargedEffective += effective;
      person.chargedRaw += isFree ? quantity : raw;
    }
    if (row.paidUsd === null || row.unpricedRows > 0 || isFree) {
      paidUsdComplete = false;
      if (person) person.paidUsdComplete = false;
      if (isFree && row.identityKind !== 'human') {
        diagnostics.add('Ineligible non-human free-SKU rows are charged DBUs, but their USD price is unavailable.');
      }
    } else {
      paidUsd += row.paidUsd;
      if (person) person.paidUsd += row.paidUsd;
    }
    if (row.identityKind === 'unknown') {
      diagnostics.add('Rows with missing identity were treated as charged, not as human allowance.');
    }
    if (row.correctionRows > 0) diagnostics.add('Billing corrections are included in the reconciliation.');
  }

  const perUser = [...users]
    .map(([identity, value]) => userResult(identity, value))
    .sort(
      (left, right) => right.allowanceUsedDbus - left.allowanceUsedDbus || left.identity.localeCompare(right.identity)
    );
  const allowanceUsed = perUser.reduce((total, user) => total + user.allowanceUsedDbus, 0);
  const allowanceRemaining = perUser.reduce((total, user) => total + user.allowanceRemainingDbus, 0);
  const allowanceCapacity = perUser.length * GENIE_ALLOWANCE_DBUS_PER_USER;
  const anyRows = rows.length > 0;
  const anyCharged = chargedEffective !== 0;
  return {
    month: throughDay.slice(0, 7),
    throughDay: newest || throughDay,
    humanUsers: perUser.length,
    allowanceDbusPerUser: GENIE_ALLOWANCE_DBUS_PER_USER,
    allowanceUsedDbus: Math.max(0, allowanceUsed),
    allowanceRemainingDbus: Math.max(0, allowanceRemaining),
    allowanceUtilization: allowanceCapacity > 0 ? Math.max(0, allowanceUsed) / allowanceCapacity : 0,
    promotionalDbus: Math.max(0, promotional),
    chargedEffectiveDbus: Math.max(0, chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, chargedRaw),
    paidUsd: paidUsdComplete ? Math.max(0, paidUsd) : anyCharged ? null : 0,
    underlyingTotalDbus: Math.max(0, allowanceUsed + promotional + chargedRaw),
    pricingState: !anyRows
      ? 'none'
      : !anyCharged
        ? 'priced'
        : paidUsdComplete
          ? 'priced'
          : paidUsd > 0
            ? 'partial'
            : 'unpriced',
    diagnostics: [...diagnostics],
    users: perUser,
  };
}
