/**
 * Nominal Cost budgets: an app total plus one amount per resource tile.
 *
 * THESE ARE SETTINGS, NOT BILLING. They persist the way Runtime settings do and
 * they do not invent spend. A tile with no billing row can still have a budget;
 * a missing figure is not $0.00. The total is an independent cap for the app.
 * Cost does not add the resource budgets, and it does not add the tiles' spend
 * to compare against the total — those amounts have incompatible qualities.
 */
import { z } from 'zod';

/** Upper bound so a typo cannot store an unreadable figure. */
export const COST_BUDGET_MAX = 1_000_000_000_000;

const AmountSchema = z.number().finite().nonnegative().max(COST_BUDGET_MAX).nullable();
export const CostBudgetUnitSchema = z.enum(['USD', 'DBU']);
export type CostBudgetUnit = z.infer<typeof CostBudgetUnitSchema>;

const CostBudgetValuesSchema = z.strictObject({
  USD: AmountSchema,
  DBU: AmountSchema,
});

export const CostBudgetSchema = z.preprocess((raw) => {
  if (typeof raw === 'number' || raw === null) return { USD: raw, DBU: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if ('USD' in record || 'DBU' in record) return raw;
  if ('value' in record && (record.unit === 'USD' || record.unit === 'DBU')) {
    return {
      USD: record.unit === 'USD' ? record.value : null,
      DBU: record.unit === 'DBU' ? record.value : null,
    };
  }
  return raw;
}, CostBudgetValuesSchema);
export interface CostBudget {
  /** Current persisted shape. Both slots survive display-unit changes. */
  USD?: number | null;
  DBU?: number | null;
  /** Legacy fields accepted only while old settings and fixtures migrate. */
  value?: number | null;
  unit?: CostBudgetUnit;
}
export type LegacyCostBudget = Required<Pick<CostBudget, 'value' | 'unit'>>;
export type CostBudgetInput = CostBudget | number | null;

export function normalizeCostBudget(budget: CostBudgetInput): Required<Pick<CostBudget, 'USD' | 'DBU'>> {
  const parsed = CostBudgetSchema.safeParse(budget);
  return parsed.success ? parsed.data : { USD: null, DBU: null };
}

export function costBudgetValue(budget: CostBudgetInput, unit: CostBudgetUnit): number | null {
  return normalizeCostBudget(budget)[unit];
}

export function withCostBudgetValue(
  budget: CostBudgetInput,
  unit: CostBudgetUnit,
  value: number | null
): Required<Pick<CostBudget, 'USD' | 'DBU'>> {
  return { ...normalizeCostBudget(budget), [unit]: value };
}

export const CostBudgetsSchema = z.strictObject({
  /** App-wide cap. Null means unset, which is not zero. */
  total: CostBudgetSchema,
  /**
   * Per-tile amounts, keyed by the Cost tile id (`app-compute`, `genie:<space>`).
   * Null on a key is an explicit clear. A missing key is also unset.
   */
  resources: z.record(z.string().min(1).max(200), CostBudgetSchema),
});

export interface CostBudgets {
  total: CostBudget;
  resources: Record<string, CostBudget>;
}

export const EMPTY_COST_BUDGET: Required<Pick<CostBudget, 'USD' | 'DBU'>> = { USD: null, DBU: null };
export const EMPTY_COST_BUDGETS: CostBudgets = { total: EMPTY_COST_BUDGET, resources: {} };

/**
 * Tiles that are visible for context but cannot own a budget.
 *
 * The foundation endpoint is a configured shared endpoint, not an app-owned
 * resource. The retired rebuild-job tile stays here so an older saved document
 * cannot put that budget back onto a newer Cost payload.
 */
export const COST_BUDGET_WITHHELD_TILE_IDS = new Set(['foundation-model', 'index-rebuild-job']);

export function costBudgetEligibleTile(tileId: string): boolean {
  return !COST_BUDGET_WITHHELD_TILE_IDS.has(tileId);
}

/** Remove budgets that this Cost model is not allowed to attribute. */
export function attributableCostBudgets(budgets: CostBudgets): CostBudgets {
  return {
    total: budgets.total,
    resources: Object.fromEntries(
      Object.entries(budgets.resources).filter(([tileId]) => costBudgetEligibleTile(tileId))
    ),
  };
}

export function parseCostBudgets(raw: unknown): CostBudgets | null {
  const parsed = CostBudgetsSchema.safeParse(raw);
  return parsed.success ? attributableCostBudgets(parsed.data) : null;
}

export function resourceBudget(budgets: CostBudgets, tileId: string): CostBudget {
  if (!Object.prototype.hasOwnProperty.call(budgets.resources, tileId)) return EMPTY_COST_BUDGET;
  return budgets.resources[tileId] ?? EMPTY_COST_BUDGET;
}

/**
 * The document Save writes: the current total plus one key per visible tile.
 *
 * Keys that are not on screen are dropped rather than kept forever (a Genie
 * space that left Connections should not keep a hidden budget).
 */
export function budgetsForVisibleTiles(budgets: CostBudgets, tileIds: readonly string[]): CostBudgets {
  const resources: CostBudgets['resources'] = {};
  for (const id of tileIds) {
    if (!costBudgetEligibleTile(id)) continue;
    resources[id] = resourceBudget(budgets, id);
  }
  return { total: budgets.total, resources };
}

export function withResourceBudget(budgets: CostBudgets, tileId: string, budget: CostBudgetInput): CostBudgets {
  return {
    total: budgets.total,
    resources: { ...budgets.resources, [tileId]: normalizeCostBudget(budget) },
  };
}

export function withTotalBudget(budgets: CostBudgets, budget: CostBudgetInput): CostBudgets {
  return { total: normalizeCostBudget(budget), resources: budgets.resources };
}
