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
