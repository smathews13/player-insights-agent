import type {
  GenieAccounting,
  GenieInstanceAccounting,
  GenieSurfaceAccounting,
  GenieUserAccounting,
} from '../../shared/ops-contract';
import type { CostRange, StatementParameter } from './ops-billing';

export const GENIE_ALLOWANCE_DBUS_PER_USER = 150;
export const GENIE_PROMOTION_END = '2027-01-31';
export const GENIE_FREE_SKU = 'GENIE_FREE_USAGE';
const ELIGIBLE_SURFACES = new Set(['GENIE_CODE', 'GENIE_ONE', 'GENIE_AGENTS']);

export interface GenieAccountingStatement {
  statement: string;
  parameters: StatementParameter[];
}

export interface ConfiguredGenieSpace {
  id: string;
  label: string;
  tileId: string;
}

export interface GenieAppActivity {
  usageDay: string;
  identity: string;
  spaceId: string;
  calls: number;
}

function uniqueConfiguredSpaces(spaces: readonly ConfiguredGenieSpace[]): ConfiguredGenieSpace[] {
  const unique = new Map<string, ConfiguredGenieSpace>();
  for (const space of spaces) {
    const id = space.id.trim();
    if (!id) continue;
    const existing = unique.get(id);
    unique.set(id, existing ? { ...existing, label: `${existing.label} / ${space.label}` } : { ...space, id });
  }
  return [...unique.values()];
}

/**
 * One month of identity-grain Genie usage.
 *
 * The live the demo workspace audit established the persisted fields used here:
 * `usage_metadata.genie.surface`, `.channel`,
 * `product_features.genie.offering_type`, and `identity_metadata.run_as`.
 * No Genie space id is present, so this model never claims space-level billing.
 */
export function buildGenieAccountingStatement(
  workspaceId: string,
  range: CostRange,
  configuredSpaces: readonly ConfiguredGenieSpace[] = [],
  appActivity: readonly GenieAppActivity[] = []
): GenieAccountingStatement | null {
  if (!workspaceId.trim()) return null;
  const spaces = uniqueConfiguredSpaces(configuredSpaces);
  const spaceParameters = spaces.map((space, index) => ({
    name: `genieSpace${index}`,
    value: space.id.trim(),
    type: 'STRING' as const,
  }));
  const configuredSpaceSql =
    spaceParameters.length > 0
      ? spaceParameters
          .map(({ name }, index) => `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} :${name} AS space_id`)
          .join('\n  ')
      : 'SELECT CAST(NULL AS STRING) AS space_id WHERE FALSE';
  return {
    parameters: [
      { name: 'workspaceId', value: workspaceId.trim(), type: 'STRING' },
      { name: 'from_day', value: range.from, type: 'DATE' },
      { name: 'through_day', value: range.to, type: 'DATE' },
      {
        name: 'appGenieActivity',
        value: JSON.stringify(
          appActivity.map((row) => ({
            usage_day: row.usageDay,
            identity: row.identity.trim().toLowerCase(),
            space_id: row.spaceId.trim(),
            calls: row.calls,
          }))
        ),
        type: 'STRING',
      },
      ...spaceParameters,
    ],
    statement: `WITH configured_spaces AS (
  ${configuredSpaceSql}
),
genie_usage AS (
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
    AND u.usage_date >= LEAST(:from_day, DATE_TRUNC('MONTH', :through_day))
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
),
query_space_evidence AS (
  SELECT
    CAST(q.start_time AS DATE) AS usage_date,
    LOWER(TRIM(q.executed_by)) AS run_as,
    q.query_source.genie_space_id AS space_id,
    COUNT(*) AS query_count,
    SUM(COALESCE(q.execution_duration_ms, 0)) AS execution_ms
  FROM system.query.history q
  INNER JOIN configured_spaces configured
    ON q.query_source.genie_space_id = configured.space_id
  WHERE q.workspace_id = :workspaceId
    AND q.start_time >= TIMESTAMP(LEAST(:from_day, DATE_TRUNC('MONTH', :through_day)))
    AND q.start_time < TIMESTAMP(DATE_ADD(:through_day, 1))
  GROUP BY CAST(q.start_time AS DATE), LOWER(TRIM(q.executed_by)), q.query_source.genie_space_id
),
app_space_evidence AS (
  SELECT
    TO_DATE(activity.usage_day) AS usage_date,
    LOWER(TRIM(activity.identity)) AS run_as,
    activity.space_id,
    SUM(activity.calls) AS app_calls
  FROM (
    SELECT EXPLODE(
      FROM_JSON(
        :appGenieActivity,
        'ARRAY<STRUCT<usage_day:STRING,identity:STRING,space_id:STRING,calls:DOUBLE>>'
      )
    ) AS activity
  )
  INNER JOIN configured_spaces configured
    ON activity.space_id = configured.space_id
  WHERE activity.calls > 0
    AND NULLIF(TRIM(activity.identity), '') IS NOT NULL
  GROUP BY TO_DATE(activity.usage_day), LOWER(TRIM(activity.identity)), activity.space_id
),
space_evidence AS (
  SELECT
    usage_date,
    run_as,
    space_id,
    SUM(query_count) AS query_count,
    SUM(execution_ms) AS execution_ms,
    SUM(app_calls) AS app_calls
  FROM (
    SELECT usage_date, run_as, space_id, query_count, execution_ms, CAST(0 AS DOUBLE) AS app_calls
    FROM query_space_evidence
    UNION ALL
    SELECT usage_date, run_as, space_id, CAST(0 AS BIGINT), CAST(0 AS DOUBLE), app_calls
    FROM app_space_evidence
  )
  GROUP BY usage_date, run_as, space_id
),
query_weights AS (
  SELECT
    *,
    CASE
      WHEN SUM(execution_ms) OVER (PARTITION BY usage_date, run_as) > 0
        THEN execution_ms / SUM(execution_ms) OVER (PARTITION BY usage_date, run_as)
      WHEN SUM(query_count) OVER (PARTITION BY usage_date, run_as) > 0
        THEN query_count / SUM(query_count) OVER (PARTITION BY usage_date, run_as)
      ELSE app_calls / SUM(app_calls) OVER (PARTITION BY usage_date, run_as)
    END AS allocation_weight,
    COUNT(*) OVER (PARTITION BY usage_date, run_as) AS matched_spaces
  FROM space_evidence
),
allocated AS (
  SELECT
    billing.*,
    COALESCE(weights.space_id, '') AS space_id,
    COALESCE(weights.allocation_weight, 1.0) AS allocation_weight,
    CASE
      WHEN weights.space_id IS NULL THEN 'unattributed'
      WHEN weights.matched_spaces = 1 AND weights.query_count > 0 THEN 'query-history-exact'
      WHEN weights.matched_spaces = 1 THEN 'app-ledger-exact'
      WHEN weights.query_count > 0 THEN 'query-history-allocation'
      ELSE 'app-ledger-allocation'
    END AS attribution_method
  FROM deduped billing
  LEFT JOIN query_weights weights
    ON billing.usage_date = weights.usage_date
   AND LOWER(TRIM(billing.run_as)) = weights.run_as
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
  space_id,
  attribution_method,
  SUM(usage_quantity * allocation_weight) AS dbus,
  CASE
    WHEN sku_name = '${GENIE_FREE_SKU}' THEN CAST(0 AS DOUBLE)
    WHEN COUNT(*) FILTER (WHERE price_match_count <> 1 OR unit_price IS NULL) > 0 THEN CAST(NULL AS DOUBLE)
    ELSE SUM(usage_quantity * unit_price * allocation_weight)
  END AS paid_usd,
  COUNT(*) FILTER (WHERE sku_name <> '${GENIE_FREE_SKU}' AND price_match_count = 1 AND unit_price IS NOT NULL)
    AS priced_rows,
  COUNT(*) FILTER (WHERE sku_name <> '${GENIE_FREE_SKU}' AND (price_match_count <> 1 OR unit_price IS NULL))
    AS unpriced_rows,
  COUNT(*) FILTER (WHERE record_type ILIKE '%CORRECT%' OR usage_quantity < 0) AS correction_rows,
  SUM(allocation_weight) AS source_rows,
  MAX(usage_date) AS through_day
FROM allocated
GROUP BY usage_date, run_as, identity_kind, surface, channel, offering_type, sku_name, space_id, attribution_method
ORDER BY usage_date, identity_kind, identity, space_id, surface, sku_name`,
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
  spaceId: string;
  attributionMethod: GenieInstanceAccounting['attribution'];
  dbus: number;
  paidUsd: number | null;
  pricedRows: number;
  unpricedRows: number;
  correctionRows: number;
  sourceRows: number;
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

const GENIE_ACCOUNTING_COLUMNS = [
  'usage_day',
  'identity',
  'identity_kind',
  'surface',
  'channel',
  'offering_type',
  'sku_name',
  'space_id',
  'attribution_method',
  'dbus',
  'paid_usd',
  'priced_rows',
  'unpriced_rows',
  'correction_rows',
  'source_rows',
  'through_day',
] as const;

/** Parse both Statement API JSON_ARRAY rows and named test/adapter rows without converting malformed data to zero. */
export function readGenieAccountingRows(rows: unknown): GenieAccountingRow[] {
  const parsed: GenieAccountingRow[] = [];
  if (!Array.isArray(rows)) return parsed;
  for (const raw of rows) {
    const row = Array.isArray(raw)
      ? Object.fromEntries(GENIE_ACCOUNTING_COLUMNS.map((column, index) => [column, raw[index]]))
      : raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : {};
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
      spaceId: text(row.space_id),
      attributionMethod: [
        'query-history-exact',
        'query-history-allocation',
        'app-ledger-exact',
        'app-ledger-allocation',
      ].includes(text(row.attribution_method))
        ? (text(row.attribution_method) as GenieInstanceAccounting['attribution'])
        : 'unattributed',
      dbus,
      paidUsd: number(row.paid_usd),
      pricedRows: Math.max(0, number(row.priced_rows) ?? 0),
      unpricedRows: Math.max(0, number(row.unpriced_rows) ?? 0),
      correctionRows: Math.max(0, number(row.correction_rows) ?? 0),
      sourceRows: Math.max(0, number(row.source_rows) ?? 1),
      throughDay: text(row.through_day),
    });
  }
  return parsed;
}

export function readGenieAppActivityRows(rows: unknown): GenieAppActivity[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw) => {
    const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const usageDay = text(row.usage_day);
    const identity = text(row.identity).toLowerCase();
    const spaceId = text(row.space_id);
    const calls = number(row.calls);
    return usageDay && identity && spaceId && calls !== null && calls > 0
      ? [{ usageDay, identity, spaceId, calls }]
      : [];
  });
}

interface MutableSlice {
  source: number;
  allowance: number;
  promotional: number;
  chargedEffective: number;
  chargedRaw: number;
  unknown: number;
  paidUsd: number;
  paidUsdComplete: boolean;
  hasRows: boolean;
  hasCharged: boolean;
  attribution: GenieInstanceAccounting['attribution'];
  surfaces: Map<GenieSurfaceAccounting['surface'], MutableSlice>;
}

interface MutableUser extends MutableSlice {
  identity: string;
  instances: Map<string, MutableSlice>;
}

function emptySlice(attribution: GenieInstanceAccounting['attribution']): MutableSlice {
  return {
    source: 0,
    allowance: 0,
    promotional: 0,
    chargedEffective: 0,
    chargedRaw: 0,
    unknown: 0,
    paidUsd: 0,
    paidUsdComplete: true,
    hasRows: false,
    hasCharged: false,
    attribution,
    surfaces: new Map(),
  };
}

function sliceFor(map: Map<string, MutableSlice>, key: string, attribution: GenieInstanceAccounting['attribution']) {
  const existing = map.get(key);
  if (existing) {
    if (attribution.endsWith('-allocation')) existing.attribution = attribution;
    return existing;
  }
  const created = emptySlice(attribution);
  map.set(key, created);
  return created;
}

function surfaceKey(surface: string): GenieSurfaceAccounting['surface'] {
  return ELIGIBLE_SURFACES.has(surface) ? (surface as GenieSurfaceAccounting['surface']) : 'UNKNOWN';
}

function addCategory(
  target: MutableSlice,
  surface: GenieSurfaceAccounting['surface'],
  category: 'allowance' | 'promotional' | 'charged' | 'unknown',
  quantity: number,
  raw: number,
  paidUsd: number | null,
  priced: boolean
): void {
  target.hasRows = true;
  const surfaceTarget = target.surfaces.get(surface) ?? emptySlice(target.attribution);
  target.surfaces.set(surface, surfaceTarget);
  surfaceTarget.hasRows = true;
  if (category === 'allowance') {
    target.allowance += quantity;
    surfaceTarget.allowance += quantity;
  } else if (category === 'promotional') {
    target.promotional += quantity;
    surfaceTarget.promotional += quantity;
  } else if (category === 'charged') {
    target.hasCharged = true;
    surfaceTarget.hasCharged = true;
    target.chargedEffective += quantity;
    target.chargedRaw += raw;
    surfaceTarget.chargedEffective += quantity;
    surfaceTarget.chargedRaw += raw;
    if (!priced || paidUsd === null) {
      target.paidUsdComplete = false;
      surfaceTarget.paidUsdComplete = false;
    } else {
      target.paidUsd += paidUsd;
      surfaceTarget.paidUsd += paidUsd;
    }
  } else {
    target.unknown += quantity;
    surfaceTarget.unknown += quantity;
  }
}

function pricingState(value: MutableSlice): GenieInstanceAccounting['pricingState'] {
  if (!value.hasRows) return 'none';
  if (!value.hasCharged || value.paidUsdComplete) return 'priced';
  return value.paidUsd > 0 ? 'partial' : 'unpriced';
}

function surfaceResults(value: MutableSlice): GenieSurfaceAccounting[] {
  return [...value.surfaces]
    .map(([surface, item]) => ({
      surface,
      allowanceUsedDbus: Math.max(0, item.allowance),
      promotionalDbus: Math.max(0, item.promotional),
      chargedEffectiveDbus: Math.max(0, item.chargedEffective),
      chargedRawEquivalentDbus: Math.max(0, item.chargedRaw),
      unknownDbus: Math.max(0, item.unknown),
      paidUsd: item.paidUsdComplete ? Math.max(0, item.paidUsd) : null,
    }))
    .sort((left, right) => left.surface.localeCompare(right.surface));
}

function instanceResult(space: ConfiguredGenieSpace, value: MutableSlice): GenieInstanceAccounting {
  return {
    spaceId: space.id,
    label: space.label,
    tileId: space.tileId,
    attribution: value.attribution,
    sourceDbus: value.source,
    allowanceUsedDbus: Math.max(0, value.allowance),
    promotionalDbus: Math.max(0, value.promotional),
    chargedEffectiveDbus: Math.max(0, value.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, value.chargedRaw),
    unknownDbus: Math.max(0, value.unknown),
    paidUsd: value.paidUsdComplete ? Math.max(0, value.paidUsd) : null,
    underlyingTotalDbus: Math.max(0, value.allowance + value.promotional + value.chargedRaw + value.unknown),
    pricingState: pricingState(value),
    surfaces: surfaceResults(value),
  };
}

function userResult(
  identity: string,
  value: MutableUser,
  configured: ReadonlyMap<string, ConfiguredGenieSpace>
): GenieUserAccounting {
  const allowanceUsed = Math.min(GENIE_ALLOWANCE_DBUS_PER_USER, Math.max(0, value.allowance));
  return {
    identity,
    allowanceUsedDbus: allowanceUsed,
    allowanceRemainingDbus: Math.max(0, GENIE_ALLOWANCE_DBUS_PER_USER - allowanceUsed),
    promotionalDbus: Math.max(0, value.promotional),
    chargedEffectiveDbus: Math.max(0, value.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, value.chargedRaw),
    unknownDbus: Math.max(0, value.unknown),
    paidUsd: value.paidUsdComplete ? Math.max(0, value.paidUsd) : null,
    instances: [...value.instances]
      .map(([spaceId, instance]) => {
        const space =
          configured.get(spaceId) ??
          ({ id: '', label: 'Unattributed Genie', tileId: 'genie:unattributed' } satisfies ConfiguredGenieSpace);
        const result = instanceResult(space, instance);
        const { surfaces: _surfaces, pricingState: _pricingState, ...summary } = result;
        return summary;
      })
      .sort((left, right) => left.label.localeCompare(right.label)),
  };
}

/**
 * Reconcile free allowance, promotion, and paid usage without double counting.
 *
 * During the promotion a paid row's metered DBUs are the effective quantity
 * after the 25% promotion, so its underlying/raw equivalent is `effective ×
 * 0.75`. After 2027-01-31 the metered quantity is both effective and raw.
 */
export function classifyGenieAccounting(
  rows: readonly GenieAccountingRow[],
  throughDay: string,
  configuredSpaces: readonly ConfiguredGenieSpace[] = []
): GenieAccounting {
  const promo = throughDay <= GENIE_PROMOTION_END;
  const spaces = uniqueConfiguredSpaces(configuredSpaces);
  const configured = new Map(spaces.map((space) => [space.id, space]));
  const users = new Map<string, MutableUser>();
  const instances = new Map<string, MutableSlice>();
  const diagnostics = new Set<string>();
  const overall = emptySlice('query-history-exact');
  let sourceDbus = 0;
  let sourceRows = 0;
  let newest = '';

  const human = (identity: string, usageDay: string): MutableUser => {
    const key = `${usageDay.slice(0, 7)}\u0000${identity}`;
    const existing = users.get(key);
    if (existing) return existing;
    const created: MutableUser = { ...emptySlice('query-history-exact'), identity, instances: new Map() };
    users.set(key, created);
    return created;
  };

  for (const row of rows) {
    newest = row.throughDay > newest ? row.throughDay : newest;
    const quantity = row.dbus;
    sourceDbus += quantity;
    sourceRows += row.sourceRows;
    overall.hasRows = true;
    const isFree = row.skuName === GENIE_FREE_SKU;
    const knownSurface = ELIGIBLE_SURFACES.has(row.surface);
    const person = row.identityKind === 'human' ? human(row.identity || 'Unknown human', row.usageDay) : null;
    const key = configured.has(row.spaceId) ? row.spaceId : '';
    const attribution = key ? row.attributionMethod : 'unattributed';
    const instance = sliceFor(instances, key, attribution);
    const userInstance = person ? sliceFor(person.instances, key, attribution) : null;
    const surface = surfaceKey(row.surface);
    overall.source += quantity;
    instance.source += quantity;
    if (person) person.source += quantity;
    if (userInstance) userInstance.source += quantity;

    if (isFree && row.identityKind === 'human' && knownSurface) {
      if (promo && row.surface !== 'GENIE_CODE') {
        addCategory(overall, surface, 'promotional', quantity, quantity, 0, true);
        addCategory(instance, surface, 'promotional', quantity, quantity, 0, true);
        if (person) addCategory(person, surface, 'promotional', quantity, quantity, 0, true);
        if (userInstance) addCategory(userInstance, surface, 'promotional', quantity, quantity, 0, true);
      } else {
        if (person) addCategory(person, surface, 'allowance', quantity, quantity, 0, true);
        if (userInstance) addCategory(userInstance, surface, 'allowance', quantity, quantity, 0, true);
      }
      continue;
    }

    if (isFree) {
      addCategory(overall, surface, 'unknown', quantity, quantity, 0, true);
      addCategory(instance, surface, 'unknown', quantity, quantity, 0, true);
      if (person) addCategory(person, surface, 'unknown', quantity, quantity, 0, true);
      if (userInstance) addCategory(userInstance, surface, 'unknown', quantity, quantity, 0, true);
      if (row.identityKind === 'human' && !knownSurface) {
        diagnostics.add('Free-SKU rows with an unknown Genie surface remain measured as unclassified free DBUs.');
      } else if (row.identityKind !== 'human') {
        diagnostics.add('Free-SKU rows without an identified human remain measured as unclassified free DBUs.');
      }
      continue;
    }

    const raw = promo ? quantity * 0.75 : quantity;
    const effective = promo && isFree ? quantity / 0.75 : quantity;
    const rawEquivalent = isFree ? quantity : raw;
    const priced = row.paidUsd !== null && row.unpricedRows === 0 && !isFree;
    addCategory(overall, surface, 'charged', effective, rawEquivalent, row.paidUsd, priced);
    addCategory(instance, surface, 'charged', effective, rawEquivalent, row.paidUsd, priced);
    if (person) addCategory(person, surface, 'charged', effective, rawEquivalent, row.paidUsd, priced);
    if (userInstance) addCategory(userInstance, surface, 'charged', effective, rawEquivalent, row.paidUsd, priced);
    if (row.identityKind === 'unknown') {
      diagnostics.add('Rows with missing identity were treated as charged, not as human allowance.');
    }
    if (row.correctionRows > 0) diagnostics.add('Billing corrections are included in the reconciliation.');
  }

  // The allowance is one cap per human across every space. Scale each user's
  // per-space contribution once, then add those capped contributions to the
  // overall and instance summaries. No instance receives its own 150 DBU cap.
  for (const user of users.values()) {
    const rawAllowance = Math.max(0, user.allowance);
    const capped = Math.min(GENIE_ALLOWANCE_DBUS_PER_USER, rawAllowance);
    const scale = rawAllowance > 0 ? capped / rawAllowance : 0;
    const excess = rawAllowance - capped;
    user.allowance = capped;
    user.unknown += excess;
    for (const [spaceId, userInstance] of user.instances) {
      const rawInstanceAllowance = userInstance.allowance;
      const instanceExcess = rawInstanceAllowance * (1 - scale);
      userInstance.allowance = rawInstanceAllowance * scale;
      userInstance.unknown += instanceExcess;
      const target = sliceFor(instances, spaceId, userInstance.attribution);
      target.allowance += userInstance.allowance;
      target.unknown += instanceExcess;
      target.hasRows ||= userInstance.hasRows;
      for (const [surface, userSurface] of userInstance.surfaces) {
        const rawSurfaceAllowance = userSurface.allowance;
        const surfaceExcess = rawSurfaceAllowance * (1 - scale);
        userSurface.allowance = rawSurfaceAllowance * scale;
        userSurface.unknown += surfaceExcess;
        const targetSurface = target.surfaces.get(surface) ?? emptySlice(target.attribution);
        target.surfaces.set(surface, targetSurface);
        targetSurface.allowance += userSurface.allowance;
        targetSurface.unknown += surfaceExcess;
        targetSurface.hasRows ||= userSurface.hasRows;
      }
    }
    overall.allowance += capped;
    overall.unknown += excess;
  }

  const preReconciliation = overall.allowance + overall.promotional + overall.chargedEffective + overall.unknown;
  const unclassifiedGap = sourceDbus - preReconciliation;
  if (unclassifiedGap > 1e-9) {
    const unattributedFallback = sliceFor(instances, '', 'unattributed');
    addCategory(overall, 'UNKNOWN', 'unknown', unclassifiedGap, unclassifiedGap, 0, true);
    addCategory(unattributedFallback, 'UNKNOWN', 'unknown', unclassifiedGap, unclassifiedGap, 0, true);
    diagnostics.add('Measured Genie DBUs without a known accounting class were preserved as unattributed.');
  } else if (unclassifiedGap < -1e-9) {
    diagnostics.add('Genie accounting classes exceed source DBUs; reconciliation requires investigation.');
  }

  const perUser = [...users.values()]
    .map((value) => userResult(value.identity, value, configured))
    .sort(
      (left, right) => right.allowanceUsedDbus - left.allowanceUsedDbus || left.identity.localeCompare(right.identity)
    );
  const allowanceUsed = perUser.reduce((total, user) => total + user.allowanceUsedDbus, 0);
  const allowanceRemaining = perUser.reduce((total, user) => total + user.allowanceRemainingDbus, 0);
  const allowanceCapacity = perUser.length * GENIE_ALLOWANCE_DBUS_PER_USER;
  const instanceResults = spaces.map((space) =>
    instanceResult(space, instances.get(space.id) ?? emptySlice('query-history-exact'))
  );
  const unattributedValue = instances.get('');
  const unattributed = unattributedValue
    ? instanceResult({ id: '', label: 'Unattributed Genie', tileId: 'genie:unattributed' }, unattributedValue)
    : null;
  const attributedDbus = rows.filter((row) => configured.has(row.spaceId)).reduce((total, row) => total + row.dbus, 0);
  const unattributedDbus = sourceDbus - attributedDbus;
  const directDbus = rows
    .filter((row) => configured.has(row.spaceId) && row.attributionMethod.endsWith('-exact'))
    .reduce((total, row) => total + row.dbus, 0);
  const allocatedDbus = rows
    .filter((row) => configured.has(row.spaceId) && row.attributionMethod.endsWith('-allocation'))
    .reduce((total, row) => total + row.dbus, 0);
  const classifiedDbus = Math.max(0, allowanceUsed + overall.promotional + overall.chargedEffective + overall.unknown);
  const classificationDifference = sourceDbus - classifiedDbus;
  return {
    month: throughDay.slice(0, 7),
    throughDay: newest || throughDay,
    humanUsers: perUser.length,
    allowanceDbusPerUser: GENIE_ALLOWANCE_DBUS_PER_USER,
    allowanceUsedDbus: Math.max(0, allowanceUsed),
    allowanceRemainingDbus: Math.max(0, allowanceRemaining),
    allowanceUtilization: allowanceCapacity > 0 ? Math.max(0, allowanceUsed) / allowanceCapacity : 0,
    promotionalDbus: Math.max(0, overall.promotional),
    chargedEffectiveDbus: Math.max(0, overall.chargedEffective),
    chargedRawEquivalentDbus: Math.max(0, overall.chargedRaw),
    unknownDbus: Math.max(0, overall.unknown),
    paidUsd: overall.paidUsdComplete ? Math.max(0, overall.paidUsd) : overall.hasCharged ? null : 0,
    underlyingTotalDbus: Math.max(0, allowanceUsed + overall.promotional + overall.chargedRaw + overall.unknown),
    pricingState: pricingState(overall),
    instances: instanceResults,
    unattributed,
    reconciliation: {
      sourceRows,
      sourceDbus,
      classifiedDbus,
      classificationDifferenceDbus: Math.abs(classificationDifference) < 1e-9 ? 0 : classificationDifference,
      attributedDbus,
      unattributedDbus,
      attributedShare: sourceDbus > 0 ? attributedDbus / sourceDbus : 1,
      directDbus,
      allocatedDbus,
      excludedDbus: unattributedDbus,
    },
    diagnostics: [...diagnostics],
    users: perUser,
  };
}
