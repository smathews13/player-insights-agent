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

export const CostBudgetsSchema = z.strictObject({
  /** App-wide cap. Null means unset, which is not zero. */
  total: AmountSchema,
  /**
   * Per-tile amounts, keyed by the Cost tile id (`app-compute`, `genie:<space>`).
   * Null on a key is an explicit clear. A missing key is also unset.
   */
  resources: z.record(z.string().min(1).max(200), AmountSchema),
});

export type CostBudgets = z.infer<typeof CostBudgetsSchema>;

export const EMPTY_COST_BUDGETS: CostBudgets = { total: null, resources: {} };

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

export function resourceBudget(budgets: CostBudgets, tileId: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(budgets.resources, tileId)) return null;
  const amount = budgets.resources[tileId];
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
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

export function withResourceBudget(budgets: CostBudgets, tileId: string, amount: number | null): CostBudgets {
  return {
    total: budgets.total,
    resources: { ...budgets.resources, [tileId]: amount },
  };
}

export function withTotalBudget(budgets: CostBudgets, amount: number | null): CostBudgets {
  return { total: amount, resources: budgets.resources };
}
