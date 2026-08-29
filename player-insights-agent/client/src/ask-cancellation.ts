export interface ActiveAskCancellation {
  correlationId: string;
  controller: AbortController;
}

export interface RegisteredActiveAsk extends ActiveAskCancellation {
  conversationId: string;
  stopRequested: boolean;
}

const activeAsks = new Map<string, RegisteredActiveAsk>();

export function registerActiveAsk(active: RegisteredActiveAsk): void {
  activeAsks.set(active.conversationId, active);
}

export function readActiveAsk(conversationId: string): RegisteredActiveAsk | null {
  return activeAsks.get(conversationId) ?? null;
}

export function forgetActiveAsk(conversationId: string, active: RegisteredActiveAsk): void {
  if (activeAsks.get(conversationId) === active) activeAsks.delete(conversationId);
}

/** Test isolation only. Navigation never clears active asks. */
export function resetActiveAsks(): void {
  activeAsks.clear();
}

/**
 * End every browser stream when the app session ends. This is intentionally not
 * a server-side run cancellation: a lost browser session must not mutate durable
 * work, but it must stop receiving and retaining that work in this tab.
 */
export function abortActiveAsksForSessionEnd(): void {
  for (const active of activeAsks.values()) {
    active.controller.abort(new DOMException('Astrolabe app session ended', 'AbortError'));
  }
  activeAsks.clear();
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
