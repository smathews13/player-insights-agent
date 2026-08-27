import { appTable } from '../../shared/app-schema';
import {
  EMPTY_COST_BUDGETS,
  parseCostBudgets,
  type CostBudgets,
} from '../../shared/cost-budgets';
import type { LakebaseReader } from './lakebase-store';

const KEY = 'effective';

export const COST_BUDGETS_TABLE = appTable('cost_budgets');

export const COST_BUDGETS_DDL = `CREATE TABLE IF NOT EXISTS ${COST_BUDGETS_TABLE} (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

let cache = new WeakMap<object, { value: CostBudgets; at: number; readable: true }>();
export const COST_BUDGETS_TTL_MS = 15_000;

export function forgetCostBudgets(): void {
  cache = new WeakMap();
}

export interface CostBudgetsRead {
  budgets: CostBudgets;
  readable: boolean;
}

/**
 * The stored budgets, or empty when none have been set.
 *
 * A Lakebase outage answers with empty budgets and `readable: false` rather
 * than throwing, so Cost can still draw spend tiles and Save can retry the
 * load. A missing row is readable: nothing has been saved yet.
 */
export async function readCostBudgets(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<CostBudgetsRead> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? COST_BUDGETS_TTL_MS)) {
    return { budgets: cached.value, readable: true };
  }
  try {
    const result = await client.lakebase.query(`SELECT settings FROM ${COST_BUDGETS_TABLE} WHERE id = $1`, [KEY]);
    const raw = result?.rows?.[0]?.settings;
    if (raw === undefined) {
      cache.set(client, { value: EMPTY_COST_BUDGETS, at: now, readable: true });
      return { budgets: EMPTY_COST_BUDGETS, readable: true };
    }
    const parsed = parseCostBudgets(raw);
    if (!parsed) {
      console.warn('[cost-budgets] Stored budgets were unreadable; leaving them unset rather than guessing.');
      return { budgets: EMPTY_COST_BUDGETS, readable: false };
    }
    cache.set(client, { value: parsed, at: now, readable: true });
    return { budgets: parsed, readable: true };
  } catch (error) {
    console.warn('[cost-budgets] Stored budgets could not be read:', (error as Error).message);
    return { budgets: EMPTY_COST_BUDGETS, readable: false };
  }
}

export async function writeCostBudgets(
  client: LakebaseReader,
  budgets: CostBudgets,
  updatedBy: string
): Promise<CostBudgets> {
  await client.lakebase.query(
    `INSERT INTO ${COST_BUDGETS_TABLE} (id, settings, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(budgets), updatedBy]
  );
  forgetCostBudgets();
  return budgets;
}
