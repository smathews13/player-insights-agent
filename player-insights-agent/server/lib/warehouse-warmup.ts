/**
 * Wake the SQL warehouse when somebody opens the app, so their first question
 * does not pay for starting it.
 *
 * The warehouse this deployment reads through is serverless with
 * `auto_stop_mins: 5`, which is the setting we want: nobody is paying for idle
 * compute overnight. The cost of it lands entirely on one person -- whoever asks
 * the first question after a quiet spell waits for the cluster to come up before
 * any of their query runs, and every question after theirs is fast. Opening the
 * app is a reliable signal that a question is coming in the next minute or two,
 * and it is a moment where a wait costs nothing, because the reader is still
 * reading the screen. So the compute is started then instead.
 *
 * WHAT THIS IS NOT. It is not a keepalive. Nothing here runs on a timer, and
 * there is no loop: the only thing that can trigger a ping is a person arriving.
 * When nobody opens the app, nothing is pinged and `auto_stop_mins` does exactly
 * what it is set to do. This module does not read that setting, does not change
 * it, and must never be extended into something that polls -- a warehouse held up
 * around the clock by the app that was supposed to be saving money is the failure
 * mode, and it would arrive as a two-line change here.
 *
 * WHY THE START API AND NOT A TRIVIAL QUERY. The obvious alternative is to send
 * `SELECT 1`, which starts the warehouse as a side effect (`auto_resume` is on)
 * and warms the query path as well. It is the wrong tool HERE, for a reason
 * specific to how this app answers: the app does not run the question's SQL. The
 * question goes to the serving endpoint, the agent asks Genie, and Genie runs the
 * statements -- under the reader's own credential, in Genie's own session. A
 * `SELECT 1` sent from this server would warm a session belonging to the app's
 * service principal that the reader's question will never touch. It would buy the
 * shared part (the cluster) and nothing else, while adding a statement to the
 * workspace's query history that nobody asked for. The start API buys the same
 * shared part and leaves no trace: no statement, no session, no result set,
 * nothing that could be mistaken later for a query this app ran on someone's
 * behalf.
 *
 * WHOSE IDENTITY. The app's own service principal, deliberately, and NOT the
 * signed-in reader's forwarded token. Four reasons, and the last is the one that
 * settles it:
 *
 *  - Starting compute is not reading data. This call names no table, schema or
 *    catalog, so there is nothing here for a grant to govern and nothing is read
 *    under the wrong identity. On-behalf-of still decides every read the
 *    question itself makes; that is untouched by this file.
 *  - CAN_USE is the minimum permission that may start a warehouse, and CAN_USE on
 *    this warehouse is precisely what the app's `sql-warehouse` app resource
 *    grants its principal. It is the one identity this app can be sure of.
 *  - The reader's token may not exist. User authorization is a preview, and its
 *    scopes apply when the app STARTS rather than when it deploys (see
 *    `diagnoseUserToken` in ../routes/access-verification.ts). A warm-up that
 *    depended on the token would silently do nothing on a deployment where it
 *    never arrives, which is a real and current state.
 *  - A warm-up must never surface a permission error to a reader. Under the
 *    reader's token a refusal would be a true statement about their grants,
 *    arriving out of nowhere on a page they opened to read. Under the app's it is
 *    a statement about the deployment, and it is swallowed either way.
 *
 * WHY THE ASK SCREEN HAS NO "WARMING" PILL, since it is the obvious next idea.
 * That pill answers one question -- did the agent endpoint answer this app -- and
 * `run-status.ts` keys its four words on exactly that. A fifth word about the
 * warehouse would make one pill speak for two unrelated dependencies, so it could
 * read "Warming" on a deployment whose agent was unreachable, which is the kind of
 * reassuring half-truth that page was rebuilt to stop telling. It would also have
 * to be fed from somewhere: either this state joins the preflight body, which puts
 * our compute on a reader's screen and gives a failed warm-up somewhere to show
 * up, or the client fetches it separately, which is the visible request that must
 * not exist. The warm-up is meant to be something nobody notices, and a pill is
 * the opposite of that.
 */
import { withDeadline } from './deadline';

/**
 * How long to wait before pinging again.
 *
 * Chosen against the warehouse's five-minute auto-stop, which is what makes both
 * ends of the range wrong. Longer than five minutes and the warehouse can stop
 * inside our own quiet window: the next person to open the app would be refused a
 * warm-up and would pay the cold start this whole file exists to remove, which is
 * worse than not having it, because it would work in testing and fail in the
 * afternoon. Very short -- a few seconds -- and it stops collapsing anything: ten
 * people opening the app at the start of a standup is ten calls.
 *
 * A minute is a twelfth of the stop window, so a warehouse that stops is warmed
 * again by the next arrival within a minute at worst, and it is long enough that a
 * burst of arrivals or one person reloading five times is a single call. Note that
 * the cooldown is taken on EVERY attempt, including the ones that find the
 * warehouse already up: the whole feature therefore costs at most one metadata
 * read a minute however many people are using the app.
 */
export const WARMUP_COOLDOWN_MS = 60_000;

/**
 * Bound on each of the two calls.
 *
 * Both are control-plane calls that normally answer in well under a second, and
 * the start call returns as soon as the warehouse is transitioning rather than
 * waiting for it to be up. Ten seconds is generous for that and short enough that
 * a hung socket is abandoned long before the reader has finished typing. Nothing
 * waits on this, so the bound exists to stop the attempt lingering rather than to
 * protect a response.
 */
export const WARMUP_TIMEOUT_MS = 10_000;
export const WAREHOUSE_READY_TIMEOUT_MS = 90_000;
export const WAREHOUSE_READY_POLL_MS = 1_000;

/**
 * States where the compute is up, or on its way up, and calling start again would
 * be a request for something already happening.
 */
const ALREADY_WARM = new Set(['RUNNING', 'STARTING']);

/**
 * States where there is no compute to warm and a start could only fail. Reported
 * as its own outcome rather than as a failure: nothing went wrong with the call,
 * the warehouse this deployment names is going away.
 */
const NOTHING_TO_WARM = new Set(['DELETING', 'DELETED']);

export type WarmupOutcome =
  /** A start was requested. `from` is the state it was in when we asked. */
  | { kind: 'started'; from: string }
  /** Already up or coming up, so nothing was called. */
  | { kind: 'already-warm'; state: string }
  | { kind: 'nothing-to-warm'; state: string }
  /** Inside the cooldown, so nothing was called. */
  | { kind: 'cooling-down'; sinceMs: number }
  /** No warehouse is configured, so there is nothing to warm and nothing wrong. */
  | { kind: 'not-configured' }
  /** The workspace could not be asked, or refused. Never reaches a reader. */
  | { kind: 'failed'; at: 'state' | 'start'; message: string };

export function warehouseStatePath(warehouseId: string): string {
  return `/api/2.0/sql/warehouses/${encodeURIComponent(warehouseId)}`;
}

export function warehouseStartPath(warehouseId: string): string {
  return `${warehouseStatePath(warehouseId)}/start`;
}

/**
 * One call to the workspace API, as whoever the caller wired up.
 *
 * A function rather than a `fetch` plus a token, because the app's own credential
 * is an OAuth client id and secret rather than a bearer token: only the SDK can
 * turn those into a request. Keeping it behind this interface is also what lets
 * every rule below be tested without a workspace or an SDK.
 */
export type WarmupTransport = (request: { path: string; method: 'GET' | 'POST' }) => Promise<Record<string, unknown>>;

export interface WarehouseWarmup {
  /**
   * Ping the warehouse if it needs it and we have not recently.
   *
   * NEVER REJECTS, and callers must not await it. Both are load-bearing: this is
   * called from a request handler that has a page waiting on it, and a warm-up
   * that could throw or could block would turn a saved minute into a slower or
   * broken page, which is a strictly worse trade than the cold start.
   */
  warm(): Promise<WarmupOutcome>;
  /** Explicit Ask path: wait until the configured warehouse is runnable. */
  ready?(): Promise<WarehouseReadinessOutcome>;
}

export type WarehouseReadinessOutcome =
  | { kind: 'ready'; state: 'RUNNING'; waitedMs: number }
  | { kind: 'not-configured' }
  | { kind: 'nothing-to-warm'; state: string }
  | { kind: 'timed-out'; state: string; waitedMs: number }
  | { kind: 'failed'; at: 'state' | 'start'; message: string };

/**
 * Start the app warehouse when needed and wait until it can execute queries.
 * Used only after an explicit Ask; page startup continues using fire-and-forget.
 */
export async function waitForWarehouseReady(options: {
  warehouseId: string;
  transport: WarmupTransport;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  callTimeoutMs?: number;
}): Promise<WarehouseReadinessOutcome> {
  const warehouseId = options.warehouseId.trim();
  if (!warehouseId) return { kind: 'not-configured' };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const timeoutMs = options.timeoutMs ?? WAREHOUSE_READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? WAREHOUSE_READY_POLL_MS;
  const callTimeoutMs = options.callTimeoutMs ?? WARMUP_TIMEOUT_MS;
  const startedAt = now();
  let lastState = '';
  let startRequested = false;

  while (now() - startedAt <= timeoutMs) {
    try {
      const body = await withDeadline(
        options.transport({ path: warehouseStatePath(warehouseId), method: 'GET' }),
        callTimeoutMs,
        `the warehouse did not report its state within ${callTimeoutMs} ms`
      );
      lastState = typeof body.state === 'string' ? body.state.trim().toUpperCase() : '';
    } catch (error) {
      return { kind: 'failed', at: 'state', message: messageOf(error) };
    }
    if (lastState === 'RUNNING') return { kind: 'ready', state: 'RUNNING', waitedMs: now() - startedAt };
    if (NOTHING_TO_WARM.has(lastState)) return { kind: 'nothing-to-warm', state: lastState };
    if (lastState !== 'STARTING' && !startRequested) {
      try {
        await withDeadline(
          options.transport({ path: warehouseStartPath(warehouseId), method: 'POST' }),
          callTimeoutMs,
          `the warehouse did not acknowledge a start within ${callTimeoutMs} ms`
        );
        startRequested = true;
      } catch (error) {
        return { kind: 'failed', at: 'start', message: messageOf(error) };
      }
    }
    await sleep(pollMs);
  }
  return { kind: 'timed-out', state: lastState, waitedMs: now() - startedAt };
}

function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

export function createWarehouseWarmup(options: {
  /** Read at call time rather than captured, so a value set after boot is still seen. */
  warehouseId: () => string;
  transport: WarmupTransport;
  now?: () => number;
  cooldownMs?: number;
  timeoutMs?: number;
}): WarehouseWarmup {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? WARMUP_COOLDOWN_MS;
  const timeoutMs = options.timeoutMs ?? WARMUP_TIMEOUT_MS;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<WarmupOutcome> | null = null;

  async function attempt(warehouseId: string): Promise<WarmupOutcome> {
    let state: string;
    try {
      const body = await withDeadline(
        options.transport({ path: warehouseStatePath(warehouseId), method: 'GET' }),
        timeoutMs,
        `the warehouse did not report its state within ${timeoutMs} ms`
      );
      state = typeof body?.state === 'string' ? body.state.trim().toUpperCase() : '';
    } catch (error) {
      return { kind: 'failed', at: 'state', message: messageOf(error) };
    }

    // Deliberately not "start anyway". CAN_USE is what starts a warehouse and it
    // also carries the right to read the warehouse's details, so an identity that
    // could start this one can read its state: a read that failed means the call
    // path is broken -- no host, no credential, the wrong workspace -- rather than
    // that we are one permission short of the start. Firing the start blind would
    // give up the one promise this makes (never call start when it is not needed)
    // to make a call that was going to fail for the same reason.
    if (!state) {
      return { kind: 'failed', at: 'state', message: 'the warehouse reported no state' };
    }
    if (ALREADY_WARM.has(state)) return { kind: 'already-warm', state };
    if (NOTHING_TO_WARM.has(state)) return { kind: 'nothing-to-warm', state };

    try {
      await withDeadline(
        options.transport({ path: warehouseStartPath(warehouseId), method: 'POST' }),
        timeoutMs,
        `the warehouse did not acknowledge a start within ${timeoutMs} ms`
      );
      return { kind: 'started', from: state };
    } catch (error) {
      return { kind: 'failed', at: 'start', message: messageOf(error) };
    }
  }

  return {
    warm() {
      const warehouseId = options.warehouseId().trim();
      if (!warehouseId) return Promise.resolve<WarmupOutcome>({ kind: 'not-configured' });

      // Single-flight before debounce, and it hands back the attempt already
      // running rather than a "busy" verdict: two arrivals in the same instant
      // are one ping, and the second caller learns what the first one found.
      if (inFlight) return inFlight;

      const sinceMs = now() - lastAttemptAt;
      if (sinceMs < cooldownMs) return Promise.resolve<WarmupOutcome>({ kind: 'cooling-down', sinceMs });

      // Stamped before the work rather than after it, so a burst arriving while
      // the first attempt is still in its first round trip is turned away by the
      // cooldown as well as by the single flight. Stamped even when the attempt
      // goes on to fail, on purpose: a refusal or an unreachable workspace will
      // still be refused or unreachable a second later, and retrying it per
      // arrival is how a quiet warm-up becomes a hot loop against the control
      // plane.
      lastAttemptAt = now();
      inFlight = attempt(warehouseId).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    ready() {
      return waitForWarehouseReady({
        warehouseId: options.warehouseId(),
        transport: options.transport,
        now,
        timeoutMs: WAREHOUSE_READY_TIMEOUT_MS,
        pollMs: WAREHOUSE_READY_POLL_MS,
        callTimeoutMs: timeoutMs,
      });
    },
  };
}

/**
 * What a warm-up did, for the server log and nowhere else.
 *
 * Never sent to a client and never turned into a check on a page. The reader
 * asked for a screen, not for a report on our compute, and a warm-up that can
 * put a red state in front of somebody has stopped being invisible -- which was
 * the whole requirement.
 */
export function describeWarmup(outcome: WarmupOutcome): string {
  switch (outcome.kind) {
    case 'started':
      return `Warming the SQL warehouse, which was ${outcome.from}. The first question will not pay for starting it.`;
    case 'already-warm':
      return `SQL warehouse already ${outcome.state}; nothing to do.`;
    case 'nothing-to-warm':
      return `SQL warehouse is ${outcome.state}, so there is no compute to warm.`;
    case 'cooling-down':
      return `SQL warehouse pinged ${Math.round(outcome.sinceMs / 1000)}s ago; not pinging again yet.`;
    case 'not-configured':
      return 'No SQL warehouse is configured for this app, so there is nothing to warm.';
    case 'failed':
      return (
        `SQL warehouse could not be warmed (${outcome.at}): ${outcome.message}. ` +
        'This is harmless: the first question will start it as it always did.'
      );
  }
}
