import {
  CostBudgetsSchema,
  UNKNOWN_COST_BUDGET_AUDIT,
  type CostBudgetAudit,
  type CostBudgets,
} from '../../shared/cost-budgets';
import { saveRetryAfterLoad, type SettingsLoadResult } from './settings-save-state';

export const COST_BUDGETS_UNREADABLE = 'These budgets could not be read, so there is nothing to save yet.';

type FailureBody = {
  detail?: unknown;
  message?: unknown;
};

function serverDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const failure = body as FailureBody;
  if (typeof failure.detail === 'string' && failure.detail.trim()) return failure.detail.trim();
  if (typeof failure.message === 'string' && failure.message.trim()) return failure.message.trim();
  return '';
}

export type CostBudgetsLoadResult = SettingsLoadResult & {
  budgets: CostBudgets | null;
  audit: CostBudgetAudit;
};

function auditFrom(body: unknown): CostBudgetAudit {
  const audit = body && typeof body === 'object' ? (body as { audit?: unknown }).audit : null;
  if (!audit || typeof audit !== 'object') return UNKNOWN_COST_BUDGET_AUDIT;
  const candidate = audit as { appliedAt?: unknown; appliedBy?: unknown };
  return {
    appliedAt: typeof candidate.appliedAt === 'string' ? candidate.appliedAt : '',
    appliedBy: typeof candidate.appliedBy === 'string' ? candidate.appliedBy : '',
  };
}

/**
 * Reload stored budgets. Save uses this when the Cost payload said the store
 * could not be read, so a successful retry does not keep the stale failure.
 */
export async function loadCostBudgets(): Promise<CostBudgetsLoadResult> {
  try {
    const response = await fetch('/api/admin/cost-budgets', { headers: { accept: 'application/json' } });
    const body: unknown = await response.json();
    if (!response.ok) {
      return {
        ok: false,
        message: serverDetail(body) || `The budgets endpoint answered ${response.status}.`,
        budgets: null,
        audit: UNKNOWN_COST_BUDGET_AUDIT,
      };
    }
    const readable = body && typeof body === 'object' ? (body as { readable?: unknown }).readable : undefined;
    const parsed = CostBudgetsSchema.safeParse(
      body && typeof body === 'object' ? (body as { budgets?: unknown }).budgets : undefined
    );
    if (!parsed.success) {
      return {
        ok: false,
        message: 'The budgets endpoint returned an incomplete payload.',
        budgets: null,
        audit: UNKNOWN_COST_BUDGET_AUDIT,
      };
    }
    if (readable === false) {
      return { ok: false, message: COST_BUDGETS_UNREADABLE, budgets: null, audit: auditFrom(body) };
    }
    return { ok: true, budgets: parsed.data, audit: auditFrom(body) };
  } catch (error) {
    return {
      ok: false,
      message: (error as Error).message,
      budgets: null,
      audit: UNKNOWN_COST_BUDGET_AUDIT,
    };
  }
}

export async function saveCostBudgets(budgets: CostBudgets): Promise<{ budgets: CostBudgets; audit: CostBudgetAudit }> {
  const response = await fetch('/api/admin/cost-budgets', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(budgets),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? 'The budgets endpoint returned an unreadable response.'
        : `The budgets endpoint answered ${response.status} without an error message.`
    );
  }
  if (!response.ok) {
    throw new Error(serverDetail(body) || `The budgets endpoint answered ${response.status}.`);
  }
  const parsed = CostBudgetsSchema.safeParse(
    body && typeof body === 'object' ? (body as { budgets?: unknown }).budgets : undefined
  );
  if (!parsed.success) {
    throw new Error('The budgets were not saved: the server returned an incomplete payload.');
  }
  return { budgets: parsed.data, audit: auditFrom(body) };
}

export { saveRetryAfterLoad };
