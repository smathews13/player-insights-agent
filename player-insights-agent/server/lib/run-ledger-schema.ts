/**
 * The three tables the run ledger keeps, and why each statement is one it is
 * safe to run against the live database on every boot.
 *
 * READ THIS BEFORE ADDING A STATEMENT. `applySchema` runs this list at every
 * start of the deployed app, against a database that already holds the
 * customer's conversation history. This repository has been burned repeatedly
 * by one specific Postgres behaviour: `ALTER TABLE ... ADD COLUMN IF NOT
 * EXISTS` is REFUSED when the app's Postgres role does not own the table,
 * because ownership is checked BEFORE the statement is found to be a no-op, and
 * `IF NOT EXISTS` does not exempt it. That refusal used to stop the seven
 * statements after it. It no longer does, but the rule it taught still holds:
 *
 *   1. Nothing here alters an existing table. Every constraint the ledger needs
 *      is declared INSIDE its `CREATE TABLE`, so a fresh database and an
 *      existing one converge without a single ALTER.
 *   2. Nothing here drops, renames or rewrites anything. The ledger is additive
 *      to a schema that is serving traffic, and a run ledger that took the app
 *      down on the way in would have earned its reputation.
 *   3. Every statement is a no-op the second time. `CREATE TABLE IF NOT EXISTS`
 *      and `CREATE INDEX IF NOT EXISTS` are how that is spelled here.
 *   4. A statement that IS refused must leave the boot healthy. It does: the
 *      loop continues, and `applySchema` then reads the schema to decide
 *      whether the refusal mattered, so a statement refused on ownership whose
 *      object is already there warns instead of erroring.
 *
 * The index statements are the ones worth a second thought, because
 * `CREATE INDEX` checks ownership of the TABLE it indexes and the check happens
 * before `IF NOT EXISTS` is considered, exactly as it does for `ALTER`. They
 * are safe here only because the tables they index are created by these same
 * statements, as the app, so the app owns them. An index added later against
 * `messages` or `conversations` would NOT have that property.
 */

import { APP_SCHEMA } from '../../shared/app-schema';
import { EXECUTING_STATES } from './run-state';

/**
 * The states a partial index treats as "this run is being worked on right now".
 *
 * Rendered into SQL rather than passed as a parameter because an index
 * predicate cannot take one. Quoted here rather than hand-written into the
 * statement so that adding an executing state to the state machine cannot leave
 * the uniqueness rule describing a state machine that no longer exists.
 */
const EXECUTING_STATE_LIST = EXECUTING_STATES.map((state) => `'${state}'`).join(', ');

export const RUN_LEDGER_DDL: readonly string[] = [
  /**
   * One row per question, and the authority on what is happening to it.
   *
   * The lease lives here, on the run, rather than on `run_attempts` where the
   * plan sketches it. That is a deliberate departure and the reason is the
   * client: AppKit hands this app a `pg.Pool` and a bare `query(text, params)`,
   * with no way to hold one connection across calls, so there are NO
   * transactions available to it. Every ledger operation therefore has to be a
   * single statement to be atomic, and taking a lease means reading the current
   * holder and bumping the fence together. Across two tables that is two
   * statements and a race; on one row it is one UPDATE.
   *
   * `run_attempts` still records every attempt, because the lease answers "who
   * owns this now" and the audit question is "who has owned it", which the
   * current holder cannot answer on its own.
   */
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.runs (
    run_id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    label_scope TEXT,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    idempotency_key_hash TEXT,
    request_hash TEXT NOT NULL,
    plan_fingerprint TEXT,
    state TEXT NOT NULL,
    deadline_at TIMESTAMPTZ NOT NULL,
    identity_mode_requested TEXT,
    identity_mode_effective TEXT,
    identity_verified BOOLEAN,
    release_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
    terminal_code TEXT,
    terminal_message_id TEXT,
    trace_id TEXT,
    fencing_token BIGINT NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT runs_idempotency_key_unique UNIQUE (user_email, idempotency_key_hash)
  )`,

  /**
   * Every attempt on a run, kept whether it finished or not.
   *
   * The unique constraint on (run_id, fencing_token) is what makes a duplicate
   * executor a database error rather than a second row: two attempts cannot
   * claim the same fence, so an executor that believes it holds the run while
   * another has taken it over fails on the way in instead of on the way out,
   * after it has already paid for the model call.
   */
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.run_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    fencing_token BIGINT NOT NULL,
    executor TEXT NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    outcome TEXT,
    failure_code TEXT,
    CONSTRAINT run_attempts_fence_unique UNIQUE (run_id, fencing_token)
  )`,

  /**
   * The ordered events of a run, which is what a reconnecting browser is
   * replayed from.
   *
   * `(run_id, seq)` is the primary key rather than a surrogate id, because seq
   * has to be dense and monotonic PER RUN for `Last-Event-ID` to mean anything,
   * and a shared sequence would leave gaps a client cannot tell from lost
   * events. Allocating it as `MAX(seq) + 1` races; the primary key is what
   * turns that race into a retry rather than into two events numbered the same.
   *
   * `payload` is bounded and redacted by the writer, not here. Nothing in this
   * table may carry a bearer token, a raw tool result, or the text of an
   * attachment.
   */
  `CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.run_events (
    run_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    stage TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, seq)
  )`,

  /**
   * At most one run of the same question may be executing at once.
   *
   * This is what gives a caller that sent no `Idempotency-Key` the property the
   * plan asks for, that a hundred concurrent identical requests produce one
   * logical run: the second insert violates this index, and the coordinator
   * reads the live run instead of starting a second agent. Today's browser
   * sends no key, so without this the guarantee would apply only to callers
   * that do not exist yet.
   *
   * PARTIAL, and the predicate matters in both directions. Restricting it to
   * the executing states means a question asked again next week, when the first
   * run has long finished, is a new run and gets a fresh answer rather than
   * being permanently welded to the old one. AWAITING_APPROVAL is deliberately
   * NOT executing: a run can sit there for as long as a person takes to read a
   * plan, and blocking a re-ask for that whole time would be a worse bug than
   * the duplicate it prevented.
   */
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_live_request_unique
     ON ${APP_SCHEMA}.runs (user_email, request_hash)
     WHERE state IN (${EXECUTING_STATE_LIST})`,

  // Run Explorer reads a conversation's runs newest first, and the ask route
  // resolves the run of a turn. Without this, both are sequential scans of a
  // table that grows with every question ever asked.
  `CREATE INDEX IF NOT EXISTS runs_conversation_idx
     ON ${APP_SCHEMA}.runs (conversation_id, created_at DESC)`,

  // The operational read: which of this user's runs are unfinished. Also the
  // sweep that finds runs whose lease expired without a terminal state, which
  // the plan requires to be alertable rather than merely absent.
  `CREATE INDEX IF NOT EXISTS runs_state_idx
     ON ${APP_SCHEMA}.runs (state, lease_expires_at)`,

  `CREATE INDEX IF NOT EXISTS run_attempts_run_idx
     ON ${APP_SCHEMA}.run_attempts (run_id, started_at DESC)`,
];
