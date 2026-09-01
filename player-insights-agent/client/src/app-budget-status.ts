import { useEffect, useState } from 'react';

import {
  APP_BUDGET_COVERAGES,
  APP_BUDGET_LEVELS,
  appBudgetPeriod,
  emptyAppBudgetStatus,
  type AppBudgetApproval,
  type AppBudgetCoverage,
  type AppBudgetLevel,
  type AppBudgetStatus,
  type AppBudgetUnit,
} from '../../shared/app-budget-contract';

const CLIENT_STATUS_TTL_MS = 60_000;
let cached: { value: AppBudgetStatus; at: number } | null = null;
let pending: Promise<AppBudgetStatus> | null = null;
const listeners = new Set<(status: AppBudgetStatus) => void>();

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNonNegativeOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function approvalFrom(value: unknown): AppBudgetApproval | null | undefined {
  if (value === null) return null;
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.approved !== 'boolean' ||
    typeof candidate.approvedAt !== 'string' ||
    typeof candidate.approvedBy !== 'string' ||
    typeof candidate.through !== 'string' ||
    typeof candidate.revokedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    approved: candidate.approved,
    approvedAt: candidate.approvedAt,
    approvedBy: candidate.approvedBy,
    through: candidate.through,
    revokedAt: candidate.revokedAt,
  };
}

/**
 * Decode only the server-computed fields the composer displays or sends back.
 * Threshold, coverage, and approval decisions are never recomputed here.
 */
export function decodeAppBudgetStatus(value: unknown): AppBudgetStatus | null {
  const candidate = record(value);
  if (!candidate) return null;
  const level = candidate.level;
  const coverage = candidate.coverage;
  const unit = candidate.unit;
  const measured = finiteNonNegativeOrNull(candidate.measured);
  const budget = finiteNonNegativeOrNull(candidate.budget);
  const ratio = finiteNonNegativeOrNull(candidate.ratio);
  const percent = finiteNonNegativeOrNull(candidate.percent);
  const approval = approvalFrom(candidate.approval);
  if (
    typeof level !== 'string' ||
    !APP_BUDGET_LEVELS.includes(level as AppBudgetLevel) ||
    measured === undefined ||
    budget === undefined ||
    (unit !== null && unit !== 'USD' && unit !== 'DBU') ||
    ratio === undefined ||
    percent === undefined ||
    typeof candidate.monthStart !== 'string' ||
    typeof candidate.monthEnd !== 'string' ||
    typeof candidate.measuredThrough !== 'string' ||
    typeof candidate.readAt !== 'string' ||
    typeof coverage !== 'string' ||
    !APP_BUDGET_COVERAGES.includes(coverage as AppBudgetCoverage) ||
    approval === undefined ||
    typeof candidate.budgetFingerprint !== 'string' ||
    typeof candidate.code !== 'string' ||
    typeof candidate.detail !== 'string'
  ) {
    return null;
  }
  return {
    level: level as AppBudgetLevel,
    measured,
    budget,
    unit: unit as AppBudgetUnit | null,
    ratio,
    percent,
    monthStart: candidate.monthStart,
    monthEnd: candidate.monthEnd,
    measuredThrough: candidate.measuredThrough,
    readAt: candidate.readAt,
    coverage: coverage as AppBudgetCoverage,
    approval,
    budgetFingerprint: candidate.budgetFingerprint,
    code: candidate.code,
    detail: candidate.detail,
  };
}

function unavailableStatus(detail: string): AppBudgetStatus {
  const now = Date.now();
  return emptyAppBudgetStatus(appBudgetPeriod(now), new Date(now).toISOString(), {
    level: 'unavailable/partial',
    coverage: 'unavailable',
    code: 'APP_BUDGET_STATUS_UNAVAILABLE',
    detail: `Budget status unavailable: ${detail}`,
  });
}

function publish(status: AppBudgetStatus): AppBudgetStatus {
  cached = { value: status, at: Date.now() };
  for (const listener of listeners) listener(status);
  return status;
}

/** Accept the server-authoritative status carried by a raced Ask refusal. */
export function acceptAppBudgetStatus(status: unknown): AppBudgetStatus {
  return publish(
    decodeAppBudgetStatus(status) ?? unavailableStatus('the Ask refusal carried an invalid budget status.')
  );
}

export function invalidateAppBudgetStatus(): void {
  cached = null;
}

export async function loadAppBudgetStatus(force = false): Promise<AppBudgetStatus> {
  const now = Date.now();
  if (!force && cached && now - cached.at < CLIENT_STATUS_TTL_MS) return cached.value;
  if (!force && pending) return pending;
  pending = fetch('/api/budget-status', { headers: { accept: 'application/json' } })
    .then(async (response) => {
      const body: unknown = await response.json().catch(() => null);
      const parsed = decodeAppBudgetStatus(body);
      if (!response.ok || !parsed) {
        const detail =
          body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string'
            ? String((body as { detail: string }).detail)
            : `the status endpoint answered ${response.status}.`;
        return unavailableStatus(detail);
      }
      return parsed;
    })
    .catch((error: Error) => unavailableStatus(error.message))
    .then(publish)
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function refreshAppBudgetStatus(): void {
  invalidateAppBudgetStatus();
  publish(unavailableStatus('the changed monthly app budget is being re-read.'));
  void loadAppBudgetStatus(true);
}

async function mutateApproval(method: 'POST' | 'DELETE', status: AppBudgetStatus): Promise<AppBudgetStatus> {
  const response = await fetch('/api/admin/budget-approval', {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ budgetFingerprint: status.budgetFingerprint }),
  });
  const body: unknown = await response.json().catch(() => null);
  const parsed = decodeAppBudgetStatus(
    body && typeof body === 'object' ? (body as { status?: unknown }).status : undefined
  );
  if (!response.ok || !parsed) {
    const detail =
      body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string'
        ? String((body as { detail: string }).detail)
        : `The approval endpoint answered ${response.status}.`;
    throw new Error(detail);
  }
  invalidateAppBudgetStatus();
  return publish(parsed);
}

export function approveContinuedUsage(status: AppBudgetStatus): Promise<AppBudgetStatus> {
  return mutateApproval('POST', status);
}

export function revokeContinuedUsage(status: AppBudgetStatus): Promise<AppBudgetStatus> {
  return mutateApproval('DELETE', status);
}

export function useAppBudgetStatus(): AppBudgetStatus | null {
  const [status, setStatus] = useState<AppBudgetStatus | null>(() => cached?.value ?? null);
  useEffect(() => {
    let active = true;
    const receive = (next: AppBudgetStatus) => {
      if (active) setStatus(next);
    };
    listeners.add(receive);
    void loadAppBudgetStatus().then(receive);
    const onVisibility = () => {
      if (document.hidden) return;
      const stale = !cached || Date.now() - cached.at >= CLIENT_STATUS_TTL_MS;
      if (stale) void loadAppBudgetStatus(true).then(receive);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      active = false;
      listeners.delete(receive);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, []);
  return status;
}

/** Test seam for module-scoped request caching. */
export function forgetClientAppBudgetStatus(): void {
  cached = null;
  pending = null;
  listeners.clear();
}
