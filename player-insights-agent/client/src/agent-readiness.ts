/**
 * Whether the configured agent endpoint's metadata is reachable.
 *
 * The Ask page's status pill said "Ready" from the moment React had mounted. It
 * was a statement about the browser: the bundle had parsed. Nothing behind it had
 * been asked anything, so the pill read exactly the same on a deployment whose
 * endpoint was stopped, whose token had expired, or whose serving principal had
 * lost CAN_QUERY -- and the first a reader learnt of it was the failure of the
 * question they then spent a minute typing.
 *
 * `/api/preflight` reads endpoint metadata only. An `ok` means the configured
 * object can be seen; it does not mean this principal can query it. CAN_VIEW and
 * CAN_QUERY are separate grants, so the idle pill says "Endpoint reachable"
 * rather than promising that a question will run.
 *
 * The single-flight promise below keeps Ask and its tracked-table links on one
 * metadata request. Warehouse and Genie warmup remains a separate fire-and-forget
 * arrival request from App; readiness never wakes the serving endpoint.
 *
 * The memo is deliberately never invalidated. It is scoped to the page load, and
 * a reading is of a moment: refreshing it on a timer would produce a pill that
 * flickered between verdicts while somebody was typing, and holding it means the
 * pill can be described honestly as what was true when the screen opened.
 */
import { useEffect, useState } from 'react';

import { fetchWithTimeout } from './fetch-timeout';
import { isPreflightReport } from './preflight';
import { SESSION_CHECK_TIMEOUT_MS } from './session-checks';

/**
 * Four states, because three of them are different kinds of "not ready" and a
 * reader does something different about each. `checking` is in flight, `ready` is
 * the endpoint object being reachable, `unreachable` is its metadata read failing, and
 * `unchecked` is every way of ending up with no answer at all -- the route
 * unreachable, a body that is not a report, a report with no such check. The last
 * is never drawn as health: a check that did not run is not a check that passed,
 * which is the rule the server applies to its own overall verdict.
 */
export type AgentReadiness = 'checking' | 'ready' | 'unreachable' | 'unchecked';

/** The check `/api/preflight` adds for the endpoint the app itself invokes. */
export const AGENT_ENDPOINT_CHECK = 'agent-endpoint';

export function agentReadinessFrom(payload: unknown): AgentReadiness {
  if (!isPreflightReport(payload)) return 'unchecked';
  const check = payload.checks.find((entry) => entry.id === AGENT_ENDPOINT_CHECK);
  if (!check) return 'unchecked';
  if (check.status === 'ok') return 'ready';
  // 'failed' is the app having tried and been refused or timed out. Everything
  // else the field can hold is 'unverified', which means nobody asked.
  return check.status === 'failed' ? 'unreachable' : 'unchecked';
}

/**
 * The preflight payload, fetched at most once per page load.
 *
 * Resolves rather than rejects, including on a 503: that status is how the route
 * reports an endpoint it could not invoke, and the body is still a report saying
 * so. A caller that treated it as an error would throw away the answer.
 *
 * ON A DEADLINE, and it has to be this one rather than none. The memo above is
 * held for the life of the page, so a metadata read that never settles is not a
 * slow pill, it is a permanently unfinished one: the promise every later caller
 * awaits has no way to complete, and the pill stays on "Checking agent" until
 * the reader reloads. `null` on timeout is read as `unchecked` by
 * `agentReadinessFrom`, which is the honest verdict -- nobody got an answer --
 * and the same one a broken route already produces. The deadline is shared with
 * the identity and session reads so a reader cannot be shown two different
 * ideas of how long the same route is allowed to take.
 */
let preflightRequest: Promise<unknown> | null = null;

export function readPreflightOnce(): Promise<unknown> {
  preflightRequest ??= fetchWithTimeout('/api/preflight', {}, SESSION_CHECK_TIMEOUT_MS)
    .then((response) => response.json() as Promise<unknown>)
    .catch(() => null);
  return preflightRequest;
}

export function useAgentReadiness(): AgentReadiness {
  // Starts as `checking` rather than as a guess. The pill is drawn from the first
  // paint, and the one thing it may not say in the moment before the route
  // answers is the one thing it used to say from mount: "Ready".
  const [readiness, setReadiness] = useState<AgentReadiness>('checking');
  useEffect(() => {
    let live = true;
    void readPreflightOnce().then((payload) => {
      if (live) setReadiness(agentReadinessFrom(payload));
    });
    return () => {
      live = false;
    };
  }, []);
  return readiness;
}
