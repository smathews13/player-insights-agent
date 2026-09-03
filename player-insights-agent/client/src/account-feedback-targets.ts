import {
  accountFeedbackTargets,
  safeAccountFeedbackTargets,
  type AccountFeedbackTargets,
} from '../../shared/account-feedback';

let cachedTargets: AccountFeedbackTargets | null = null;

export async function readAccountFeedbackTargets(signal?: AbortSignal): Promise<AccountFeedbackTargets> {
  if (cachedTargets) return cachedTargets;
  try {
    const response = await fetch('/api/account/feedback-targets', {
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) throw new Error(`Feedback targets unavailable (${response.status})`);
    cachedTargets = safeAccountFeedbackTargets(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    cachedTargets = accountFeedbackTargets();
  }
  return cachedTargets;
}

export function resetAccountFeedbackTargetsForTests(): void {
  cachedTargets = null;
}
