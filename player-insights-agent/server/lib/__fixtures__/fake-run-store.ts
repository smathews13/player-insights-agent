import type { LakebaseReader } from '../lakebase-store';
import { EXECUTING_STATES } from '../run-state';

/**
 * A fake Postgres, not a fake query log.
 *
 * Asserting on SQL strings proves the string somebody wrote is the string
 * somebody wrote. What has to be right here is the BEHAVIOUR under contention:
 * that a conflicting insert returns the existing run, that a second executor
 * cannot take a leased run, that a stale fence writes nothing. So this models
 * the three Postgres properties those rest on, and nothing else:
 *
 *   - the unique constraint on (user_email, idempotency_key_hash),
 *   - the partial unique index over the executing states,
 *   - the conditional UPDATE matching zero rows when its WHERE fails.
 *
 * It recognises statements by shape and applies them to plain objects. That is
 * a real cost: a change to the SQL that the fake does not understand passes
 * here and fails in production. It is accepted because the alternative is no
 * coverage of the concurrency semantics at all, and those are the part of this
 * file that is difficult to get right. `run-ledger-schema.test.ts` covers the
 * DDL that the constraints below stand in for.
 */

export interface Row {
  run_id: string;
  user_email: string;
  conversation_id: string;
  turn_id: string;
  request_hash: string;
  idempotency_key_hash: string | null;
  plan_fingerprint: string | null;
  state: string;
  deadline_at: string;
  identity_mode_requested: string | null;
  identity_mode_effective: string | null;
  identity_verified: boolean | null;
  terminal_code: string | null;
  terminal_message_id: string | null;
  trace_id: string | null;
  correlation_id: string | null;
  fencing_token: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export class FakeStore implements LakebaseReader {
  runs: Row[] = [];
  attempts: {
    attempt_id: string;
    run_id: string;
    fencing_token: number;
    executor: string;
    outcome: string | null;
    failure_code: string | null;
    completed_at: number | null;
  }[] = [];
  /** Every accepted transition, so a caller's path through the matrix is visible. */
  events: { run_id: string; from: string; to: string }[] = [];
  /** Stored answers, with the owner the real read reaches through a join. */
  messages: { id: string; user_email: string; response_json: unknown }[] = [];
  /**
   * The narration of a run, which is what a returning browser replays.
   *
   * Modelled because the property worth pinning is the primary key: `(run_id,
   * seq)` is what turns a repeated append into a no-op rather than a second row
   * numbered the same, and what makes `ORDER BY seq` the order the run went in.
   */
  stageEvents: { run_id: string; seq: number; event_id: string; event_type: string; stage: string | null; payload: unknown }[] =
    [];
  now = 1_000_000;
  /** Rows committed after the current statement's snapshot, see the note below. */
  private hidden: Row[] = [];
  failWith: string | null = null;
  statements: string[] = [];
  private clock = 0;

  /**
   * Simulates the snapshot hole in `INSERT ... ON CONFLICT DO NOTHING` followed
   * by a SELECT in the same statement: the insert conflicts with a row the
   * SELECT cannot see, so the statement returns nothing at all.
   */
  hideOnce(runRow: Row) {
    this.hidden.push(runRow);
  }

  lakebase = {
    // Resolves an already-computed answer rather than being `async`, because
    // nothing in here waits for anything. The signature still has to match the
    // real client's to be substitutable for it.
    query: (text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> =>
      Promise.resolve(this.answer(text, params)),
  };

  private answer(text: string, params: unknown[]): { rows: Record<string, unknown>[] } {
    this.statements.push(text);
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: '08006' });
    // The schema this fake stands for is already in place, which is what a
    // second boot against a real database finds too. Accepted rather than
    // recognised: nothing here depends on the DDL, and a route test that boots
    // the app runs it before reaching anything that does.
    if (/^\s*CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(text)) return { rows: [] };
    if (/INSERT INTO player_insights\.runs/i.test(text)) return { rows: this.createOrGet(params) };
    if (/UPDATE player_insights\.runs[\s\S]*fencing_token = fencing_token \+ 1/i.test(text)) {
      return { rows: this.acquire(params) };
    }
    if (/UPDATE player_insights\.runs[\s\S]*SET state =/i.test(text)) return { rows: this.transition(params) };
    if (/UPDATE player_insights\.runs[\s\S]*lease_expires_at = NOW\(\)/i.test(text)) {
      return { rows: this.heartbeat(params) };
    }
    if (/FROM player_insights\.runs[\s\S]*WHERE conversation_id = \$1 AND user_email = \$2/i.test(text)) {
      return { rows: this.latestConversationRun(params) };
    }
    if (/SELECT[\s\S]*FROM player_insights\.runs WHERE run_id/i.test(text)) return { rows: this.read(params) };
    if (/FROM player_insights\.messages m/i.test(text)) return { rows: this.readMessage(params) };
    if (/INSERT INTO player_insights\.run_attempts/i.test(text)) return { rows: this.insertAttempt(params) };
    if (/UPDATE player_insights\.run_attempts/i.test(text)) return { rows: this.finishAttempt(params) };
    if (/INSERT INTO player_insights\.run_events/i.test(text)) return { rows: this.insertStageEvent(params) };
    if (/FROM player_insights\.run_events/i.test(text)) return { rows: this.readStageEvents(params) };
    throw new Error(`The fake store does not know this statement: ${text.slice(0, 80)}`);
  }

  private createOrGet(params: unknown[]): Record<string, unknown>[] {
    const [runId, email, conversationId, turnId, requestHash, keyHash, deadline, requested, , correlationId] =
      params as string[];
    const executing = (row: Row) => (EXECUTING_STATES as readonly string[]).includes(row.state);
    const visible = this.runs;
    const all = [...this.runs, ...this.hidden];
    const conflicting = all.find(
      (row) =>
        row.user_email === email &&
        ((keyHash !== null && row.idempotency_key_hash === keyHash) ||
          (row.request_hash === requestHash && executing(row)))
    );
    if (!conflicting) {
      this.clock += 1;
      const created: Row = {
        run_id: runId,
        user_email: email,
        conversation_id: conversationId,
        turn_id: turnId,
        request_hash: requestHash,
        idempotency_key_hash: keyHash ?? null,
        plan_fingerprint: null,
        state: 'RECEIVED',
        deadline_at: deadline,
        identity_mode_requested: requested,
        identity_mode_effective: null,
        identity_verified: null,
        terminal_code: null,
        terminal_message_id: null,
        trace_id: null,
        correlation_id: correlationId ?? null,
        fencing_token: 0,
        lease_owner: null,
        lease_expires_at: null,
        attempts: 0,
        created_at: this.clock,
        updated_at: this.clock,
        completed_at: null,
      };
      this.runs.push(created);
      return [{ ...created, ledger_created: true }];
    }
    // Conflicted. Only rows the snapshot can see are returned, which is where
    // the hidden ones make the statement come back empty.
    const found = visible.find((row) => row === conflicting);
    // Whatever was hidden becomes visible to the next statement, exactly as a
    // committed row does to the next snapshot.
    this.runs.push(...this.hidden);
    this.hidden = [];
    return found ? [{ ...found, ledger_created: false }] : [];
  }

  private acquire(params: unknown[]): Record<string, unknown>[] {
    const [runId, executor, leaseMs, from] = params as [string, string, string, string[]];
    const run = this.runs.find((row) => row.run_id === runId);
    if (!run) return [];
    if (!from.includes(run.state)) return [];
    if (run.lease_expires_at !== null && run.lease_expires_at > this.now) return [];
    run.fencing_token += 1;
    run.attempts += 1;
    run.lease_owner = executor;
    run.lease_expires_at = this.now + Number(leaseMs);
    return [{ ...run }];
  }

  private transition(params: unknown[]): Record<string, unknown>[] {
    const [runId, fence, to, code, messageId, traceId, effective, verified, fingerprint, finishing, from, releasing] =
      params as [
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        boolean | null,
        string | null,
        boolean,
        string,
        boolean,
      ];
    const run = this.runs.find((row) => row.run_id === runId);
    if (!run || run.fencing_token !== fence || run.state !== from) return [];
    this.events.push({ run_id: runId, from, to });
    run.state = to;
    run.terminal_code = code;
    run.terminal_message_id = messageId ?? run.terminal_message_id;
    run.trace_id = traceId ?? run.trace_id;
    run.identity_mode_effective = effective ?? run.identity_mode_effective;
    run.identity_verified = verified ?? run.identity_verified;
    run.plan_fingerprint = fingerprint ?? run.plan_fingerprint;
    if (finishing) run.completed_at = this.now;
    if (releasing) run.lease_expires_at = null;
    return [{ ...run }];
  }

  private heartbeat(params: unknown[]): Record<string, unknown>[] {
    const [runId, fence, leaseMs] = params as [string, number, string];
    const run = this.runs.find((row) => row.run_id === runId);
    if (!run || run.fencing_token !== fence || run.completed_at !== null) return [];
    run.lease_expires_at = this.now + Number(leaseMs);
    return [{ run_id: run.run_id }];
  }

  private read(params: unknown[]): Record<string, unknown>[] {
    const [runId, email] = params as string[];
    const run = this.runs.find((row) => row.run_id === runId && row.user_email === email);
    return run ? [{ ...run }] : [];
  }

  private latestConversationRun(params: unknown[]): Record<string, unknown>[] {
    const [conversationId, email] = params as string[];
    const runs = this.runs
      .filter((row) => row.conversation_id === conversationId && row.user_email === email)
      .sort((a, b) => b.created_at - a.created_at);
    return runs.length > 0 ? [{ ...runs[0] }] : [];
  }

  /**
   * Applies the owner predicate rather than only the id, because the read being
   * tested is the one that must not return another reader's answer.
   */
  private readMessage(params: unknown[]): Record<string, unknown>[] {
    const [messageId, email] = params as string[];
    const message = this.messages.find((row) => row.id === messageId && row.user_email === email);
    return message ? [{ response_json: message.response_json }] : [];
  }

  private insertAttempt(params: unknown[]): Record<string, unknown>[] {
    const [attemptId, runId, fence, executor] = params as [string, string, number, string];
    if (this.attempts.some((row) => row.run_id === runId && row.fencing_token === fence)) return [];
    this.attempts.push({
      attempt_id: attemptId,
      run_id: runId,
      fencing_token: fence,
      executor,
      outcome: null,
      failure_code: null,
      completed_at: null,
    });
    return [{ attempt_id: attemptId }];
  }

  /**
   * `ON CONFLICT (run_id, seq) DO NOTHING`, which is the whole reason this is
   * modelled: an append reissued after a connection failure must not become a
   * second row, and it must not be reported as a fresh write either.
   */
  private insertStageEvent(params: unknown[]): Record<string, unknown>[] {
    const [runId, seq, eventId, eventType, stage, payload] = params as [
      string,
      number,
      string,
      string,
      string | null,
      string,
    ];
    if (this.stageEvents.some((row) => row.run_id === runId && row.seq === Number(seq))) return [];
    this.stageEvents.push({
      run_id: runId,
      seq: Number(seq),
      event_id: eventId,
      event_type: eventType,
      stage,
      // Stored parsed, the way a `jsonb` column hands it back.
      payload: JSON.parse(payload),
    });
    return [{ seq: Number(seq) }];
  }

  private readStageEvents(params: unknown[]): Record<string, unknown>[] {
    const [runId, eventType] = params as [string, string];
    return this.stageEvents
      .filter((row) => row.run_id === runId && row.event_type === eventType)
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({ payload: row.payload }));
  }

  private finishAttempt(params: unknown[]): Record<string, unknown>[] {
    const [runId, fence, outcome, code] = params as [string, number, string, string | null];
    const attempt = this.attempts.find((row) => row.run_id === runId && row.fencing_token === fence);
    if (!attempt) return [];
    attempt.outcome = outcome;
    attempt.failure_code = code;
    attempt.completed_at = this.now;
    return [{ attempt_id: attempt.attempt_id }];
  }
}
