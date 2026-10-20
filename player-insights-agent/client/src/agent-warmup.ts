/**
 * Whether the agent's serving endpoint is being woken for this visit.
 *
 * An endpoint that scaled to zero while idle takes a couple of minutes to come
 * back, and the first question after a quiet spell used to hang that long with
 * nothing to explain it. The server wakes it as the app opens (see
 * `server/lib/agent-warmup.ts`) and answers `waking` until it is up; this polls
 * that answer so the screen can say what is happening.
 *
 * Never a gate. A failed or slow answer reads as `unknown`, a question can be
 * asked at any point, and nothing here can refuse one.
 */
import { useEffect, useState } from 'react';

export type AgentWarmup = 'unknown' | 'waking' | 'warm';

/** How often to ask again while the endpoint is waking, and how long to keep asking. */
export const AGENT_WARMUP_POLL_MS = 15_000;
export const AGENT_WARMUP_GIVE_UP_MS = 6 * 60_000;

type Fetcher = (input: string, init: { method: 'POST' }) => Promise<{ json(): Promise<unknown> }>;

export function agentWarmupFrom(payload: unknown): AgentWarmup {
  const state = payload && typeof payload === 'object' ? (payload as { state?: unknown }).state : undefined;
  return state === 'waking' || state === 'warm' ? state : 'unknown';
}

export async function readAgentWarmup(fetcher: Fetcher = fetch): Promise<AgentWarmup> {
  try {
    return agentWarmupFrom(await (await fetcher('/api/agent-warmup', { method: 'POST' })).json());
  } catch {
    return 'unknown';
  }
}

export function useAgentWarmup(): AgentWarmup {
  const [state, setState] = useState<AgentWarmup>('unknown');
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const check = async () => {
      const next = await readAgentWarmup();
      if (!live) return;
      setState(next);
      if (next === 'waking' && Date.now() - startedAt < AGENT_WARMUP_GIVE_UP_MS) {
        timer = setTimeout(() => void check(), AGENT_WARMUP_POLL_MS);
      }
    };
    void check();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return state;
}

export const AGENT_READY_POLL_MS = 5_000;

/**
 * Hold a question until the agent's endpoint is awake, the way a question waits
 * for a cold SQL warehouse.
 *
 * The arrival check only covers the moment the app opened. An endpoint can fall
 * asleep later, or restart after a release, and a question sent into that sits
 * with nothing on screen for minutes -- long enough for the short-lived Genie
 * pass the app signs with the question to expire before the model reads it.
 * Waiting here, before the question is built and its timer starts, fixes both.
 *
 * Never a gate: after `giveUpMs` the question is sent anyway, and any failure to
 * read the state counts as awake, so this cannot turn a working agent into a
 * refused question.
 */
export async function waitForAgentReady({
  fetcher = fetch,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  pollMs = AGENT_READY_POLL_MS,
  giveUpMs = AGENT_WARMUP_GIVE_UP_MS,
  onWaking,
}: {
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  giveUpMs?: number;
  onWaking?: () => void;
} = {}): Promise<'ready' | 'timed-out'> {
  const startedAt = now();
  for (;;) {
    if ((await readAgentWarmup(fetcher)) !== 'waking') return 'ready';
    if (now() - startedAt >= giveUpMs) return 'timed-out';
    onWaking?.();
    await sleep(pollMs);
  }
}
