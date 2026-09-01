import crypto from 'node:crypto';

import { appTable } from '../../shared/app-schema';
import type { AppBudgetCoverage, AppBudgetPeriod } from '../../shared/app-budget-guard';
import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { LakebaseReader } from './lakebase-store';

export const APP_BUDGET_APPROVALS_TABLE = appTable('app_budget_approvals');

export interface StoredAppBudgetApproval {
  id: string;
  approvedBy: string;
  approvedAt: string;
  revokedBy: string;
  revokedAt: string;
}

interface ApprovalKey {
  period: AppBudgetPeriod;
  budgetFingerprint: string;
  unit: CostBudgetUnit;
  budget: number;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return '';
}

function approvalFrom(row: Record<string, unknown> | undefined): StoredAppBudgetApproval | null {
  if (!row) return null;
  return {
    id: text(row.id),
    approvedBy: text(row.approved_by),
    approvedAt: text(row.approved_at),
    revokedBy: text(row.revoked_by),
    revokedAt: text(row.revoked_at),
  };
}

export async function readAppBudgetApproval(
  client: LakebaseReader,
  key: ApprovalKey
): Promise<StoredAppBudgetApproval | null> {
  const result = await client.lakebase.query(
    `SELECT id, approved_by, approved_at, revoked_by, revoked_at
       FROM ${APP_BUDGET_APPROVALS_TABLE}
      WHERE period_start = $1::date
        AND budget_fingerprint = $2
        AND budget_unit = $3
        AND budget_value = $4::numeric
        AND revoked_at IS NULL
      LIMIT 1`,
    [key.period.monthStart, key.budgetFingerprint, key.unit, key.budget]
  );
  return approvalFrom(result.rows[0]);
}

export async function approveAppBudget(
  client: LakebaseReader,
  input: ApprovalKey & {
    actor: string;
    measured: number;
    coverage: AppBudgetCoverage;
    readAt: string;
    measuredThrough: string;
  }
): Promise<StoredAppBudgetApproval> {
  const id = `budget-approval-${crypto
    .createHash('sha256')
    .update(`${input.period.monthStart}|${input.budgetFingerprint}|${input.unit}|${input.budget}`)
    .digest('hex')
    .slice(0, 32)}`;
  const coverage = JSON.stringify({
    quality: input.coverage,
    measuredThrough: input.measuredThrough,
    readAt: input.readAt,
  });
  const inserted = await client.lakebase.query(
    `INSERT INTO ${APP_BUDGET_APPROVALS_TABLE}
       (id, period_start, period_end, budget_fingerprint, budget_unit, budget_value,
        measured_amount, coverage, approved_by, approved_at)
     VALUES ($1, $2::date, $3::date, $4, $5, $6::numeric, $7::numeric, $8::jsonb, $9, now())
     ON CONFLICT (period_start, budget_fingerprint, budget_unit, budget_value) DO UPDATE SET
       measured_amount = EXCLUDED.measured_amount,
       coverage = EXCLUDED.coverage,
       approved_by = CASE
         WHEN ${APP_BUDGET_APPROVALS_TABLE}.revoked_at IS NULL
           THEN ${APP_BUDGET_APPROVALS_TABLE}.approved_by
         ELSE EXCLUDED.approved_by
       END,
       approved_at = CASE
         WHEN ${APP_BUDGET_APPROVALS_TABLE}.revoked_at IS NULL
           THEN ${APP_BUDGET_APPROVALS_TABLE}.approved_at
         ELSE now()
       END,
       revoked_by = NULL,
       revoked_at = NULL
     RETURNING id, approved_by, approved_at, revoked_by, revoked_at`,
    [
      id,
      input.period.monthStart,
      input.period.monthEnd,
      input.budgetFingerprint,
      input.unit,
      input.budget,
      input.measured,
      coverage,
      input.actor,
    ]
  );
  const created = approvalFrom(inserted.rows[0]);
  if (created) return created;
  throw new Error('The matching approval could not be stored.');
}

export async function revokeAppBudgetApproval(
  client: LakebaseReader,
  input: ApprovalKey & { actor: string }
): Promise<StoredAppBudgetApproval | null> {
  const result = await client.lakebase.query(
    `UPDATE ${APP_BUDGET_APPROVALS_TABLE}
        SET revoked_by = $5, revoked_at = now()
      WHERE period_start = $1::date
        AND budget_fingerprint = $2
        AND budget_unit = $3
        AND budget_value = $4::numeric
        AND revoked_at IS NULL
     RETURNING id, approved_by, approved_at, revoked_by, revoked_at`,
    [input.period.monthStart, input.budgetFingerprint, input.unit, input.budget, input.actor]
  );
  return approvalFrom(result.rows[0]);
}
