import type { UserSpendReadModelPage, UserSpendRefreshResult } from './user-spend-read-model';

export const USER_SPEND_RECOVERY_WAIT_MS = 15_000;

export type UserSpendRecoveryDiagnosis =
  | 'ready'
  | 'lakebase_update_required'
  | 'preparing_user_spend'
  | 'billing_access_required'
  | 'user_not_rostered';

export interface UserSpendRecoveryResult {
  diagnosis: UserSpendRecoveryDiagnosis;
  page: UserSpendReadModelPage | null;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return typeof error.code === 'string' ? error.code : '';
}

/**
 * PostgreSQL 42P01 is undefined_table. Only this structural failure is mapped
 * to migration recovery; permission, connection, and query errors stay in the
 * billing/storage paths and no database text crosses the HTTP boundary.
 */
export function isMissingUserSpendSchema(error: unknown): boolean {
  return errorCode(error) === '42P01';
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('user_spend_recovery_timeout')), Math.max(1, timeoutMs));
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * First-read barrier used after a verify-only Git deployment is upgraded in
 * place. It joins the read model's existing process single-flight and database
 * lock, then re-reads Lakebase before allowing the route to answer. A caller
 * never mistakes an Identity roster row for a completed spend refresh.
 */
export async function recoverInitialUserSpendRead(input: {
  read: () => Promise<UserSpendReadModelPage>;
  refresh: (() => Promise<UserSpendRefreshResult | void>) | null;
  isRostered?: () => Promise<boolean>;
  waitMs?: number;
}): Promise<UserSpendRecoveryResult> {
  let page: UserSpendReadModelPage;
  try {
    page = await input.read();
  } catch (error) {
    if (isMissingUserSpendSchema(error)) return { diagnosis: 'lakebase_update_required', page: null };
    throw error;
  }
  if (page.available) return { diagnosis: 'ready', page };
  if (input.isRostered && !(await input.isRostered())) return { diagnosis: 'user_not_rostered', page };
  if (!input.refresh) return { diagnosis: 'billing_access_required', page };

  let refresh: UserSpendRefreshResult | void;
  try {
    refresh = await bounded(input.refresh(), input.waitMs ?? USER_SPEND_RECOVERY_WAIT_MS);
  } catch {
    return { diagnosis: 'billing_access_required', page };
  }

  try {
    page = await input.read();
  } catch (error) {
    if (isMissingUserSpendSchema(error)) return { diagnosis: 'lakebase_update_required', page: null };
    throw error;
  }
  if (page.available) return { diagnosis: 'ready', page };
  return {
    diagnosis: refresh?.acquired === false ? 'preparing_user_spend' : 'billing_access_required',
    page,
  };
}
