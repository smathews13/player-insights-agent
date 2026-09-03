/**
 * The reads that more than one page makes: who is signed in, whether the store
 * is answering, and one run's own trace.
 *
 * Lifted out of App.tsx when the router file was split into one module per page.
 * Each of these is read by two surfaces at once -- the header and Ask PIA both
 * want the identity, Run Explorer and the Benchmark Lab both want a trace -- and
 * a second copy of any of them is a second chance to disagree about the same
 * fact. A page importing them from App.tsx would be a cycle, App.tsx imports the
 * pages.
 */
import { useEffect, useState } from 'react';
import type { Identity, RunTrace } from './app-types';
import { normalizeStage } from './answer-shape';
import { sanitizeOrganizationMappings } from '../../shared/organization-contract';
import type { StorageHealth } from './storage-banner-copy';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE } from './user-initials';
import { browserPollHost, pollWhileVisible } from './visibility-polling';

let identityPromise: Promise<unknown> | null = null;
let resolvedIdentity: Identity | null = null;

/**
 * The session's one read of who is signed in.
 *
 * AccessGate and the shell both need the same payload. Keeping the promise at
 * module scope means React Strict Mode, and two consumers mounting together,
 * cannot turn that into two Lakebase role reads whose answers may race.
 */
export function identityRequest(): Promise<unknown> {
  if (!identityPromise) {
    identityPromise = fetch('/api/identity')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('Identity unavailable'))))
      .catch((error: unknown) => {
        /*
         * A refused or failed read is not "who this session is". Holding it would
         * make every later caller, including a retry after the network recovers,
         * replay that one failure until a full reload. Drop the cache on the way
         * out so the next ask is a new request; in-flight callers still share
         * this same rejection.
         */
        identityPromise = null;
        throw error;
      });
  }
  return identityPromise;
}

/** Tests that stub `fetch` must forget a prior answer, or they read that answer. */
export function forgetIdentityRequest() {
  identityPromise = null;
  resolvedIdentity = null;
}

/**
 * How long this read may go unanswered before it is called unavailable.
 *
 * A REQUEST THAT NEVER SETTLES IS THE THIRD OUTCOME, and it had no handling: a
 * `fetch` that neither resolves nor rejects leaves this hook returning the
 * resolving placeholder for as long as the tab is open. Every surface reading it
 * then shows its own loading state forever, which is the shape a reader cannot
 * tell from a broken one. The role badge is the sharpest case, because its
 * resolving state is specified as a blank chip: stuck resolving and not
 * rendered at all are the same pixels.
 *
 * Twelve seconds is chosen against the route rather than against a feeling. It
 * reads headers the container already holds and answers in milliseconds warm;
 * anything past this is not slow, it is not coming.
 */
export const IDENTITY_DEADLINE_MS = 12_000;

/**
 * What the identity becomes when the deadline passes, given what it is now.
 *
 * A function rather than three lines inside the timer so it can be tested: the
 * hook around it needs a DOM and this suite runs in node, and "an unanswered
 * read ends up somewhere role.ts calls failed" is the claim worth pinning.
 *
 * ONLY MOVES A READ THAT IS STILL RESOLVING. An answer that lands late is still
 * the truth, and a deadline that overwrote it would turn a slow success into a
 * reported failure.
 */
export function identityAfterDeadline(current: Identity): Identity {
  if (current.signedInAs !== IDENTITY_RESOLVING) return current;
  return { ...current, signedInAs: IDENTITY_UNAVAILABLE };
}

const unavailableIdentity = (): Identity => ({
  signedInAs: IDENTITY_UNAVAILABLE,
  executionMode: 'service-principal',
});

/**
 * Turn the untrusted identity response into the shape the shell can render.
 *
 * The endpoint may answer JSON `null` while the Apps identity is unavailable.
 * A cast does not change that runtime value: passing it through made the shell
 * read `.role` from null before Settings could render. Invalid or incomplete
 * payloads now become the existing visible unavailable-identity state.
 */
export function identityFromResponse(value: unknown): Identity {
  if (!value || typeof value !== 'object') return unavailableIdentity();
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.signedInAs !== 'string') return unavailableIdentity();
  const organizations = sanitizeOrganizationMappings(candidate.organizations);
  const organization = sanitizeOrganizationMappings([candidate.organization])[0];

  return {
    signedInAs: candidate.signedInAs,
    ...(typeof candidate.canonicalEmail === 'string' && candidate.canonicalEmail.includes('@')
      ? { canonicalEmail: candidate.canonicalEmail }
      : candidate.canonicalEmail === null
        ? { canonicalEmail: null }
        : {}),
    ...(typeof candidate.displayName === 'string' && candidate.displayName.trim()
      ? { displayName: candidate.displayName.trim() }
      : {}),
    ...(typeof candidate.identityRevision === 'string' && candidate.identityRevision
      ? { identityRevision: candidate.identityRevision }
      : {}),
    ...(organization ? { organization } : {}),
    executionMode: typeof candidate.executionMode === 'string' ? candidate.executionMode : 'service-principal',
    ...(organizations.length > 0 ? { organizations } : {}),
    ...(candidate.identitySource === 'databricks-apps' || candidate.identitySource === 'development-fallback'
      ? { identitySource: candidate.identitySource }
      : {}),
    ...(typeof candidate.sharedConversationRail === 'boolean'
      ? { sharedConversationRail: candidate.sharedConversationRail }
      : {}),
    ...(candidate.role === 'super_admin' || candidate.role === 'admin' || candidate.role === 'consumer'
      ? { role: candidate.role }
      : {}),
    ...(typeof candidate.addedAdminsReadable === 'boolean'
      ? { addedAdminsReadable: candidate.addedAdminsReadable }
      : {}),
    ...(candidate.session && typeof candidate.session === 'object'
      ? { session: candidate.session as Identity['session'] }
      : {}),
  };
}

/** Seed every ready-shell identity consumer from the verified startup read. */
export function rememberResolvedIdentity(identity: Identity): Identity {
  resolvedIdentity = identity;
  return identity;
}

/**
 * Who the app believes is signed in, per `GET /api/identity`.
 *
 * Three outcomes and all three are reported: an answer, a refusal, and a read
 * that never landed. The last two say the same thing to a reader -- the app does
 * not know who this is -- so they share `IDENTITY_UNAVAILABLE`, which every
 * consumer already recognises as "no name" rather than treating as one.
 */
export function useIdentity(deadlineMs = IDENTITY_DEADLINE_MS) {
  const [identity, setIdentity] = useState<Identity>(
    () =>
      resolvedIdentity ?? {
        // Both placeholders are named in user-initials.ts, which has to recognise
        // them: they are sentences, and an avatar built from one reads "RS".
        signedInAs: IDENTITY_RESOLVING,
        executionMode: 'service-principal',
      }
  );
  useEffect(() => {
    if (resolvedIdentity) return;
    let settled = false;
    // Only ever moves a read that is STILL resolving. An answer that lands after
    // the deadline is still the truth and still replaces this, and the timer
    // must not overwrite an answer that beat it.
    const giveUp = setTimeout(() => {
      if (settled) return;
      settled = true;
      setIdentity(identityAfterDeadline);
    }, deadlineMs);
    identityRequest()
      .then((next) => {
        settled = true;
        setIdentity(identityFromResponse(next));
      })
      .catch(() => {
        settled = true;
        setIdentity((current) => ({ ...current, signedInAs: IDENTITY_UNAVAILABLE }));
      });
    return () => clearTimeout(giveUp);
  }, [deadlineMs]);
  return identity;
}

/** When the app version serving this page was deployed, and what it was built from. */
export interface DeploymentStamp {
  /** The active deployment's creation time, ISO, or '' where nothing answered. */
  deployedAt: string;
  /** The active deployment's creator, exactly as the Apps API reported it. */
  deployedBy: string;
  /** The app build's commit, or '' where the deploy tree carries no stamp. */
  buildSha: string;
}

/**
 * When the app version serving this page was deployed, and which commit it is.
 *
 * Read independently of identity so an unavailable Apps API never delays the
 * login gate. The endpoint uses the same Apps API reader as Connections, and
 * an absent answer leaves the header quiet rather than inventing a timestamp.
 *
 * BOTH FIELDS MAY BE EMPTY AND EITHER MAY BE EMPTY ALONE. A workspace that does
 * not report a deployment time still knows which commit it is running, and a
 * deploy tree built without a git stamp still has a time. The header's chip
 * treats the commit as the optional half, so an unstamped build shows the date
 * and its time and says nothing about a commit it cannot name.
 */
export function useDeployment(): DeploymentStamp {
  const [stamp, setStamp] = useState<DeploymentStamp>({ deployedAt: '', deployedBy: '', buildSha: '' });
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/deployment', { signal: controller.signal })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ deployedAt?: unknown; deployedBy?: unknown; buildSha?: unknown }>)
          : Promise.reject(new Error('Deployment time unavailable'))
      )
      .then((body) => {
        setStamp({
          deployedAt: typeof body.deployedAt === 'string' ? body.deployedAt : '',
          deployedBy: typeof body.deployedBy === 'string' ? body.deployedBy : '',
          buildSha: typeof body.buildSha === 'string' ? body.buildSha : '',
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return stamp;
}

/**
 * Whether the numbers on screen are stored records or seeded ones.
 *
 * ONLY WHILE SOMEBODY IS LOOKING. The banner this feeds is drawn on every page
 * in the app, so this interval used to run in every open tab whether or not it
 * was the one in front -- a tab left open overnight asked the store about its own
 * health roughly four thousand times to tell nobody anything. It now pauses when
 * the tab is hidden and reads once, immediately, when it comes back, so a reader
 * returning to the tab is never looking at a stale outage.
 *
 * The pausing itself is in `visibility-polling.ts` rather than here, because a
 * timer inside an effect is not something this suite can observe: there is no
 * jsdom, so effects never run and there is no tab to hide. See that file.
 */
export function useStorageHealth(intervalMs = 20_000) {
  const [health, setHealth] = useState<StorageHealth | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void fetch('/api/storage')
        // 503 is the expected answer during an outage and still carries the body.
        .then((response) => response.json() as Promise<StorageHealth>)
        .then((next) => void (cancelled || setHealth(next)))
        .catch(() => undefined);
    const stop = pollWhileVisible(read, intervalMs, browserPollHost());
    return () => {
      cancelled = true;
      stop();
    };
  }, [intervalMs]);
  return health;
}

export type RunTraceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: RunTrace }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export interface LoadedRunTrace {
  runId: string;
  state: RunTraceState;
}

/**
 * A response is visible only under the id that produced it.
 *
 * Kept outside the hook so the stale-response boundary can be tested without a
 * browser renderer: after back/forward or a fast row change, the old detail is
 * loading state for the new run, never content under the wrong heading.
 */
export function visibleRunTraceState(runId: string | undefined, loaded: LoadedRunTrace | null): RunTraceState {
  if (!runId) return { status: 'idle' };
  return loaded?.runId === runId ? loaded.state : { status: 'loading' };
}

/** Normalize legacy stored stages at the Run Explorer read boundary. */
export function normalizeRunTrace(trace: RunTrace): RunTrace {
  if (!trace.trace) return trace;
  return {
    ...trace,
    trace: {
      ...trace.trace,
      stages: trace.trace.stages.map(normalizeStage),
    },
  };
}

/**
 * The selected run's own trace, refetched whenever the selection changes.
 *
 * A superseded request is aborted rather than allowed to land late, because one
 * run's stages appearing under another run's heading is the same defect this
 * whole endpoint exists to remove, just arrived at by a different route.
 */
/**
 * `refreshToken` re-reads the same run. A benchmark suite runs asynchronously for
 * several minutes, so its trace has to be polled to see it finish; changing the
 * token is how a caller asks for that without pretending the run id changed.
 */
export function useRunTrace(runId: string | undefined, refreshToken = 0): RunTraceState {
  // Keyed by the run it was fetched for, so a result can only ever be shown
  // under the run it belongs to, including on the render between a new
  // selection and its fetch, which is otherwise a frame of the previous run.
  const [loaded, setLoaded] = useState<LoadedRunTrace | null>(null);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    const settle = (state: RunTraceState) => {
      if (!controller.signal.aborted) setLoaded({ runId, state });
    };
    fetch(`/api/runs/${encodeURIComponent(runId)}/trace`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          settle({ status: 'missing' });
          return;
        }
        if (!response.ok) throw new Error('This run’s trace could not be read.');
        settle({ status: 'ready', data: normalizeRunTrace((await response.json()) as RunTrace) });
      })
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        settle({ status: 'error', message: error.message });
      });
    return () => controller.abort();
  }, [runId, refreshToken]);
  // A poll must not blank the pane it is refreshing, so a result already held for
  // this run stays on screen while the next read is in flight.
  return visibleRunTraceState(runId, loaded);
}
