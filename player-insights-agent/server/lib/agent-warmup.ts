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
  /** Do not send another wake-up within this long of the last one. */
  cooldownMs?: number;
}

export const AGENT_WAKE_COOLDOWN_MS = 5 * 60_000;

/** The payload that wakes the endpoint without asking it anything. */
export const AGENT_WAKE_PAYLOAD = { input: [] } as const;

export function createAgentWarmup(deps: AgentWarmupDeps) {
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? AGENT_WAKE_COOLDOWN_MS;
  let lastWakeAt = Number.NEGATIVE_INFINITY;

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
      if (state === 'asleep' && userToken && now() - lastWakeAt >= cooldownMs) {
        lastWakeAt = now();
        // Fire and forget: this request is held open until the endpoint is up.
        void deps.wake(userToken).catch(() => undefined);
      }
      return 'waking';
    },
  };
}
