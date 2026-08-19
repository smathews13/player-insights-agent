/**
 * Answering a repeated request from what the first one already produced.
 *
 * This is the half of the replay work that can be built and tested without a
 * browser, and it is the half that matters: what a returning caller is served.
 * Whether it arrives as a JSON body or as an SSE `result` event is the
 * responder's business, and both go through the same body, so replay does not
 * get to be a second answer contract.
 *
 * WHAT IS NOT REPLAYED, and this is a real gap rather than an oversight: the
 * stage narration. Stages are streamed as the agent produces them and nothing
 * stores them, so a caller who reconnects gets the answer without the run that
 * led to it. Storing stages in `run_events` is the obvious fix and belongs with
 * the work that maps stages onto run states, since both need the same hook.
 */

import { APP_SCHEMA } from '../../shared/app-schema';
import { ledgerQuery } from './run-ledger';
import type { LedgerRun } from './run-ledger';
import type { LakebaseReader } from './lakebase-store';
import { mayCarryAnswer } from './run-state';
import type { FailureCode } from './run-failure-codes';

export type Replay =
  /** The stored answer, exactly as the first caller was served it. */
  | { kind: 'answer'; body: Record<string, unknown> }
  /** The run finished without an answer. The route builds the refusal from the code. */
  | { kind: 'failure'; code: FailureCode | null; state: string }
  /** The run says it answered and the answer is not there. */
  | { kind: 'missing'; detail: string }
  | { kind: 'unavailable'; detail: string };

/**
 * The answer a finished run was served with.
 *
 * Scoped to the run's own reader through the conversation, not just by message
 * id. `messages` carries no owner of its own, so an id-only read is how one
 * user's answer reaches another user's screen. The ledger row was already read
 * under the caller's address, and this predicate is the second half of the
 * same rule rather than a duplicate of it: two reads, both scoped, is what
 * makes a missing predicate fail closed instead of leaking.
 */
export async function readReplay(store: LakebaseReader, run: LedgerRun): Promise<Replay> {
  if (!mayCarryAnswer(run.state)) {
    return { kind: 'failure', code: run.terminalCode, state: run.state };
  }
  if (!run.terminalMessageId) {
    // SUCCEEDED with nothing to serve. The run and the answer are written by
    // two statements and the second can be lost, which is the case this names
    // rather than hides: replaying nothing as an empty answer would be worse
    // than saying the answer cannot be found.
    return {
      kind: 'missing',
      detail: `Run ${run.runId} succeeded but recorded no message to replay.`,
    };
  }

  const read = await ledgerQuery(store, 'run replay',
    `SELECT m.response_json FROM ${APP_SCHEMA}.messages m
       JOIN ${APP_SCHEMA}.conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.user_email = $2`,
    [run.terminalMessageId, run.userEmail]
  );
  if (!read.available) return { kind: 'unavailable', detail: `${read.error} (code ${read.code})` };

  const stored = read.rows[0]?.response_json;
  if (stored === undefined || stored === null) {
    return {
      kind: 'missing',
      detail: `Run ${run.runId} names message ${run.terminalMessageId}, which no longer exists for this reader.`,
    };
  }

  const body = parseStored(stored);
  if (!body) {
    return {
      kind: 'missing',
      detail: `The stored answer for run ${run.runId} could not be read back as an answer.`,
    };
  }
  return { kind: 'answer', body };
}

/**
 * `response_json` comes back as an object from a `jsonb` column and as a string
 * from a `text` one, and this table has been both.
 */
function parseStored(stored: unknown): Record<string, unknown> | null {
  if (typeof stored === 'object') return stored as Record<string, unknown>;
  if (typeof stored !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The stored answer, marked as one.
 *
 * A replayed answer must not claim to be a fresh run. The reader is entitled to
 * know the figures in front of them were produced earlier, and a client that
 * shows a "just now" timestamp on a replay is telling them something false.
 * Added beside the answer rather than inside it for the same reason `runStored`
 * is: neither is part of the agent's answer contract.
 */
export function replayBody(body: Record<string, unknown>, run: LedgerRun): Record<string, unknown> {
  return {
    ...body,
    replayed: true,
    replayedRunId: run.runId,
  };
}
