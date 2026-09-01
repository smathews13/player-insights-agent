/**
 * What the ask route does with the ledger, and how much of it is in force.
 *
 * Split from `run-ledger.ts` so the decision, which is the part with
 * consequences for a user, can be read and tested without the SQL. The ledger
 * knows how to store a run; this knows whether a request may start one, attach
 * to one, or be refused.
 *
 * ROLLING THIS OUT IS PART OF THE DESIGN, not an afterthought. The plan is
 * explicit that the ledger runs in dual-write shadow mode first, is compared
 * against the existing runs and traces, and only then begins to change what
 * callers get. A switch that only exists once something has already gone wrong
 * in production is a switch nobody has tested, so it is here from the start and
 * every mode is covered.
 */

import {
  canonicalRequestHash,
  idempotencyKeyHash,
  isUsableIdempotencyKey,
  type CanonicalRequest,
} from './run-request-hash';
import {
  acquireLease,
  completeAttempt,
  createOrGetRun,
  idempotencyConflict,
  recordAttempt,
  transition,
  type LedgerRun,
} from './run-ledger';
import type { LakebaseReader } from './lakebase-store';
import { isTerminal, shortestPath, type TerminalRunState } from './run-state';
import { messageOf, statusOf, type FailureCode } from './run-failure-codes';

/**
 * The environment variable that decides how much authority the ledger has.
 *
 * BEFORE YOU SET THIS TO `enforce`, three things must be true. Each of them is
 * a real failure that enforce turns on and shadow does not, and each will look
 * like a bug somewhere other than here.
 *
 *  1. PLAN APPROVAL MUST RESUME BY PLAN FINGERPRINT. An approval carries
 *     `approvedPlanId`, so it is a different canonical request from the
 *     question that produced the plan. Today it therefore starts a new run,
 *     which is harmless, UNLESS the client reused its `Idempotency-Key`, in
 *     which case enforce refuses it as a conflict. The reader sees an approved
 *     plan rejected and reports it as a bug in approvals. `plan_fingerprint` is
 *     stored for this and nothing reads it yet.
 *  2. THE LEDGER MUST HAVE BEEN COMPARED AGAINST THE TRACES over at least one
 *     real demo, in shadow. A duplicate-execution guard that misfires during a
 *     customer demo is worse than the duplicate execution it prevents.
 *  3. THE MIGRATIONS MUST HAVE APPLIED on the target. They are refused rather
 *     than failed when the app's Postgres role does not own the schema, which
 *     leaves the boot healthy and every ask unable to record a run. In shadow
 *     that is a warning per request; in enforce it is a 503 per request.
 */
export const RUN_LEDGER_MODE_ENV = 'PIA_RUN_LEDGER';

/**
 * How much authority the ledger has over a request.
 *
 *  - `off`: nothing is written. For a deployment where the migrations were
 *    refused, so the app is not writing failures into its own log on every ask.
 *  - `shadow`: the run is recorded and its outcome written, and NOTHING about
 *    the response changes. This is what dual-write means, and it is the default
 *    because it is the only mode whose blast radius on the live demo is zero.
 *  - `enforce`: duplicates attach instead of executing, and a reused key with
 *    different content is refused.
 */
export type RunLedgerMode = 'off' | 'shadow' | 'enforce';

/**
 * Reads the mode, defaulting to shadow.
 *
 * An unrecognised value is shadow rather than enforce, and that direction is
 * chosen rather than defaulted into: a typo in a bundle variable must not be
 * the thing that starts refusing customer requests.
 */
export function resolveRunLedgerMode(value: string | undefined): RunLedgerMode {
  const normalised = (value ?? '').trim().toLowerCase();
  if (normalised === 'off' || normalised === 'false' || normalised === '0') return 'off';
  if (normalised === 'enforce') return 'enforce';
  if (normalised !== '' && normalised !== 'shadow') {
    console.warn(
      `[run-ledger] ${RUN_LEDGER_MODE_ENV}="${value}" is not one of off, shadow, enforce. Running in ` +
        `shadow, which records runs and changes no response.`
    );
  }
  return 'shadow';
}

/**
 * What the route should do next.
 *
 * `proceed` carries the run and fence when there is one, and carries neither
 * when the ledger is off or shadow could not record the run. Shadow mode never
 * produces a `refuse`: that is the whole point of it.
 *
 * `status` is carried rather than left to the caller, and every refusal below
 * fills it with `statusOf(code)` and nothing else. It is not a second opinion
 * about what the code means: a status chosen beside a code is a status that can
 * disagree with it, and a caller reading 400 next to a code that declares 409
 * has no way to tell which of the two is the lie.
 */
export type Admission =
  | { kind: 'proceed'; run: LedgerRun | null; fencingToken: number | null; mode: RunLedgerMode }
  | { kind: 'refuse'; code: FailureCode; status: number; detail: string; runId: string | null }
  | { kind: 'replay'; run: LedgerRun };

export interface AdmissionInput {
  mode: RunLedgerMode;
  runId: string;
  turnId: string;
  /** The raw header, or empty. Never stored; only its hash is. */
  idempotencyKey: string;
  request: CanonicalRequest;
  identityModeRequested: string;
  /** Persona snapshot chosen for this request; absent means OAuth/no persona. */
  persona?: { id: string; displayName: string } | null;
  releaseIdentity: Record<string, unknown>;
  /** The id every other record of this question carries. See `shared/correlation.ts`. */
  correlationId: string;
  /** How long this run has, from now. */
  budgetMs: number;
  /** Names this process in the lease, so a stuck run points at a container. */
  executor: string;
}

/**
 * Decide whether this request may run, and record it if so.
 *
 * The order matters. The run is created AFTER the owned conversation and
 * attachment context has been loaded, because that context is in the hash, and
 * BEFORE Model Serving is invoked, because a run created afterwards could not
 * prevent the duplicate it exists to prevent.
 */
export async function admitRun(store: LakebaseReader, input: AdmissionInput): Promise<Admission> {
  if (input.mode === 'off') return { kind: 'proceed', run: null, fencingToken: null, mode: input.mode };

  const key = input.idempotencyKey.trim();
  if (key !== '' && !isUsableIdempotencyKey(key)) {
    // Refused rather than ignored, and in shadow too, because this one is
    // about the CALLER's belief rather than about ours. A client that thinks
    // it sent an idempotency key and did not believes it is protected from
    // duplicate execution while it is not, and the only moment we can tell it
    // otherwise is now.
    //
    // Not IDEMPOTENCY_CONFLICT, which this used to say under a local constant
    // while answering 400. Nothing conflicted: there is no earlier request
    // here, and the remedy is a well-formed header rather than a different one.
    // The sentence is the taxonomy's now, because the sentence and the status
    // have to move together.
    return {
      kind: 'refuse',
      code: 'IDEMPOTENCY_KEY_MALFORMED',
      status: statusOf('IDEMPOTENCY_KEY_MALFORMED'),
      detail: messageOf('IDEMPOTENCY_KEY_MALFORMED'),
      runId: null,
    };
  }

  const requestHash = canonicalRequestHash(input.request);
  const created = await createOrGetRun(store, {
    runId: input.runId,
    userEmail: input.request.userEmail,
    conversationId: input.request.conversationId,
    turnId: input.turnId,
    requestHash,
    idempotencyKeyHash: key === '' ? null : idempotencyKeyHash(input.request.userEmail, key),
    deadlineAt: new Date(Date.now() + input.budgetMs),
    identityModeRequested: input.identityModeRequested,
    personaId: input.persona?.id ?? null,
    personaName: input.persona?.displayName ?? null,
    releaseIdentity: input.releaseIdentity,
    correlationId: input.correlationId,
  });

  if (!created.ok) {
    if (input.mode === 'shadow') {
      // Shadow mode may not refuse a request the app would otherwise have
      // answered. The whole reason to run this way first is to find out what
      // the ledger WOULD have done without anybody's question failing because
      // of it.
      console.warn(
        `[run-ledger] shadow: the run for this request could not be recorded (${created.detail}). The ` +
          `question is being answered anyway. In enforce mode it would have been refused.`
      );
      return { kind: 'proceed', run: null, fencingToken: null, mode: input.mode };
    }
    return {
      kind: 'refuse',
      code: 'PERSISTENCE_UNAVAILABLE',
      status: statusOf('PERSISTENCE_UNAVAILABLE'),
      detail: created.detail,
      runId: null,
    };
  }

  const { run, created: isNew } = created.value;

  if (!isNew && input.mode === 'enforce') {
    if (idempotencyConflict(run, requestHash)) {
      return {
        kind: 'refuse',
        code: 'IDEMPOTENCY_CONFLICT',
        status: statusOf('IDEMPOTENCY_CONFLICT'),
        detail:
          'This Idempotency-Key was already used for a different question. Returning the earlier ' +
          'answer would answer a question you are no longer asking, so nothing was run. Use a new ' +
          'key for a new question.',
        runId: run.runId,
      };
    }
    if (isTerminal(run.state)) return { kind: 'replay', run };
  }

  // A new run and a found one are both leased from here, because the run this
  // request found may have been abandoned by an executor that died, and the
  // lease is the only thing that can tell that from one still working.
  const leased = await acquireLease(store, run.runId, input.executor, ['RECEIVED', 'AWAITING_APPROVAL']);
  if (!leased.ok) {
    if (input.mode === 'shadow') {
      console.warn(
        `[run-ledger] shadow: run ${run.runId} is already owned (${leased.detail}). In enforce mode this ` +
          `request would have attached to it instead of invoking the agent.`
      );
      return { kind: 'proceed', run, fencingToken: null, mode: input.mode };
    }
    return {
      kind: 'refuse',
      code: 'STREAM_INTERRUPTED',
      status: statusOf('STREAM_INTERRUPTED'),
      detail:
        'This question is already running. Reconnect to it rather than asking again; asking again ' +
        'would run the same model and data work a second time.',
      runId: run.runId,
    };
  }

  await recordAttempt(store, {
    attemptId: `attempt-${input.runId}-${leased.value.fencingToken}`,
    runId: run.runId,
    fencingToken: leased.value.fencingToken,
    executor: input.executor,
  });

  return { kind: 'proceed', run: leased.value, fencingToken: leased.value.fencingToken, mode: input.mode };
}

/**
 * Close a run out knowing only how it ended.
 *
 * The route is the caller, and the route does not know where the agent was when
 * the turn ended: Model Serving reports stages rather than state changes, and a
 * turn answered in one JSON body reports nothing until it is done. So the
 * intermediate states are walked rather than observed, and the timestamps on
 * them say only that the run passed through, not when. That is a real
 * limitation and it is recorded here rather than papered over by letting
 * RECEIVED go straight to SUCCEEDED: the guarantee that an answer passed
 * through synthesis is worth more than precise intermediate timings, and
 * mapping stage events onto states is the obvious next improvement.
 */
export async function settleRun(
  store: LakebaseReader,
  admission: Admission,
  outcome: { to: TerminalRunState; code?: FailureCode | null; traceId?: string; messageId?: string }
): Promise<void> {
  if (admission.kind !== 'proceed' || !admission.run || admission.fencingToken === null) return;

  const path = shortestPath(admission.run.state, outcome.to);
  if (path === null) {
    console.error(
      `[run-ledger] Run ${admission.run.runId} is in ${admission.run.state} and cannot reach ` +
        `${outcome.to}. Nothing was written, because a run that has already answered must not be ` +
        `re-marked by a late write.`
    );
    return;
  }

  let from = admission.run.state;
  for (const next of path) {
    const last = next === outcome.to;
    const moved = await transition(store, {
      runId: admission.run.runId,
      from,
      to: next,
      fencingToken: admission.fencingToken,
      code: last ? (outcome.code ?? null) : null,
      traceId: last ? outcome.traceId : undefined,
      terminalMessageId: last ? outcome.messageId : undefined,
    });
    if (!moved.ok) {
      console.error(
        `[run-ledger] Run ${admission.run.runId} could not be moved from ${from} to ${next}: ` +
          `${moved.detail}. It now has no durable terminal state, which is the condition worth ` +
          `alerting on: the answer was returned to the reader and the ledger cannot say so.`
      );
      return;
    }
    from = next;
  }

  await completeAttempt(store, {
    runId: admission.run.runId,
    fencingToken: admission.fencingToken,
    outcome: outcome.to,
    failureCode: outcome.code ?? null,
  });
}

/**
 * Park a run that has produced a plan and is now waiting on a person.
 *
 * Not a terminal state and not an abandoned one, which is the distinction the
 * lease cannot make on its own: a run nobody is executing looks identical to a
 * run whose container died. Parking it releases the lease deliberately, so the
 * approval that arrives two seconds later is the same run picked up again
 * rather than a duplicate refused for being in flight.
 */
export async function parkRun(store: LakebaseReader, admission: Admission, planFingerprint: string): Promise<void> {
  if (admission.kind !== 'proceed' || !admission.run || admission.fencingToken === null) return;

  const path = shortestPath(admission.run.state, 'AWAITING_APPROVAL');
  if (path === null) return;

  let from = admission.run.state;
  for (const next of path) {
    const moved = await transition(store, {
      runId: admission.run.runId,
      from,
      to: next,
      fencingToken: admission.fencingToken,
      planFingerprint: next === 'AWAITING_APPROVAL' ? planFingerprint : undefined,
    });
    if (!moved.ok) {
      console.warn(
        `[run-ledger] Run ${admission.run.runId} could not be parked at ${next}: ${moved.detail}. The ` +
          `plan was still returned; the approval that follows will not find a run to resume.`
      );
      return;
    }
    from = next;
  }
}

/**
 * Which process holds a run, in a form somebody can act on.
 *
 * A lease naming nothing is a lease that cannot be chased. Apps run more than
 * one container, so a run stuck in RUNNING has to point at the one holding it,
 * and the pid distinguishes two workers in the same container. Not stable
 * across a restart, deliberately: a restarted process is not the executor that
 * took the lease, and it must not look like one.
 */
export function executorName(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
  return `${env.HOSTNAME || env.DATABRICKS_APP_NAME || 'app'}:${pid}`;
}

/**
 * What this release is and what it will be billed as, as far as the app can tell.
 *
 * Deliberately thin and deliberately honest. The plan wants app build SHA,
 * model version, prompt version, manifest digest, validator version and more
 * attached to every run. Those are the output of the release certification
 * workstream, which is defining the release tuple now, and the space for them
 * is RESERVED here rather than filled: two competing notions of what identifies
 * a release would be worse than one incomplete one. So do not add a definition
 * of `model_version`, `prompt_version` or `manifest_digest` to this function.
 * They arrive from the certificate, and this function will read them.
 *
 * ── THE COST IDENTIFIERS, AND WHY THEY ARE HERE ──
 *
 * A run's cost is not in this app's database and never will be: it lands in
 * `system.billing.usage` hours later, keyed by the resource that did the work.
 * So the record of a run has to carry the KEYS rather than an amount, and those
 * keys are exactly the ones the Ops cost page already uses (see `CostIdentifiers`
 * in `ops-billing.ts`): the app, the serving endpoint, the warehouse, the
 * workspace. Written under the same names, because two vocabularies for the same
 * four resources is how a join comes out empty and looks like a billing gap.
 *
 * Every field is omitted when unset rather than written empty. An absent field is
 * better than an invented one: this ends up in an audit trail, and `''` in a
 * `warehouse_id` reads as a warehouse whose id is the empty string.
 */
export function releaseIdentity(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  const put = (key: string, value: string | undefined): void => {
    const trimmed = (value ?? '').trim();
    if (trimmed) identity[key] = trimmed;
  };

  // ── What ran ──
  put('app_build_sha', env.PIA_APP_BUILD_SHA ?? env.DATABRICKS_APP_BUILD_SHA);
  // The certified release this build was published as, when the release step set
  // one. Distinct from the build SHA: one release can be redeployed unchanged,
  // and "which release was this" is the question a certificate answers.
  put('release_id', env.PIA_RELEASE_ID);

  // ── Where it ran ──
  put('app_name', env.DATABRICKS_APP_NAME);
  put('workspace_id', env.DATABRICKS_WORKSPACE_ID);
  // The bundle target ("example", "customer"): which deployment of the app this is,
  // which is not derivable from the app name alone once two targets share one.
  put('deployment', env.PIA_BUNDLE_TARGET ?? env.DATABRICKS_BUNDLE_TARGET);

  // ── What it will be billed as ──
  put('serving_endpoint', env.DATABRICKS_SERVING_ENDPOINT_NAME);
  put('warehouse_id', env.DATABRICKS_SQL_WAREHOUSE_ID);

  return identity;
}
