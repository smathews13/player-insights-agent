/**
 * The run in flight, held outside the component that started it.
 *
 * WHY THIS MODULE EXISTS. `askStreaming` reads a stream that is opened by the
 * Ask page and outlives it. The stages it reported used to land in that page's
 * own `useState`, so leaving Ask -- switching to Run Explorer, opening
 * Connections, picking another conversation -- destroyed every step the run had
 * reported, and coming back mounted a page with nothing in it. The run itself
 * was untouched: the durable row still said RUNNING, so the returning page
 * showed the question, restarted the elapsed counter from the row's own
 * `created_at`, and sat on "Working on your question" with a bar under it for
 * the rest of the run. A live run rendered as a frozen placeholder, and the only
 * way out was a reload, which could not help either -- a reload ends the stream.
 *
 * So the stream's output belongs to the session rather than to a mounted view.
 * The registry below is keyed by conversation, which is the key the run is
 * addressed by everywhere else: `POST /api/insights/ask` carries it,
 * `GET /api/conversations/:id/run` is read by it, and the Ask page draws exactly
 * one conversation at a time. A page mounting reads the key it is showing and is
 * told when it changes; a page unmounting stops listening and nothing else
 * happens. See `session-checks.ts`, which is the same shape for the dependency
 * checks and for the same reason.
 *
 * WHAT THIS IS NOT. It does not re-subscribe to a stream and it cannot: a
 * stream exists only on the response body of the POST that started it, and one
 * closed by a reload is gone. So there are two halves to a run outliving the
 * view that started it, and this module holds both of them in one place because
 * a view drawing two sources would be a view that can show two answers about
 * one run:
 *
 *  - The stream this browser IS holding, fed by {@link recordLiveStage} as the
 *    events arrive. This is navigating inside the app -- another tab of the nav,
 *    another conversation, Connections and back -- and it needs no server.
 *  - The run's DURABLE narration, folded in by {@link hydrateLiveAsk} from the
 *    poll of `GET /api/conversations/:id/run`. This is the case a stream cannot
 *    cover: a reload, a second browser tab, a tab closed and reopened. The app
 *    server records each step as it reports it, so the steps survive the
 *    connection that carried them.
 */
import { useCallback, useSyncExternalStore } from 'react';

import type { TraceStage } from './answer-shape';
import { mergeLiveStage, mergeReplayedStages, nextRunningSince } from './live-progress';

/** Everything one conversation's run has reported, and when it reported it. */
export interface LiveAsk {
  /** The conversation the run belongs to, which is the key it is filed under. */
  conversationId: string;
  /** The question asked, for the step rows that avoid echoing it back. */
  question: string;
  /** When the browser sent the question. Not the durable row's `created_at`. */
  startedAt: number;
  /**
   * When the route flushed the stream's opening bytes, or null before it did.
   *
   * Distinguishes "sending" from "the run has started" on the live panel, which
   * is a real difference of about half a second against a first step that can be
   * twenty away. See live-progress.ts.
   */
  streamOpenedAt: number | null;
  /** When the newest stage arrived, on this machine's clock. */
  lastStageAt: number | null;
  /**
   * When the step in progress was announced, or null when nothing is running.
   *
   * Held while ANY announced step is unresolved rather than retaken per event,
   * because a parallel batch of tools is announced together and the first one to
   * report is not the run pausing. `nextRunningSince` owns that rule.
   */
  runningSince: number | null;
  /** Every stage reported so far, announcements merged in place by id. */
  stages: TraceStage[];
  /**
   * Whether the stream this browser opened is still open.
   *
   * False once the run answered, was refused, or died. The entry is KEPT in that
   * state rather than dropped: a run that stopped after four steps is shown as
   * those four steps, and deleting them here would blank a timeline the reader
   * watched fill in. The next question in the same conversation replaces it.
   */
  inFlight: boolean;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const runs = new Map<string, LiveAsk>();

function announce(): void {
  // Over a copy: a listener that unsubscribes while being notified would
  // otherwise mutate the set being iterated.
  for (const listener of [...listeners]) listener();
}

/**
 * Listen for any change to any run. Returns the unsubscribe.
 *
 * Exported for {@link useLiveAsk} and for tests, which stand in for a mount by
 * subscribing and for an unmount by calling what this returns.
 */
export function subscribeToLiveAsks(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many views are listening. For tests; an unmount must leave none behind. */
export function liveAskListenerCount(): number {
  return listeners.size;
}

/** Reset the registry. For tests; nothing in the app clears every run. */
export function resetLiveAsks(): void {
  listeners.clear();
  runs.clear();
}

/**
 * What this conversation's run has reported, or null where it has none.
 *
 * Readable synchronously, which is the other half of why this is a module and
 * not state: the stream hands stages over faster than a render, so the merge
 * below reads the list it just wrote rather than one a render has caught up to.
 */
export function readLiveAsk(conversationId: string): LiveAsk | null {
  return runs.get(conversationId) ?? null;
}

/**
 * Start recording a run, replacing anything this conversation had before.
 *
 * A new question in a conversation is a new run: the previous run's steps are
 * not this one's, and the entry is replaced rather than merged into.
 */
export function beginLiveAsk({
  conversationId,
  question,
  startedAt = Date.now(),
}: {
  conversationId: string;
  question: string;
  startedAt?: number;
}): void {
  runs.set(conversationId, {
    conversationId,
    question,
    startedAt,
    streamOpenedAt: null,
    lastStageAt: null,
    runningSince: null,
    stages: [],
    inFlight: true,
  });
  announce();
}

/**
 * Record that the route opened the stream for this conversation's run.
 *
 * Ignored when nothing is on record, which is a run whose entry was replaced by
 * a newer question while its own stream was still opening.
 */
export function openLiveAsk(conversationId: string, at = Date.now()): void {
  const run = runs.get(conversationId);
  if (!run) return;
  runs.set(conversationId, { ...run, streamOpenedAt: at });
  announce();
}

/**
 * Fold one stage into this conversation's run.
 *
 * UNCONDITIONAL ON WHAT IS ON SCREEN, deliberately. The page used to drop any
 * stage that arrived while the reader was looking at another conversation, so a
 * run whose conversation had been switched away from lost every step from that
 * moment on -- including the steps it reported while the reader was on it, once
 * they came back. Filing by conversation makes "which run is this" a fact about
 * the stage rather than a fact about the view, and the view reads the key it is
 * showing.
 */
export function recordLiveStage(conversationId: string, stage: TraceStage, at = Date.now()): void {
  const run = runs.get(conversationId);
  if (!run) return;
  const stages = mergeLiveStage(run.stages, stage);
  runs.set(conversationId, {
    ...run,
    stages,
    lastStageAt: at,
    runningSince: nextRunningSince({ stages, since: run.runningSince, now: at }),
  });
  announce();
}

/**
 * Record that the run ended, however it ended.
 *
 * The stages stay. `runningSince` does not: a run that died inside a step leaves
 * that row standing and unresolved, and nothing should still be counting against
 * it.
 */
export function endLiveAsk(conversationId: string): void {
  const run = runs.get(conversationId);
  if (!run) return;
  runs.set(conversationId, { ...run, inFlight: false, runningSince: null });
  announce();
}

/**
 * Whether two step lists say the same thing about a run.
 *
 * Only the fields a surface draws, because that is what "nothing changed"
 * means here: a hydration that announced on every poll would re-render the
 * page once and a half a second for the whole of a two-minute run, and a
 * hydration that never announced would leave the path frozen at whatever the
 * first poll happened to catch.
 */
function sameStages(current: TraceStage[], next: TraceStage[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((stage, at) => {
    const other = next[at];
    return (
      stage.id === other.id &&
      stage.status === other.status &&
      stage.name === other.name &&
      stage.start === other.start &&
      stage.duration === other.duration &&
      stage.calls === other.calls
    );
  });
}

/**
 * Fold a run's DURABLE narration in: the steps the server recorded, for a run
 * whose stream this browser is not holding.
 *
 * THE CASE THE REGISTRY ABOVE CANNOT REACH, and the one Sam hit. Everything
 * else here is fed by a stream this browser opened, so a reload, a second tab,
 * or a tab closed and reopened leaves the registry empty while the run carries
 * on in the app server. The returning view then knew only what the durable row
 * said -- that something was working -- and drew a question, a shut composer
 * and an empty agent path until the answer landed. The steps are stored now
 * (see the server's `run-stage-events.ts`), and this is where a poll of them
 * arrives.
 *
 * MERGED, NEVER SUBSTITUTED. A view holding a live stream and polling at the
 * same time is the ordinary case one second after asking, and the replay must
 * not be able to take a step off the screen or move it: every stage is folded
 * by id, so a step both halves know about stays in its row, and only a step the
 * replay has and this browser does not is appended. The live instants are left
 * exactly as they are, because they are facts about when things arrived HERE
 * and the replay knows nothing about that.
 *
 * Announces only when the list actually moved, so a poll that learns nothing --
 * which is most polls, since steps are minutes apart late in a run -- costs a
 * comparison and no render.
 */
export function hydrateLiveAsk({
  conversationId,
  stages,
  question = '',
  startedAt = Date.now(),
  at = Date.now(),
}: {
  conversationId: string;
  /** The steps the server has recorded, oldest first. */
  stages: TraceStage[];
  /** The question, for a run this view is learning about rather than one it sent. */
  question?: string;
  /** When the run began, per its durable row, for the same case. */
  startedAt?: number;
  at?: number;
}): void {
  const run = runs.get(conversationId);
  // Nothing on record and nothing to record. A working run with no steps yet is
  // already fully described by the durable row the caller read, and inventing an
  // entry for it here would put an empty run in the registry that a later stream
  // would have to be careful not to trust.
  if (!run && stages.length === 0) return;
  const current = run?.stages ?? [];
  const merged = mergeReplayedStages(current, stages);
  if (run && sameStages(current, merged)) return;
  runs.set(conversationId, {
    conversationId,
    question: run?.question || question,
    startedAt: run?.startedAt ?? startedAt,
    // Left alone. A run this browser is streaming knows when its own stream
    // opened; one it is not has no such instant, and the durable row's start is
    // reported by the page rather than invented as a stream event here.
    streamOpenedAt: run?.streamOpenedAt ?? null,
    lastStageAt: at,
    runningSince: nextRunningSince({ stages: merged, since: run?.runningSince ?? null, now: at }),
    stages: merged,
    // A run being replayed is a run the caller found still working. A run that
    // has ended is settled by `endLiveAsk`, and its entry is kept with its steps.
    inFlight: run?.inFlight ?? true,
  });
  announce();
}

/**
 * This conversation's run, for a view that draws it.
 *
 * Re-read on every announcement rather than copied into state, so two mounts of
 * the Ask page cannot hold two versions of one run. The subscription is the
 * whole of what a mount adds and the whole of what an unmount removes.
 */
export function useLiveAsk(conversationId: string): LiveAsk | null {
  // `useSyncExternalStore` rather than an effect that copies into state, because
  // a stage can arrive between a render and that effect running: the stream is
  // already open when the page mounts, which is the whole case this module is
  // for, and a subscription established one tick late is a step lost on exactly
  // the mount that had to show it. Each mutation above replaces the entry with a
  // new object and leaves every other key alone, so the snapshot is stable
  // between announcements and this does not re-render for another conversation's
  // run.
  const snapshot = useCallback(() => readLiveAsk(conversationId), [conversationId]);
  return useSyncExternalStore(subscribeToLiveAsks, snapshot, snapshot);
}
