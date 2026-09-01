/**
 * The durable record of one question, and the only thing allowed to say who is
 * executing it.
 *
 * NO TRANSACTIONS ARE AVAILABLE HERE, and everything below is shaped by that.
 * AppKit hands this app a `pg.Pool` behind a bare `query(text, params)`; there
 * is no way to hold one connection across two calls, so `BEGIN` on one call and
 * `COMMIT` on the next would run on different connections and silently do
 * nothing resembling a transaction. Rather than reach for a client this app
 * does not have, every operation here is ONE statement, made atomic by a
 * constraint or by a conditional UPDATE. Where that leaves a race, the race is
 * resolved by retrying and reading, not by locking. Each place this matters is
 * commented, because "why is this a CTE" is the question a reader will have.
 *
 * The failure this exists to prevent is concrete. A truncated SSE response
 * currently causes one blocking retry of the same question, and nothing durable
 * records that the first attempt happened, so the model and its tools can run
 * twice and the second answer wins by arriving second. With a ledger, the
 * second request finds the first run and attaches to it.
 */

import { APP_SCHEMA } from '../../shared/app-schema';
import type { LakebaseReader } from './lakebase-store';
import { EXECUTING_STATES, isTerminal, terminalRefusal, transitionRefusal, type RunState } from './run-state';
import type { FailureCode } from './run-failure-codes';

/**
 * The executing states as a SQL list.
 *
 * Rendered from the state machine rather than typed out, because this list has
 * to be the same one the partial unique index in `run-ledger-schema.ts` was
 * built with. If they diverge, the insert conflicts on a row this query then
 * cannot see, and `createOrGetRun` spins its retries and reports contention
 * that is not happening.
 */
const EXECUTING_SQL_LIST = EXECUTING_STATES.map((state) => `'${state}'`).join(',');

/** How long a lease is good for without a heartbeat. */
export const LEASE_MS = 30_000;

/**
 * How many times an operation that races is reissued before it gives up.
 *
 * Small on purpose. The races below are all "somebody else got there first",
 * which resolves on the next read; a run that needs more than a few goes is not
 * contended, it is broken, and spinning on it turns one stuck run into load.
 */
const RACE_ATTEMPTS = 4;

/**
 * A failure worth one immediate retry, matched by SQLSTATE.
 *
 * A deliberately short version of the list in `lakebase-store.ts`, covering
 * only the connection failures where a second attempt takes a different pooled
 * connection and therefore a fresh credential. It must NOT include a unique
 * violation: those are how this file detects a duplicate, and retrying one
 * would turn a correct answer into a wasted round trip.
 */
const RETRYABLE_LEDGER_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '57P01', '57P03', '28P01']);

export interface LedgerRead {
  available: boolean;
  rows: Record<string, unknown>[];
  error: string;
  code: string;
}

/**
 * Every statement this file issues, and deliberately NOT through `readStored`.
 *
 * `readStored` maintains the global storage health that the banner, the Sources
 * page and `chooseRows` all read, and a failure recorded there makes every
 * degradable route serve representative data. That is right for a failed read
 * of `conversations`, and wrong here: the ledger's tables are new, and on a
 * database where their CREATE was refused on ownership these statements fail
 * while everything else is perfectly healthy. Reporting that as a store-wide
 * outage would take the whole app down to demo data because of a table nothing
 * had read yet, which is a far worse failure than the duplicate execution this
 * ledger exists to prevent.
 *
 * The trade is that a genuine Lakebase outage discovered here does not raise
 * the alarm on its own. It does not need to: every other read on the request
 * goes through `readStored` and will.
 */
export async function ledgerQuery(
  store: LakebaseReader,
  label: string,
  sql: string,
  params: unknown[]
): Promise<LedgerRead> {
  let last: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await store.lakebase.query(sql, params);
      return { available: true, rows: result.rows, error: '', code: '' };
    } catch (error) {
      last = error;
      const raw = (error as { code?: unknown }).code;
      const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
      if (attempt === 1 && RETRYABLE_LEDGER_CODES.has(code)) continue;
      break;
    }
  }
  const raw = (last as { code?: unknown })?.code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'none';
  const message = last instanceof Error ? last.message : String(last);
  console.error(
    `[run-ledger] ${label} failed (code ${code}): ${message}. The run this request belongs to has ` +
      `no durable record, so it must not be started: an answer nobody can look up afterwards is ` +
      `what the ledger exists to prevent.`
  );
  return { available: false, rows: [], error: message, code };
}

/**
 * The columns every read of a run returns, in one place so they cannot drift.
 *
 * `correlation_id` arrives in schema version 2, and naming it here means a read
 * fails on a database still at version 1. That window exists and is bounded: the
 * schema pass runs at boot, off the request path, and the ledger's default mode
 * is shadow, where a read that fails is a warning line and changes no answer. The
 * alternative — omitting it and reading it only from the operator's join — would
 * leave the app unable to state the id it had just written.
 */
const RUN_COLUMNS = `run_id, user_email, conversation_id, turn_id, request_hash, idempotency_key_hash,
  plan_fingerprint, state, deadline_at, identity_mode_requested, identity_mode_effective,
  identity_verified, persona_id, persona_name, terminal_code, terminal_message_id, trace_id, correlation_id, fencing_token,
  lease_owner, lease_expires_at, attempts, created_at, updated_at, completed_at`;

export interface LedgerRun {
  runId: string;
  userEmail: string;
  conversationId: string;
  turnId: string;
  requestHash: string;
  idempotencyKeyHash: string | null;
  planFingerprint: string | null;
  state: RunState;
  deadlineAt: string;
  identityModeRequested: string | null;
  identityModeEffective: string | null;
  identityVerified: boolean | null;
  personaId: string | null;
  personaName: string | null;
  terminalCode: FailureCode | null;
  terminalMessageId: string | null;
  traceId: string | null;
  /**
   * The id that joins this run to the app log, the model span, the Genie and
   * Vector Search calls and the MLflow trace. See `shared/correlation.ts`.
   *
   * Null for a run recorded before schema version 2, and for a caller that sent
   * no usable id — which is every caller that is not this app's own browser.
   */
  correlationId: string | null;
  fencingToken: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
}

/**
 * What every ledger call answers with.
 *
 * `unavailable` is a first-class outcome rather than a thrown error because it
 * is the one the ask route has to act on differently: the plan is explicit that
 * a Lakebase outage FAILS CLOSED BEFORE NEW WORK STARTS, since a run that
 * cannot be recorded produces an answer nobody can look up afterwards. An
 * exception would be caught by the route's existing catch, which answers with a
 * representative response, which is the exact opposite.
 */
export type LedgerResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unavailable'; detail: string }
  | { ok: false; reason: 'conflict'; detail: string }
  | { ok: false; reason: 'lost'; detail: string };

function unavailable<T>(read: LedgerRead): LedgerResult<T> {
  return { ok: false, reason: 'unavailable', detail: `${read.error} (code ${read.code})` };
}

function row(read: LedgerRead): Record<string, unknown> | null {
  return read.rows[0] ?? null;
}

/**
 * A nullable column as a string.
 *
 * `Date` is handled before the general case because node-postgres parses
 * `timestamptz` into a `Date`, and the default stringification of one is a
 * local-time sentence rather than an instant. Storing or comparing that against
 * a value written by another container in another region is the kind of bug
 * that only shows up in the deployment nobody tested.
 */
function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return JSON.stringify(value);
}

function toRun(record: Record<string, unknown>): LedgerRun {
  return {
    runId: String(record.run_id),
    userEmail: String(record.user_email),
    conversationId: String(record.conversation_id),
    turnId: String(record.turn_id),
    requestHash: String(record.request_hash),
    idempotencyKeyHash: text(record.idempotency_key_hash),
    planFingerprint: text(record.plan_fingerprint),
    state: String(record.state) as RunState,
    deadlineAt: String(record.deadline_at),
    identityModeRequested: text(record.identity_mode_requested),
    identityModeEffective: text(record.identity_mode_effective),
    identityVerified:
      record.identity_verified === null || record.identity_verified === undefined
        ? null
        : Boolean(record.identity_verified),
    personaId: text(record.persona_id),
    personaName: text(record.persona_name),
    terminalCode: text(record.terminal_code) as FailureCode | null,
    terminalMessageId: text(record.terminal_message_id),
    traceId: text(record.trace_id),
    correlationId: text(record.correlation_id),
    fencingToken: Number(record.fencing_token ?? 0),
    leaseOwner: text(record.lease_owner),
    leaseExpiresAt: text(record.lease_expires_at),
    attempts: Number(record.attempts ?? 0),
  };
}

export interface NewRun {
  runId: string;
  userEmail: string;
  conversationId: string;
  turnId: string;
  requestHash: string;
  /** Null for a caller that sent no `Idempotency-Key`. Never the raw key. */
  idempotencyKeyHash: string | null;
  /** Absolute, computed at admission. See the note on `deadlineFrom`. */
  deadlineAt: Date;
  identityModeRequested: string;
  /** Persisted snapshot; null means this run used no human persona. */
  personaId?: string | null;
  /** Name paired with personaId at execution time, never looked up later. */
  personaName?: string | null;
  releaseIdentity: Record<string, unknown>;
  /**
   * The id the browser minted for this request, or the server's own when it sent
   * none. Never null on a new run; null exists only on rows written before
   * schema version 2.
   */
  correlationId: string;
}

export interface CreatedOrFound {
  run: LedgerRun;
  /** False when this request attached to a run that already existed. */
  created: boolean;
}

/**
 * Create the run, or return the one this request is already part of.
 *
 * TWO WAYS TO BE A DUPLICATE, and the table enforces both. A caller that sent
 * an `Idempotency-Key` conflicts on `(user_email, idempotency_key_hash)`. A
 * caller that sent none, which is every caller today, conflicts on the partial
 * unique index over `(user_email, request_hash)` while a run for that question
 * is still executing. `ON CONFLICT DO NOTHING` with no target covers both,
 * which is why no target is named.
 *
 * THE CTE IS NOT DECORATION. `INSERT ... ON CONFLICT DO NOTHING RETURNING`
 * returns no rows when it conflicts, so the existing run has to be read in the
 * same breath or a second statement opens a window in which it could finish and
 * change. Reading it in the same statement has its own well-known hole: the
 * SELECT sees the snapshot taken when the statement began, so a row inserted by
 * a transaction that committed a moment ago can be invisible to it, and the
 * statement returns NOTHING AT ALL. That is not a hypothetical for us, it is
 * precisely the hundred-concurrent-identical-requests case. The answer is to
 * reissue: the next statement takes a new snapshot and sees it.
 */
export async function createOrGetRun(store: LakebaseReader, input: NewRun): Promise<LedgerResult<CreatedOrFound>> {
  const sql = `WITH inserted AS (
      INSERT INTO ${APP_SCHEMA}.runs
        (run_id, user_email, conversation_id, turn_id, request_hash, idempotency_key_hash,
         state, deadline_at, identity_mode_requested, release_identity, correlation_id,
         persona_id, persona_name)
      VALUES ($1,$2,$3,$4,$5,$6,'RECEIVED',$7,$8,$9::jsonb,$10,$11,$12)
      ON CONFLICT DO NOTHING
      RETURNING ${RUN_COLUMNS}
    )
    SELECT ${RUN_COLUMNS}, TRUE AS ledger_created FROM inserted
    UNION ALL
    SELECT ${RUN_COLUMNS}, FALSE AS ledger_created FROM ${APP_SCHEMA}.runs
     WHERE NOT EXISTS (SELECT 1 FROM inserted)
       AND user_email = $2
       AND (idempotency_key_hash = $6
            OR (request_hash = $5 AND state IN (${EXECUTING_SQL_LIST})))
     ORDER BY created_at DESC
     LIMIT 1`;

  const params = [
    input.runId,
    input.userEmail,
    input.conversationId,
    input.turnId,
    input.requestHash,
    input.idempotencyKeyHash,
    input.deadlineAt.toISOString(),
    input.identityModeRequested,
    JSON.stringify(input.releaseIdentity),
    input.correlationId,
    input.personaId ?? null,
    input.personaName ?? null,
  ];

  for (let attempt = 1; attempt <= RACE_ATTEMPTS; attempt += 1) {
    const read = await ledgerQuery(store, 'run ledger create-or-get', sql, params);
    if (!read.available) return unavailable(read);
    const found = row(read);
    if (found) {
      return { ok: true, value: { run: toRun(found), created: found.ledger_created === true } };
    }
    // Neither inserted nor found, which means the row that conflicted with us
    // was committed after this statement's snapshot began. Reissue rather than
    // report a failure the database does not have.
  }

  return {
    ok: false,
    reason: 'conflict',
    detail:
      `A run for this request could not be created or found in ${RACE_ATTEMPTS} attempts. Each ` +
      `insert conflicted and each read then missed the row it conflicted with, which should ` +
      `resolve in one retry, so this is contention on a scale nothing here expects.`,
  };
}

/**
 * Whether a stored run is the same question as the one being asked.
 *
 * The 409 the plan calls `IDEMPOTENCY_CONFLICT`: a client that reuses a key for
 * different content is confused about what it has already sent, and answering
 * with the earlier run would hand it the answer to a question it is no longer
 * asking. Returning the earlier answer would look like the feature working.
 */
export function idempotencyConflict(run: LedgerRun, requestHash: string): boolean {
  return run.idempotencyKeyHash !== null && run.requestHash !== requestHash;
}

/**
 * Take ownership of a run, bumping the fence so any previous owner is stale.
 *
 * One statement, and the predicates are the whole design. It succeeds only if
 * the run is in a state a takeover is legal from AND nobody holds a live lease
 * on it. Whoever wins increments `fencing_token`, which is what every later
 * write by the loser will fail to match, so a previous executor that comes back
 * from a network stall cannot write its result over the new one.
 *
 * Zero rows back is not an error. It means somebody else owns this run, which
 * is the answer the caller wanted and the point of asking.
 */
export async function acquireLease(
  store: LakebaseReader,
  runId: string,
  executor: string,
  from: readonly RunState[],
  leaseMs: number = LEASE_MS
): Promise<LedgerResult<LedgerRun>> {
  const sql = `UPDATE ${APP_SCHEMA}.runs
       SET fencing_token = fencing_token + 1,
           attempts = attempts + 1,
           lease_owner = $2,
           lease_expires_at = NOW() + ($3 || ' milliseconds')::interval,
           updated_at = NOW()
     WHERE run_id = $1
       AND state = ANY($4::text[])
       AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
    RETURNING ${RUN_COLUMNS}`;

  const read = await ledgerQuery(store, 'run ledger acquire lease', sql, [runId, executor, String(leaseMs), [...from]]);
  if (!read.available) return unavailable(read);
  const claimed = row(read);
  if (!claimed) {
    return {
      ok: false,
      reason: 'lost',
      detail:
        `Run ${runId} was not available to take over: either another executor holds a live lease ` +
        `on it or it has moved out of ${from.join(', ')}. Attach to it rather than running it again.`,
    };
  }
  return { ok: true, value: toRun(claimed) };
}

export interface TransitionInput {
  runId: string;
  from: RunState;
  to: RunState;
  /** The token this executor was given by `acquireLease`. */
  fencingToken: number;
  code?: FailureCode | null;
  traceId?: string;
  /** The `messages` row holding the answer, for a run that succeeded. */
  terminalMessageId?: string;
  identityModeEffective?: string;
  identityVerified?: boolean;
  planFingerprint?: string;
}

/**
 * Move a run from one state to another, if this executor still owns it.
 *
 * Two gates, and they catch different things. The transition matrix is checked
 * HERE, in TypeScript, before any statement is issued, so an illegal move is a
 * loud programming error rather than an UPDATE that quietly matches no rows and
 * is mistaken for a lost race. The fence is checked in the WHERE clause, where
 * it has to be, because ownership can change between the check and the write.
 *
 * Matching on `state = $from` as well as on the fence is deliberate belt and
 * braces: it makes a lost update impossible to mistake for success even if a
 * future caller passes a stale token that happens to still be current.
 */
export async function transition(store: LakebaseReader, input: TransitionInput): Promise<LedgerResult<LedgerRun>> {
  const illegal = transitionRefusal(input.from, input.to);
  if (illegal) return { ok: false, reason: 'conflict', detail: illegal };

  if (isTerminal(input.to)) {
    const mismatch = terminalRefusal(input.to, input.code ?? null);
    if (mismatch) return { ok: false, reason: 'conflict', detail: mismatch };
  } else if (input.code) {
    return {
      ok: false,
      reason: 'conflict',
      detail: `A run moving to ${input.to} has not finished, so it cannot carry the failure code ${input.code}.`,
    };
  }

  const finishing = isTerminal(input.to);
  // A run waiting on a person is owned by nobody. Holding the lease across an
  // approval would make the approval itself look like a second executor and be
  // refused, and the approval can arrive well inside the lease window: a plan
  // shown to somebody who is already reading it is approved in seconds.
  const releasing = finishing || input.to === 'AWAITING_APPROVAL';
  const sql = `UPDATE ${APP_SCHEMA}.runs
       SET state = $3,
           terminal_code = $4,
           terminal_message_id = COALESCE($5, terminal_message_id),
           trace_id = COALESCE($6, trace_id),
           identity_mode_effective = COALESCE($7, identity_mode_effective),
           identity_verified = COALESCE($8, identity_verified),
           plan_fingerprint = COALESCE($9, plan_fingerprint),
           updated_at = NOW(),
           completed_at = CASE WHEN $10 THEN NOW() ELSE completed_at END,
           lease_expires_at = CASE WHEN $12 THEN NULL ELSE lease_expires_at END
     WHERE run_id = $1
       AND fencing_token = $2
       AND state = $11
    RETURNING ${RUN_COLUMNS}`;

  const read = await ledgerQuery(store, 'run ledger transition', sql, [
    input.runId,
    input.fencingToken,
    input.to,
    input.code ?? null,
    input.terminalMessageId ?? null,
    input.traceId ?? null,
    input.identityModeEffective ?? null,
    input.identityVerified ?? null,
    input.planFingerprint ?? null,
    finishing,
    input.from,
    releasing,
  ]);
  if (!read.available) return unavailable(read);
  const moved = row(read);
  if (!moved) {
    return {
      ok: false,
      reason: 'lost',
      detail:
        `Run ${input.runId} did not move ${input.from} to ${input.to} under fencing token ` +
        `${input.fencingToken}. Another executor owns it, or it has already left ${input.from}. ` +
        `This executor must stop rather than continue: anything it produces from here is a ` +
        `second answer to a question that already has one.`,
    };
  }
  return { ok: true, value: toRun(moved) };
}

/**
 * Say this executor is still alive, extending its lease.
 *
 * Fenced like every other write. A heartbeat from an executor that has been
 * taken over must not extend a lease it no longer holds, which is exactly how a
 * stalled executor would keep a run away from the one that replaced it.
 */
export async function heartbeat(
  store: LakebaseReader,
  runId: string,
  fencingToken: number,
  leaseMs: number = LEASE_MS
): Promise<LedgerResult<boolean>> {
  const read = await ledgerQuery(
    store,
    'run ledger heartbeat',
    `UPDATE ${APP_SCHEMA}.runs
        SET lease_expires_at = NOW() + ($3 || ' milliseconds')::interval, updated_at = NOW()
      WHERE run_id = $1 AND fencing_token = $2 AND completed_at IS NULL
     RETURNING run_id`,
    [runId, fencingToken, String(leaseMs)]
  );
  if (!read.available) return unavailable(read);
  return { ok: true, value: read.rows.length > 0 };
}

/**
 * Record an attempt, for the audit question the lease cannot answer.
 *
 * The lease on `runs` says who owns the run NOW. This says who has owned it,
 * which is what somebody asks when a question was answered twice or not at all.
 * The unique constraint on `(run_id, fencing_token)` means two executors cannot
 * both claim to have been the holder of one fence.
 */
export async function recordAttempt(
  store: LakebaseReader,
  input: { attemptId: string; runId: string; fencingToken: number; executor: string }
): Promise<LedgerResult<boolean>> {
  const read = await ledgerQuery(
    store,
    'run ledger record attempt',
    `INSERT INTO ${APP_SCHEMA}.run_attempts (attempt_id, run_id, fencing_token, executor)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (run_id, fencing_token) DO NOTHING
     RETURNING attempt_id`,
    [input.attemptId, input.runId, input.fencingToken, input.executor]
  );
  if (!read.available) return unavailable(read);
  return { ok: true, value: read.rows.length > 0 };
}

export async function completeAttempt(
  store: LakebaseReader,
  input: { runId: string; fencingToken: number; outcome: string; failureCode?: FailureCode | null }
): Promise<LedgerResult<boolean>> {
  const read = await ledgerQuery(
    store,
    'run ledger complete attempt',
    `UPDATE ${APP_SCHEMA}.run_attempts
        SET completed_at = NOW(), outcome = $3, failure_code = $4
      WHERE run_id = $1 AND fencing_token = $2
     RETURNING attempt_id`,
    [input.runId, input.fencingToken, input.outcome, input.failureCode ?? null]
  );
  if (!read.available) return unavailable(read);
  return { ok: true, value: read.rows.length > 0 };
}

/**
 * The owner-facing result of one explicit Stop.
 *
 * `not-found` deliberately combines a missing identifier with one owned by
 * somebody else. The owner predicate is in both SQL statements, so this API
 * never has another reader's row in hand and cannot disclose that it exists.
 */
export type OwnerCancellation =
  | { kind: 'cancelled'; runs: LedgerRun[] }
  | { kind: 'not-active'; run: LedgerRun }
  | { kind: 'not-found' };

/**
 * Cancel one owner's active run by its durable run id or browser correlation id.
 *
 * The UPDATE is the cancellation authority. It is one conditional statement:
 * changing the state, invalidating the old executor's fence, and releasing its
 * lease happen together or not at all. A stale executor returning from Model
 * Serving therefore cannot settle success under the token it was given.
 *
 * A second, owner-scoped read is used only to distinguish an already-terminal
 * run (409 at the route) from an identifier the caller is not allowed to know
 * about (404). It does not participate in the state change.
 */
export async function cancelOwnedRun(
  store: LakebaseReader,
  userEmail: string,
  identifier: string
): Promise<LedgerResult<OwnerCancellation>> {
  const cancelled = await ledgerQuery(
    store,
    'run ledger cancel owned run',
    `UPDATE ${APP_SCHEMA}.runs
        SET state = 'CANCELLED',
            terminal_code = NULL,
            fencing_token = fencing_token + 1,
            lease_owner = NULL,
            lease_expires_at = NULL,
            completed_at = NOW(),
            updated_at = NOW()
      WHERE user_email = $1
        AND (run_id = $2 OR correlation_id = $2)
        AND state = ANY($3::text[])
     RETURNING ${RUN_COLUMNS}`,
    [userEmail, identifier, [...EXECUTING_STATES]]
  );
  if (!cancelled.available) return unavailable(cancelled);
  if (cancelled.rows.length > 0) {
    return { ok: true, value: { kind: 'cancelled', runs: cancelled.rows.map(toRun) } };
  }

  const existing = await ledgerQuery(
    store,
    'run ledger read owned cancellation target',
    `SELECT ${RUN_COLUMNS}
       FROM ${APP_SCHEMA}.runs
      WHERE user_email = $1 AND (run_id = $2 OR correlation_id = $2)
      ORDER BY CASE WHEN run_id = $2 THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1`,
    [userEmail, identifier]
  );
  if (!existing.available) return unavailable(existing);
  const found = row(existing);
  return {
    ok: true,
    value: found ? { kind: 'not-active', run: toRun(found) } : { kind: 'not-found' },
  };
}

/**
 * Cancel the one-time snapshot of every run active when this statement starts.
 *
 * There is no deployment-level pause flag. A run admitted after this statement
 * takes its snapshot is not matched and proceeds normally.
 */
export async function cancelAllExecutingRuns(store: LakebaseReader): Promise<LedgerResult<LedgerRun[]>> {
  const cancelled = await ledgerQuery(
    store,
    'run ledger cancel all executing runs',
    `UPDATE ${APP_SCHEMA}.runs
        SET state = 'CANCELLED',
            terminal_code = NULL,
            fencing_token = fencing_token + 1,
            lease_owner = NULL,
            lease_expires_at = NULL,
            completed_at = NOW(),
            updated_at = NOW()
      WHERE state = ANY($1::text[])
     RETURNING ${RUN_COLUMNS}`,
    [[...EXECUTING_STATES]]
  );
  if (!cancelled.available) return unavailable(cancelled);
  return { ok: true, value: cancelled.rows.map(toRun) };
}

/** A run read back by id, scoped to its owner. */
export async function readRun(
  store: LakebaseReader,
  runId: string,
  userEmail: string
): Promise<LedgerResult<LedgerRun | null>> {
  // Scoped by owner in the statement rather than checked after reading. The
  // plan requires cross-user lookup of a run to be DENIED, and a check applied
  // to a row already in hand is one somebody can later move, reorder or return
  // early past.
  const read = await ledgerQuery(
    store,
    'run ledger read run',
    `SELECT ${RUN_COLUMNS} FROM ${APP_SCHEMA}.runs WHERE run_id = $1 AND user_email = $2`,
    [runId, userEmail]
  );
  if (!read.available) return unavailable(read);
  const found = row(read);
  return { ok: true, value: found ? toRun(found) : null };
}
