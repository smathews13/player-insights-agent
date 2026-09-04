export interface ActiveAskCancellation {
  correlationId: string;
  controller: AbortController;
}

export interface RegisteredActiveAsk extends ActiveAskCancellation {
  conversationId: string;
  stopRequested: boolean;
  /**
   * The SSE transport this browser owns.
   *
   * Kept beside the AbortController because both describe the same POST. The
   * durable poll reads this to avoid duplicating a healthy stream, and the
   * timestamps let it fall back when heartbeats stop arriving.
   */
  stream?: {
    state: 'connecting' | 'open';
    openedAt: number | null;
    lastActivityAt: number | null;
  };
}

const activeAsks = new Map<string, RegisteredActiveAsk>();
const activeAskListeners = new Set<() => void>();
export const ACTIVE_ASK_STREAM_STALE_MS = 45_000;

function announceActiveAskChange(): void {
  for (const listener of [...activeAskListeners]) listener();
}

export function subscribeToActiveAskChanges(listener: () => void): () => void {
  activeAskListeners.add(listener);
  return () => activeAskListeners.delete(listener);
}

export function registerActiveAsk(active: RegisteredActiveAsk): void {
  activeAsks.set(active.conversationId, active);
  announceActiveAskChange();
}

export function readActiveAsk(conversationId: string): RegisteredActiveAsk | null {
  return activeAsks.get(conversationId) ?? null;
}

export function forgetActiveAsk(conversationId: string, active: RegisteredActiveAsk): void {
  if (activeAsks.get(conversationId) !== active) return;
  activeAsks.delete(conversationId);
  announceActiveAskChange();
}

export function markActiveAskStreamOpen(active: RegisteredActiveAsk, at = Date.now()): void {
  if (activeAsks.get(active.conversationId) !== active) return;
  active.stream = { state: 'open', openedAt: at, lastActivityAt: at };
  announceActiveAskChange();
}

export function markActiveAskStreamActivity(active: RegisteredActiveAsk, at = Date.now()): void {
  if (activeAsks.get(active.conversationId) !== active || active.stream?.state !== 'open') return;
  active.stream.lastActivityAt = at;
  announceActiveAskChange();
}

export function activeAskHasHealthyStream(
  conversationId: string,
  runId: string,
  now = Date.now(),
  staleAfterMs = ACTIVE_ASK_STREAM_STALE_MS
): boolean {
  const active = activeAsks.get(conversationId);
  if (
    !active ||
    active.correlationId !== runId ||
    active.controller.signal.aborted ||
    active.stream?.state !== 'open' ||
    active.stream.lastActivityAt === null
  ) {
    return false;
  }
  return now - active.stream.lastActivityAt <= staleAfterMs;
}

/** Test isolation only. Navigation never clears active asks. */
export function resetActiveAsks(): void {
  activeAsks.clear();
  activeAskListeners.clear();
}

/**
 * End every browser stream when the app session ends. This is intentionally not
 * a server-side run cancellation: a lost browser session must not mutate durable
 * work, but it must stop receiving and retaining that work in this tab.
 */
export function abortActiveAsksForSessionEnd(): void {
  for (const active of activeAsks.values()) {
    active.controller.abort(new DOMException('Player Insights Agent session ended', 'AbortError'));
  }
  activeAsks.clear();
  announceActiveAskChange();
}

export interface CancelRunResponse {
  targeted: number;
  cancelled: number;
  runIds: string[];
  failures: unknown[];
}

export class CancelRunRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CancelRunRefused';
    this.status = status;
  }
}

/**
 * Make durable cancellation authoritative before closing the browser stream.
 *
 * Aborting first would only disconnect this view; the server intentionally
 * keeps work going on ordinary disconnects.
 */
export async function stopActiveAsk(
  active: ActiveAskCancellation,
  fetchImpl: typeof fetch = fetch
): Promise<CancelRunResponse> {
  const response = await fetchImpl(`/api/runs/${encodeURIComponent(active.correlationId)}/cancel`, {
    method: 'POST',
  });
  let body: Partial<CancelRunResponse> & { message?: unknown } = {};
  try {
    body = (await response.json()) as Partial<CancelRunResponse> & { message?: unknown };
  } catch {
    // The status remains enough to refuse the local abort honestly.
  }
  if (!response.ok) {
    throw new CancelRunRefused(
      response.status,
      typeof body.message === 'string' ? body.message : `The stop request answered ${response.status}.`
    );
  }
  active.controller.abort(new DOMException('Stopped by you', 'AbortError'));
  return {
    targeted: body.targeted ?? 0,
    cancelled: body.cancelled ?? 0,
    runIds: Array.isArray(body.runIds) ? body.runIds : [],
    failures: Array.isArray(body.failures) ? body.failures : [],
  };
}
