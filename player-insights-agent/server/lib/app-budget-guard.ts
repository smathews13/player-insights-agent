import crypto from 'node:crypto';
import type { Request } from 'express';

import { appCostSummary } from '../../shared/app-cost-summary';
import {
  appBudgetPeriod,
  budgetLevelFor,
  BUDGET_APPROVAL_REQUIRED,
  emptyAppBudgetStatus,
  type AppBudgetPeriod,
  type AppBudgetStatus,
} from '../../shared/app-budget-guard';
import { costBudgetValue, normalizeCostBudget, type CostBudgetUnit } from '../../shared/cost-budgets';
import { buildHonesty, buildTiles, readComponentRows, splitBillingRows, type CostIdentifiers } from './ops-billing';
import type { OpsCostPayload } from '../../shared/ops-contract';
import { executionToken } from './execution-credential';
import { readCostBudgets } from './cost-budgets-store';
import { readAppBudgetApproval } from './app-budget-approval-store';
import { buildFoundationCostStatement, foundationCostTile, readFoundationBillingRows } from './ops-foundation-billing';
import type { InsightsAppKit } from '../routes/insights-routes';

export const APP_BUDGET_MEASUREMENT_TTL_MS = 60_000;

interface AppBudgetMeasurement {
  payload: Pick<OpsCostPayload, 'state' | 'range' | 'tiles' | 'currency' | 'honesty' | 'throughDay'>;
  readAt: string;
}

let measurementCache:
  | { key: string; at: number; value: AppBudgetMeasurement }
  | { key: string; at: number; pending: Promise<AppBudgetMeasurement | null> }
  | null = null;

/**
 * Admission reads a billing observation, not a transactional spend counter.
 * Concurrent requests may pass from the same observation and billing itself can
 * lag. Once admitted, a run is never revisited or cancelled by this guard.
 */

export function forgetAppBudgetStatus(): void {
  measurementCache = null;
}

export function appBudgetFingerprint(total: unknown): string {
  const normalized = normalizeCostBudget(total as never);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function unavailable(
  period: AppBudgetPeriod,
  readAt: string,
  input: {
    code: string;
    detail: string;
    fingerprint?: string;
    unit?: CostBudgetUnit | null;
    budget?: number | null;
    measured?: number | null;
    measuredThrough?: string;
    coverage?: 'partial' | 'unavailable';
    displayMtdSpend?: AppBudgetStatus['displayMtdSpend'];
  }
): AppBudgetStatus {
  return emptyAppBudgetStatus(period, readAt, {
    level: 'unavailable/partial',
    coverage: input.coverage ?? 'unavailable',
    budgetFingerprint: input.fingerprint ?? '',
    unit: input.unit ?? null,
    budget: input.budget ?? null,
    measured: input.measured ?? null,
    measuredThrough: input.measuredThrough ?? period.measurementThrough,
    code: input.code,
    detail: input.detail,
    ...(input.displayMtdSpend ? { displayMtdSpend: input.displayMtdSpend } : {}),
  });
}

async function queryMeasurement(
  appkit: InsightsAppKit,
  req: Request,
  period: AppBudgetPeriod,
  now: number
): Promise<AppBudgetMeasurement | null> {
  if (period.measurementThrough < period.monthStart) return null;
  const token = executionToken(req) ?? '';
  const {
    costIdentifiersFor,
    host,
    resourceActivityAttribution,
    resolveWorkspaceId,
    runStatement,
    QUESTION_COST_RUNS_QUERY,
    questionRun,
    warehouseId,
    warehouseQueryAttribution,
  } = await import('../routes/ops-routes');
  const workspace = host();
  const warehouse = warehouseId();
  if (!workspace || !warehouse || !token) return null;
  const range = { from: period.monthStart, to: period.measurementThrough };
  const workspaceId = await resolveWorkspaceId({ host: workspace, token }).catch(() => '');
  const resolved = await costIdentifiersFor(appkit, req, { workspaceId, warehouse });
  const runRows = await appkit.lakebase.query(QUESTION_COST_RUNS_QUERY, [range.from, range.to]);
  const interactiveRuns = runRows.rows.map((row) => questionRun(row));
  const interactiveComplete = interactiveRuns[0]?.evidenceComplete ?? interactiveRuns.length === 0;
  const built = (await import('./ops-billing')).buildCostStatement(resolved.ids, range);
  if (!built) return null;
  const foundationBuilt = interactiveComplete
    ? buildFoundationCostStatement(resolved.ids, range, interactiveRuns)
    : null;
  const signal = AbortSignal.timeout(50_000);
  const [outcome, queryAttribution, activity, foundationOutcome] = await Promise.all([
    runStatement({
      host: workspace,
      token,
      warehouseId: warehouse,
      statement: built.statement,
      parameters: built.parameters,
    }),
    warehouseQueryAttribution({
      host: workspace,
      token,
      warehouseId: warehouse,
      range,
      signal,
      interactiveRuns,
    }),
    resourceActivityAttribution(appkit, resolved.ids, range),
    foundationBuilt
      ? runStatement({
          host: workspace,
          token,
          warehouseId: warehouse,
          statement: foundationBuilt.statement,
          parameters: foundationBuilt.parameters,
        })
      : Promise.resolve({ ok: false as const, message: 'Foundation-model billing is unavailable.' }),
  ]);
  if (!outcome.ok) return null;
  const split = splitBillingRows(readComponentRows(outcome.rows));
  const foundation = foundationOutcome.ok
    ? foundationCostTile(resolved.ids, readFoundationBillingRows(foundationOutcome.rows))
    : foundationCostTile(resolved.ids, null, foundationOutcome.message);
  const tiles = buildTiles(resolved.ids, split.components, queryAttribution, activity, null, '', {
    interactive: {
      runs: interactiveRuns,
      complete: interactiveComplete,
    },
    foundation,
  });
  return {
    readAt: new Date(now).toISOString(),
    payload: {
      state: 'ready',
      range,
      tiles,
      currency: split.meta?.currency ?? tiles.find((tile) => tile.pricing?.currency)?.pricing?.currency ?? '',
      throughDay: split.meta?.lastDay ?? '',
      honesty: buildHonesty(range, split.meta, tiles),
    },
  };
}

async function currentMeasurement(
  appkit: InsightsAppKit,
  req: Request,
  period: AppBudgetPeriod,
  now: number,
  reader: typeof queryMeasurement
): Promise<AppBudgetMeasurement | null> {
  const key = `${period.monthStart}:${period.measurementThrough}`;
  if (measurementCache?.key === key && now - measurementCache.at < APP_BUDGET_MEASUREMENT_TTL_MS) {
    if ('value' in measurementCache) return measurementCache.value;
    return measurementCache.pending;
  }
  const pending = reader(appkit, req, period, now);
  measurementCache = { key, at: now, pending };
  const value = await pending;
  if (value) measurementCache = { key, at: now, value };
  else if (measurementCache?.key === key && 'pending' in measurementCache) measurementCache = null;
  return value;
}

export interface AppBudgetGuardOptions {
  now?: number;
  measure?: typeof queryMeasurement;
}

export async function readAppBudgetStatus(
  appkit: InsightsAppKit,
  req: Request,
  options: AppBudgetGuardOptions = {}
): Promise<AppBudgetStatus> {
  const now = options.now ?? Date.now();
  const period = appBudgetPeriod(now);
  const readAt = new Date(now).toISOString();
  const stored = await readCostBudgets(appkit, { maxAgeMs: 0, now });
  if (!stored.readable) {
    return unavailable(period, readAt, {
      code: 'APP_BUDGET_STORE_UNAVAILABLE',
      detail: 'Monthly app budget configuration could not be read.',
    });
  }
  const fingerprint = appBudgetFingerprint(stored.budgets.total);
  const configured = (['USD', 'DBU'] as const)
    .map((unit) => ({ unit, budget: costBudgetValue(stored.budgets.total, unit) }))
    .filter((entry): entry is { unit: CostBudgetUnit; budget: number } => entry.budget !== null);
  if (configured.length === 0) {
    return emptyAppBudgetStatus(period, readAt, {
      coverage: 'complete',
      budgetFingerprint: fingerprint,
    });
  }
  if (period.measurementThrough < period.monthStart) {
    return unavailable(period, readAt, {
      code: 'APP_BUDGET_MONTH_HAS_NO_COMPLETE_DAY',
      detail: 'No complete billing day is available in the current month.',
      fingerprint,
      unit: configured[0].unit,
      budget: configured[0].budget,
      coverage: 'partial',
    });
  }

  let measurement: AppBudgetMeasurement | null;
  try {
    measurement = await currentMeasurement(appkit, req, period, now, options.measure ?? queryMeasurement);
  } catch (error) {
    return unavailable(period, readAt, {
      code: 'APP_BUDGET_MEASUREMENT_FAILED',
      detail: `Attributable month-to-date billing failed to read (${(error as Error).message}).`,
      fingerprint,
      unit: configured[0].unit,
      budget: configured[0].budget,
    });
  }
  if (!measurement) {
    return unavailable(period, readAt, {
      code: 'APP_BUDGET_MEASUREMENT_UNAVAILABLE',
      detail: 'Attributable month-to-date billing could not be read.',
      fingerprint,
      unit: configured[0].unit,
      budget: configured[0].budget,
    });
  }

  const candidates = configured.map(({ unit, budget }) => {
    const summary = appCostSummary(measurement.payload, unit);
    const rawMeasured = unit === 'USD' ? summary.amount : summary.dbus;
    // Billing corrections can make a young month net-negative. They restore
    // budget headroom; they never create a negative amount in the browser.
    const measured = rawMeasured === null ? null : Math.max(0, rawMeasured);
    const currencyComplete =
      unit === 'DBU' ||
      (measurement.payload.currency.trim().toUpperCase() === 'USD' &&
        measurement.payload.honesty?.currencyConsistent !== false);
    const complete =
      measured !== null &&
      !summary.partial &&
      measurement.payload.honesty?.rangeMayStillFill !== true &&
      currencyComplete;
    return { unit, budget, measured, complete, summary };
  });
  const displayMtdSpend = Object.fromEntries(
    candidates.map((entry) => [
      entry.unit,
      {
        amount: entry.measured,
        budget: entry.budget,
        coverage: entry.complete ? 'complete' : entry.measured === null ? 'unavailable' : 'partial',
        sourceThrough: measurement.payload.throughDay || period.measurementThrough,
      },
    ])
  ) as AppBudgetStatus['displayMtdSpend'];
  const complete = candidates
    .filter(
      (entry): entry is typeof entry & { measured: number; complete: true } => entry.complete && entry.measured !== null
    )
    .map((entry) => ({ ...entry, threshold: budgetLevelFor(entry.measured, entry.budget) }))
    .sort((left, right) => right.threshold.ratio - left.threshold.ratio || left.unit.localeCompare(right.unit));
  if (complete.length === 0) {
    const first = candidates[0];
    return unavailable(period, measurement.readAt, {
      code: 'APP_BUDGET_COVERAGE_PARTIAL',
      detail: 'Current attributable billing coverage is incomplete or delayed.',
      fingerprint,
      unit: first.unit,
      budget: first.budget,
      measured: first.measured,
      measuredThrough: measurement.payload.throughDay || period.measurementThrough,
      coverage: 'partial',
      displayMtdSpend,
    });
  }

  const selected = complete[0];
  let approval = null;
  if (selected.threshold.level === 'approval-required') {
    try {
      const storedApproval = await readAppBudgetApproval(appkit, {
        period,
        budgetFingerprint: fingerprint,
        unit: selected.unit,
        budget: selected.budget,
      });
      if (storedApproval) {
        approval = {
          approved: true,
          approvedAt: storedApproval.approvedAt,
          // Consumer-visible status does not expose the administrator roster.
          approvedBy: 'An administrator',
          through: period.monthEnd,
          revokedAt: '',
        };
      }
    } catch {
      return unavailable(period, measurement.readAt, {
        code: 'APP_BUDGET_APPROVAL_STORE_UNAVAILABLE',
        detail: 'Budget approval records could not be read.',
        fingerprint,
        unit: selected.unit,
        budget: selected.budget,
        measured: selected.measured,
        displayMtdSpend,
      });
    }
  }
  const level = approval ? 'approved-overage' : selected.threshold.level;
  return {
    level,
    measured: selected.measured,
    budget: selected.budget,
    unit: selected.unit,
    ratio: selected.threshold.ratio,
    percent: selected.threshold.percent,
    monthStart: period.monthStart,
    monthEnd: period.monthEnd,
    measuredThrough: measurement.payload.throughDay || period.measurementThrough,
    readAt: measurement.readAt,
    coverage: 'complete',
    approval,
    budgetFingerprint: fingerprint,
    code:
      level === 'approval-required' ? BUDGET_APPROVAL_REQUIRED : `APP_BUDGET_${level.toUpperCase().replace('-', '_')}`,
    detail:
      level === 'approval-required'
        ? 'Measured month-to-date app-attributable spend reached the monthly app budget. An administrator must approve continued usage.'
        : '',
    displayMtdSpend,
  };
}

export function budgetGuardBlocks(status: AppBudgetStatus): boolean {
  return status.level === 'approval-required';
}

export type { CostIdentifiers };
