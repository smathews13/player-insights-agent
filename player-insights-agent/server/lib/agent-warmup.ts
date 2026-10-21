/**
 * Waking the agent's serving endpoint before somebody asks it a question.
 *
 * An endpoint that scales to zero when idle takes minutes to come back, and the
 * first question after a quiet spell used to simply hang for that long with
 * nothing on screen to say why. This is the arrival-time counterpart of the SQL
 * warehouse warm-up: when the app opens, look at the endpoint, and if it is
 * asleep send it one request that costs nothing so it starts waking while the
 * person is still reading the screen.
 *
 * The request is an empty conversation. A scaled-to-zero endpoint has to come up
 * before it can even look at the body, and an empty body is refused by the agent
 * straight away ("A user question is required"), so no model is called and nothing
 * is billed beyond the compute that was going to be started anyway. The refusal is
 * expected and is ignored.
 */

export type AgentWarmState = 'warm' | 'waking' | 'asleep' | 'unknown';

/** What the arrival route tells the browser. `asleep` is never reported: by then it is waking. */
export type AgentArrivalState = 'warm' | 'waking' | 'unknown';

const ASLEEP = /scaled to zero/i;
const WAKING = /scaling from zero|scaling up|starting|provisioning/i;

function servedEntities(metadata: unknown): unknown[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const config = (metadata as Record<string, unknown>).config;
  if (!config || typeof config !== 'object') return [];
  const entities = (config as Record<string, unknown>).served_entities;
  return Array.isArray(entities) ? entities : [];
}

/** What the endpoint's served entities say about being awake, from its metadata. */
export function agentWarmState(metadata: unknown): AgentWarmState {
  const messages = servedEntities(metadata).flatMap((entity) => {
    if (!entity || typeof entity !== 'object') return [];
    const state = (entity as Record<string, unknown>).state;
    if (!state || typeof state !== 'object') return [];
    const message = (state as Record<string, unknown>).deployment_state_message;
    return typeof message === 'string' ? [message] : [];
  });
  if (messages.length === 0) return 'unknown';
  if (messages.some((message) => WAKING.test(message))) return 'waking';
  if (messages.some((message) => ASLEEP.test(message))) return 'asleep';
  return 'warm';
}

export interface AgentWarmupDeps {
  readMetadata: () => Promise<unknown>;
  /** Sends the empty conversation. Its outcome, including its refusal, is ignored. */
  wake: (userToken: string) => Promise<unknown>;
  now?: () => number;
  /** After a wake-up ends and the endpoint still reads asleep, wait this long before trying again. */
  retryMs?: number;
}

export const AGENT_WAKE_RETRY_MS = 30_000;

/** A wake-up held open longer than this is treated as lost, so a hung request cannot pin 'waking' forever. */
export const AGENT_WAKE_MAX_MS = 5 * 60_000;

/** The payload that wakes the endpoint without asking it anything. */
export const AGENT_WAKE_PAYLOAD = { input: [] } as const;

export function createAgentWarmup(deps: AgentWarmupDeps) {
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? AGENT_WAKE_RETRY_MS;
  let inFlightSince: number | null = null;
  let lastEndedAt = Number.NEGATIVE_INFINITY;

  return {
    /** Called as somebody arrives. Resolves quickly; never throws. */
    async arrive(userToken: string | undefined): Promise<AgentArrivalState> {
      let state: AgentWarmState;
      try {
        state = agentWarmState(await deps.readMetadata());
      } catch {
        return 'unknown';
      }
      if (state === 'warm' || state === 'unknown') return state;
      if (state !== 'asleep') return 'waking';
      // 'waking' is only said when something is actually bringing the endpoint up: a
      // wake-up still held open, or one just sent. An asleep endpoint nobody can wake
      // (no user credential) or that a wake-up just failed to wake reads 'unknown', so
      // the browser sends the question -- which wakes it itself -- instead of holding
      // it for minutes behind a wake-up that is not happening.
      if (inFlightSince !== null && now() - inFlightSince < AGENT_WAKE_MAX_MS) return 'waking';
      if (!userToken || now() - lastEndedAt < retryMs) return 'unknown';
      const sentAt = now();
      inFlightSince = sentAt;
      // Fire and forget: this request is held open until the endpoint is up.
      void deps
        .wake(userToken)
        .catch(() => undefined)
        .finally(() => {
          // Only the wake-up that is still the current one may clear the flag: a lost
          // one that settles late must not end its replacement.
          if (inFlightSince === sentAt) inFlightSince = null;
          lastEndedAt = now();
        });
      return 'waking';
    },
  };
}
