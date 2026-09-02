import { appTable } from '../../shared/app-schema';
import {
  EMPTY_COST_BUDGETS,
  UNKNOWN_COST_BUDGET_AUDIT,
  parseCostBudgets,
  type CostBudgetAudit,
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

let cache = new WeakMap<object, { value: CostBudgetsRead; at: number }>();
export const COST_BUDGETS_TTL_MS = 15_000;

export function forgetCostBudgets(): void {
  cache = new WeakMap();
}

export interface CostBudgetsRead {
  budgets: CostBudgets;
  audit: CostBudgetAudit;
  readable: boolean;
}

function auditFrom(row: Record<string, unknown> | undefined): CostBudgetAudit {
  const updatedAt = row?.updated_at;
  return {
    appliedAt: updatedAt instanceof Date ? updatedAt.toISOString() : typeof updatedAt === 'string' ? updatedAt : '',
    appliedBy: typeof row?.updated_by === 'string' ? row.updated_by : '',
  };
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
    return cached.value;
  }
  try {
    const result = await client.lakebase.query(
      `SELECT settings, updated_at, updated_by FROM ${COST_BUDGETS_TABLE} WHERE id = $1`,
      [KEY]
    );
    const row = result?.rows?.[0];
    const raw = row?.settings;
    if (raw === undefined) {
      const value = { budgets: EMPTY_COST_BUDGETS, audit: UNKNOWN_COST_BUDGET_AUDIT, readable: true as const };
      cache.set(client, { value, at: now });
      return value;
    }
    const parsed = parseCostBudgets(raw);
    if (!parsed) {
      console.warn('[cost-budgets] Stored budgets were unreadable; leaving them unset rather than guessing.');
      return { budgets: EMPTY_COST_BUDGETS, audit: auditFrom(row), readable: false };
    }
    const value = { budgets: parsed, audit: auditFrom(row), readable: true as const };
    cache.set(client, { value, at: now });
    return value;
  } catch (error) {
    console.warn('[cost-budgets] Stored budgets could not be read:', (error as Error).message);
    return { budgets: EMPTY_COST_BUDGETS, audit: UNKNOWN_COST_BUDGET_AUDIT, readable: false };
  }
}

export async function writeCostBudgets(
  client: LakebaseReader,
  budgets: CostBudgets,
  updatedBy: string
): Promise<CostBudgetsRead> {
  const result = await client.lakebase.query(
    `INSERT INTO ${COST_BUDGETS_TABLE} (id, settings, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       settings = EXCLUDED.settings,
       updated_by = CASE
         WHEN cost_budgets.settings -> 'total' IS DISTINCT FROM EXCLUDED.settings -> 'total'
         THEN EXCLUDED.updated_by ELSE cost_budgets.updated_by END,
       updated_at = CASE
         WHEN cost_budgets.settings -> 'total' IS DISTINCT FROM EXCLUDED.settings -> 'total'
         THEN now() ELSE cost_budgets.updated_at END
     RETURNING updated_at, updated_by`,
    [KEY, JSON.stringify(budgets), updatedBy]
  );
  forgetCostBudgets();
  return { budgets, audit: auditFrom(result?.rows?.[0]), readable: true };
}
