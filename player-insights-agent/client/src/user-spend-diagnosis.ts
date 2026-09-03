import type { SpendByUserPayload } from '../../shared/user-spend-contract';

export const USER_SPEND_DIAGNOSES = [
  'Lakebase update required',
  'Preparing user spend',
  'Billing access required',
  'User not added in Identity settings',
] as const;

export type UserSpendDiagnosis = (typeof USER_SPEND_DIAGNOSES)[number];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export async function userSpendHttpDiagnosis(response: Response): Promise<UserSpendDiagnosis | null> {
  const body = record(
    await response
      .clone()
      .json()
      .catch(() => null)
  );
  switch (body?.error) {
    case 'lakebase_update_required':
      return 'Lakebase update required';
    case 'monitoring_user_not_rostered':
      return 'User not added in Identity settings';
    case 'billing_access_required':
      return 'Billing access required';
    case 'user_spend_preparing':
      return 'Preparing user spend';
    default:
      return null;
  }
}

export function userSpendPayloadDiagnosis(payload: SpendByUserPayload | undefined): UserSpendDiagnosis | null {
  if (!payload || payload.state !== 'unavailable') return null;
  return USER_SPEND_DIAGNOSES.find((diagnosis) => diagnosis === payload.reason) ?? null;
}
