/**
 * The states one question can be in, and which changes between them are legal.
 *
 * Pure. No database, no clock, no randomness. Everything else in the run ledger
 * is built on this, and a transition matrix that is wrong in one cell is a
 * defect nobody finds by reading a query: it shows up as two executors on one
 * run, or as a run that is answered and then quietly reopened. So it lives
 * here, on its own, where it can be exhaustively tested against its own
 * invariants rather than against whatever paths the ask route happens to take
 * today.
 *
 * The thing this replaces is not another state machine. It is the absence of
 * one: a truncated stream currently causes one blocking retry of the same
 * question, and nothing durable records that the first attempt existed, so the
 * model and its tools can run twice for one question and the second answer wins
 * by arriving second.
 */

import { FAILURE_CODES, layerOf, type FailureCode, type FailureLayer } from './run-failure-codes';

/**
 * Every state, in the order a healthy run passes through them, terminals last.
 *
 * The names are the plan's, unchanged, including the ones that read oddly next
 * to this codebase's vocabulary (`REFUSED` rather than `refusal`). They are
 * quoted in the customer-facing document and will be quoted back at us in a
 * review, and a rename that is only a matter of taste is not worth the pair of
 * meanings it creates while half the code has moved.
 */
export const RUN_STATES = [
  'RECEIVED',
  'PLANNING',
  'AWAITING_APPROVAL',
  'RUNNING',
  'SYNTHESIZING',
  'SUCCEEDED',
  'CLARIFICATION_REQUIRED',
  'REFUSED',
  'FAILED',
  'DEADLINE_EXCEEDED',
  'CANCELLED',
  'PERSISTENCE_FAILED',
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * States a run never leaves.
 *
 * Terminality is declared rather than derived from the transition table being
 * empty, so that an accidentally emptied row is a test failure instead of a
 * silent new terminal state. `TRANSITIONS` is then checked against this list
 * rather than the other way round.
 */
export const TERMINAL_STATES = [
  'SUCCEEDED',
  'CLARIFICATION_REQUIRED',
  'REFUSED',
  'FAILED',
  'DEADLINE_EXCEEDED',
  'CANCELLED',
  'PERSISTENCE_FAILED',
] as const satisfies readonly RunState[];

export type TerminalRunState = (typeof TERMINAL_STATES)[number];

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: RunState): state is TerminalRunState {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}

/**
 * The states in which somebody is, or should be, actively working on the run.
 *
 * Narrower than "not terminal", and the gap is AWAITING_APPROVAL. A run waiting
 * on a person is not consuming anything and may wait as long as the person
 * takes, so it is not evidence that a second request for the same question
 * would duplicate work. Everything else in this list is an executor that either
 * holds the lease or has died holding it.
 *
 * Read by the partial unique index in `run-ledger-schema.ts`, which is what
 * stops a hundred concurrent identical requests becoming a hundred runs, and
 * by the lease sweep. Declared here so those two cannot come to disagree with
 * the state machine about what "in flight" means.
 */
export const EXECUTING_STATES = [
  'RECEIVED',
  'PLANNING',
  'RUNNING',
  'SYNTHESIZING',
] as const satisfies readonly RunState[];

export type ExecutingRunState = (typeof EXECUTING_STATES)[number];

export function isExecuting(state: RunState): state is ExecutingRunState {
  return (EXECUTING_STATES as readonly RunState[]).includes(state);
}

/**
 * Where each state may go next.
 *
 * Three rules decide this table, and each of them is a bug we would otherwise
 * have to find at runtime:
 *
 *  - No state lists itself. A repeated transition is how a lost update or a
 *    second executor looks from the database, and accepting it as a no-op is
 *    what makes duplicate execution invisible. The fenced update in the ledger
 *    matches on the state it expects to leave, so a self-transition would
 *    always succeed and never tell anybody.
 *  - Every non-terminal state can reach every terminal failure that can happen
 *    while it is current. A deadline can expire during planning, during a tool
 *    call, and during synthesis, and a matrix that only allowed it from
 *    RUNNING would force the coordinator to lie about where the run was in
 *    order to record the truth about how it ended.
 *  - Nothing leaves a terminal state, including into another terminal state.
 *    A run that has answered and is then marked FAILED because a late write
 *    threw is a run whose ledger disagrees with what the user was shown.
 */
export const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  // Created, no executor yet. It can fail here: the lease may never be taken,
  // the deadline may already have passed on a queued request, and the caller
  // may cancel before anything starts.
  RECEIVED: ['PLANNING', 'FAILED', 'DEADLINE_EXCEEDED', 'CANCELLED', 'PERSISTENCE_FAILED', 'REFUSED'],
  // Planning ends in a plan to approve, in a question back to the user, or, for
  // a turn that needs no approval, straight into execution.
  PLANNING: [
    'AWAITING_APPROVAL',
    'RUNNING',
    'CLARIFICATION_REQUIRED',
    'REFUSED',
    'FAILED',
    'DEADLINE_EXCEEDED',
    'CANCELLED',
    'PERSISTENCE_FAILED',
  ],
  // Waiting on a person, which is the one state where the deadline is not the
  // agent's fault and the run may sit for a long time. It can return to
  // PLANNING because the agent is entitled to refuse a stale approval and
  // re-issue a plan, which is the existing `supersededApprovalId` path.
  AWAITING_APPROVAL: [
    'RUNNING',
    'PLANNING',
    'REFUSED',
    'FAILED',
    'DEADLINE_EXCEEDED',
    'CANCELLED',
    'PERSISTENCE_FAILED',
  ],
  // Tools are executing. A clarification is still reachable: the agent can
  // discover mid-run that the question was ambiguous.
  RUNNING: [
    'SYNTHESIZING',
    'CLARIFICATION_REQUIRED',
    'REFUSED',
    'FAILED',
    'DEADLINE_EXCEEDED',
    'CANCELLED',
    'PERSISTENCE_FAILED',
  ],
  // Assembling the typed answer from evidence already accepted. REFUSED is
  // reachable and load-bearing: this is where a run with no valid evidence
  // stops rather than narrating around the gap.
  SYNTHESIZING: ['SUCCEEDED', 'REFUSED', 'FAILED', 'DEADLINE_EXCEEDED', 'CANCELLED', 'PERSISTENCE_FAILED'],
  SUCCEEDED: [],
  CLARIFICATION_REQUIRED: [],
  REFUSED: [],
  FAILED: [],
  DEADLINE_EXCEEDED: [],
  CANCELLED: [],
  PERSISTENCE_FAILED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Why a transition was refused, in words that name both states.
 *
 * Returned rather than thrown so the caller decides whether this is a
 * programming error or an ordinary race with another executor, which are the
 * two ways to arrive here and want opposite handling. Null means the
 * transition is legal.
 */
export function transitionRefusal(from: RunState, to: RunState): string | null {
  if (canTransition(from, to)) return null;
  if (isTerminal(from)) {
    return (
      `A run in ${from} has finished and cannot move to ${to}. Something is still writing to a run ` +
      `that has already answered, which usually means a stale executor whose fencing token was ` +
      `not checked.`
    );
  }
  if (from === to) {
    return (
      `A run cannot transition from ${from} to itself. A repeated transition is what a lost ` +
      `update or a second executor looks like, so it is refused rather than treated as a no-op.`
    );
  }
  return `A run in ${from} cannot move to ${to}.`;
}

/**
 * The states a run must pass through to get from one state to another.
 *
 * Exists because the route knows how a turn ENDED long before it knows, or can
 * know, where the agent was when each thing happened. Model Serving reports
 * stages, not state changes, and a turn answered in one JSON body reports
 * nothing at all until it is finished. Given only "this ended as SUCCEEDED",
 * the alternatives were to let the ledger accept RECEIVED straight to
 * SUCCEEDED, which throws away the guarantee that an answer passed through
 * synthesis, or to have every caller hardcode the path, which puts the matrix
 * in two places.
 *
 * Breadth-first, so the path is the shortest one and no state is entered that
 * the run could have skipped. Returns null when the target is unreachable,
 * which is a real answer: nothing leaves a terminal state.
 */
export function shortestPath(from: RunState, to: RunState): RunState[] | null {
  if (from === to) return [];
  const queue: RunState[][] = [[from]];
  const seen = new Set<RunState>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as RunState[];
    const tail = path[path.length - 1];
    for (const next of TRANSITIONS[tail]) {
      if (seen.has(next)) continue;
      if (next === to) return [...path.slice(1), next];
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

/**
 * Whether a response carrying this state may contain an answer.
 *
 * The plan states it as one line ("Only SUCCEEDED may contain an answer") and
 * it is the single property this whole workstream is judged on, so it is a
 * function rather than a convention: a failed, cancelled or expired run with a
 * takeaway on it is the fabrication the app has spent months removing.
 */
export function mayCarryAnswer(state: RunState): boolean {
  return state === 'SUCCEEDED';
}

/**
 * Which terminal state a run ends in, decided by the LAYER of the code that
 * stopped it rather than by the code itself.
 *
 * Keyed on the layer on purpose. The taxonomy is being written alongside this
 * file by another workstream and gains codes as the evidence gateway and the
 * release gate land; a table keyed on codes would have to be edited for each
 * one, would be edited late, and a code missing from it is a run that cannot
 * record how it ended. Keyed on the layer, a new code inherits a terminal
 * state from the layer it was filed under, and only a new LAYER, which is a
 * genuinely new kind of failure, needs a decision here. `Record` makes that
 * decision a compile error rather than a default.
 *
 * The split itself is the plan's: a governance or authorization outcome is a
 * REFUSED, an operational one is a FAILED, and the two must not be conflated,
 * because a denial filed as a failure is read as an outage, alerts as one, and
 * invites the retry that would ask the same question under a more privileged
 * identity.
 */
export const TERMINAL_STATE_BY_LAYER: Record<FailureLayer, TerminalRunState> = {
  // The reader, or a rule this system enforces on itself, stopped the work.
  // Nothing broke.
  identity: 'REFUSED',
  authorization: 'REFUSED',
  governance: 'REFUSED',
  evidence: 'REFUSED',
  release: 'REFUSED',
  // The decision this Record was designed to force. `request` arrived with
  // IDEMPOTENCY_CONFLICT, and a duplicate key refused is not an outage: the
  // guard worked, nothing downstream was reached, and FAILED would put it in
  // front of an operator as something to fix here rather than in the caller.
  request: 'REFUSED',
  // Something broke. `contract` is here rather than with the refusals because
  // a shape disagreement between two of our own parts is our defect, usually a
  // half-deployed release, and calling it a refusal would put the blame on the
  // reader in the one case where it is certainly ours.
  dependency: 'FAILED',
  transport: 'FAILED',
  contract: 'FAILED',
  deadline: 'DEADLINE_EXCEEDED',
  persistence: 'PERSISTENCE_FAILED',
};

/**
 * Which failure codes are admissible in each terminal state.
 *
 * Derived from the layer map above rather than written out, so the two cannot
 * disagree. Not a one-to-one map, deliberately: `REFUSED` covers every
 * governance and authorization outcome, and flattening those to a single code
 * would undo the distinction the taxonomy exists to hold, since a reader
 * refused by a column policy and a reader refused by a missing grant are told
 * different things and alert differently. So the state constrains the code and
 * the ledger stores the code, rather than the state standing in for it.
 *
 * The states with no codes are the ones where a failure code would be a
 * contradiction. A cancelled run did not fail, it was stopped.
 */
function terminalCodes(): Record<TerminalRunState, readonly FailureCode[]> {
  const table = {} as Record<TerminalRunState, readonly FailureCode[]>;
  for (const state of TERMINAL_STATES) {
    table[state] = FAILURE_CODES.filter((code) => TERMINAL_STATE_BY_LAYER[layerOf(code)] === state);
  }
  return table;
}

export const TERMINAL_CODES: Record<TerminalRunState, readonly FailureCode[]> = terminalCodes();

/**
 * Whether a terminal state and a failure code agree with each other.
 *
 * Both directions matter and they fail differently. A code outside the state's
 * list means the two records of one event disagree, which is the thing the Run
 * Explorer would render as a contradiction. A missing code on a state that
 * requires one means an operator opens the run and finds "FAILED" with nothing
 * to act on, which is how the current logs read.
 */
export function terminalRefusal(state: TerminalRunState, code: FailureCode | null): string | null {
  const allowed = TERMINAL_CODES[state];
  if (allowed.length === 0) {
    return code === null ? null : `A run in ${state} did not fail, so it cannot carry the failure code ${code}.`;
  }
  if (code === null) {
    return `A run in ${state} must carry a failure code, and this one carries none.`;
  }
  if (!allowed.includes(code)) {
    return (
      `${code} is a ${layerOf(code)}-layer failure, so a run carrying it ends in ` +
      `${TERMINAL_STATE_BY_LAYER[layerOf(code)]} rather than in ${state}.`
    );
  }
  return null;
}

/** The state a run ends in when this code is what stopped it. */
export function terminalStateFor(code: FailureCode): TerminalRunState {
  return TERMINAL_STATE_BY_LAYER[layerOf(code)];
}

/**
 * Whether a fresh attempt may take over a run found in this state.
 *
 * The question the coordinator asks when a request arrives for a run that
 * already exists, and it is not the same question as "is this state
 * non-terminal". A run in RECEIVED has done nothing worth preserving and can
 * simply be picked up. A run in AWAITING_APPROVAL is waiting on a person and
 * resumes when they answer. A run that is mid-flight belongs to whoever holds
 * its lease, and the only thing that may take it over is lease expiry, which
 * is a decision about time and therefore not made here.
 *
 * Terminal states answer false, which is the property that makes a reconnect
 * cheap: the answer is already durable and there is nothing to run again.
 */
export function resumableWithoutLease(state: RunState): boolean {
  return state === 'RECEIVED' || state === 'AWAITING_APPROVAL';
}
