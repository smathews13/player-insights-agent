/**
 * The steps of a run, written down as they happen, so a reader who walks away
 * mid-question is shown the path again when they come back.
 *
 * THIS IS THE GAP `run-replay.ts` NAMES. Stages were streamed and nothing
 * stored them, so the only durable record of a run in flight was its `runs`
 * row: a state and two timestamps. A browser that reopened a working
 * conversation could therefore learn THAT the agent was working and never
 * WHAT it had done, which is the state a reader reported as the page locking --
 * their question still on screen, the composer shut because a run is in
 * flight, and an agent path that stayed empty however long they waited.
 *
 * WHAT GOES IN THE TABLE, and this is the line the schema's own comment draws:
 * no bearer token, no raw tool result, no attachment text. So this stores the
 * step's identity and shape -- its id, name, kind, status, offset, duration,
 * call count and nesting -- and the ARGUMENTS it was given, clamped to the
 * width the rail draws them at. The step's OUTPUT is deliberately not stored:
 * that is the tool result the schema rules out, and the rail's second line
 * simply has nothing to say on a replayed row. The authoritative trace arrives
 * with the answer and carries everything.
 *
 * WHY NOT `readStored`. Same reason `run-ledger.ts` avoids it: `readStored`
 * maintains the app-wide storage health that every degradable surface reads,
 * and these tables are new. On a database where their CREATE was refused on
 * ownership, an append here fails while the rest of the store is perfectly
 * healthy, and reporting that as a store-wide outage would take the whole app
 * down to its degraded paths over a table nothing else reads.
 */

import { APP_SCHEMA } from '../../shared/app-schema';
import type { LakebaseReader } from './lakebase-store';

/** The `event_type` a stage append is filed under, so a later event kind can share the table. */
export const STAGE_EVENT_TYPE = 'stage';

/**
 * How much of a step's arguments are kept.
 *
 * The rail clamps what it draws to 180 characters and says so with an
 * ellipsis, so storing more would be storing something no surface shows. It is
 * also what keeps this column from becoming a second copy of a Genie question
 * or a whole SQL statement.
 */
export const STAGE_INPUT_LIMIT = 180;

/**
 * How many steps one run may replay.
 *
 * A returning browser polls this every 1.5 seconds, so the read has to have a
 * bound that does not depend on the agent behaving. Measured runs report
 * between 4 and 30 steps; 200 is far past anything observed and still small
 * enough that a runaway run cannot turn a poll into a large response.
 */
export const STAGE_REPLAY_LIMIT = 200;

/** A recorded string, collapsed and shortened the way the rail shortens it. */
function clamp(value: string, limit = STAGE_INPUT_LIMIT): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}\u2026` : collapsed;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The part of a stage that may be stored, and nothing else.
 *
 * An allowlist rather than a redaction pass, deliberately. A field the agent
 * adds tomorrow is a field this does not store, which is the safe direction:
 * the opposite arrangement stores whatever the endpoint invents and finds out
 * later that one of the additions was a tool result or a token.
 *
 * Every field is omitted when the stage did not carry one, because the client
 * normalizes an absent `start` and an absent `depth` differently from zero --
 * `startMeasured` exists for exactly that distinction, and writing a 0 here
 * would turn "this model version reports no offsets" into "this step began at
 * the start of the run".
 */
export function stageEventPayload(stage: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined) payload[key] = value;
  };
  put('id', typeof stage.id === 'string' ? stage.id : undefined);
  put('name', typeof stage.name === 'string' ? clamp(stage.name) : undefined);
  put('kind', typeof stage.kind === 'string' ? stage.kind : undefined);
  put('status', typeof stage.status === 'string' ? stage.status : undefined);
  put('start', asFiniteNumber(stage.start));
  put('duration', asFiniteNumber(stage.duration));
  put('calls', asFiniteNumber(stage.calls));
  put('depth', asFiniteNumber(stage.depth));
  put('parent_id', typeof stage.parent_id === 'string' ? stage.parent_id : undefined);
  // The arguments, clamped. Never `output`: see the note at the top of the file.
  const input = typeof stage.input === 'string' ? clamp(stage.input) : '';
  if (input) payload.input = input;
  return payload;
}

/**
 * Which step this row is, for an operator reading the table rather than for the
 * browser. Bounded like everything else here.
 */
function stageLabel(stage: Record<string, unknown>): string | null {
  return typeof stage.name === 'string' && stage.name.trim() ? clamp(stage.name, 120) : null;
}

/**
 * One statement, with its failure reported at most once per run.
 *
 * A run reports every step through here, so a `console.error` per statement
 * would turn one unreadable table into thirty log lines per question and bury
 * the one line that says what happened. The first failure is described in full
 * and the rest of the run is silent about it.
 */
async function stageQuery(
  store: LakebaseReader,
  reporter: { reported: boolean },
  label: string,
  sql: string,
  params: unknown[]
): Promise<Record<string, unknown>[] | null> {
  try {
    const result = await store.lakebase.query(sql, params);
    return result.rows;
  } catch (error) {
    if (!reporter.reported) {
      reporter.reported = true;
      const raw = (error as { code?: unknown }).code;
      const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'none';
      console.warn(
        `[run-stage-events] ${label} failed (code ${code}): ${
          error instanceof Error ? error.message : String(error)
        }. The run is unaffected and its answer is still stored; a browser that reopens this ` +
          `conversation mid-run will see that it is working without the steps it has taken.`
      );
    }
    return null;
  }
}

/**
 * Append one step to a run's durable narration.
 *
 * `ON CONFLICT DO NOTHING` on `(run_id, seq)`, so a retry of the same append
 * is a no-op rather than a duplicate row. The sequence is dense and allocated
 * by the caller, which is what lets a reader order the steps the way the run
 * went rather than the way the writes landed.
 */
export async function recordStageEvent(
  store: LakebaseReader,
  input: { runId: string; seq: number; stage: Record<string, unknown> },
  reporter: { reported: boolean } = { reported: false }
): Promise<boolean> {
  const rows = await stageQuery(
    store,
    reporter,
    'stage append',
    `INSERT INTO ${APP_SCHEMA}.run_events (run_id, seq, event_id, event_type, stage, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (run_id, seq) DO NOTHING
     RETURNING seq`,
    [
      input.runId,
      input.seq,
      `${input.runId}-${input.seq}`,
      STAGE_EVENT_TYPE,
      stageLabel(input.stage),
      JSON.stringify(stageEventPayload(input.stage)),
    ]
  );
  return rows !== null;
}

/**
 * `payload` comes back as an object from a `jsonb` column and as a string from
 * a driver configured to hand JSON over unparsed. Both have been seen against
 * this store, so both are read.
 */
function parsePayload(stored: unknown): Record<string, unknown> | null {
  if (stored && typeof stored === 'object') return stored as Record<string, unknown>;
  if (typeof stored !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The steps one run has reported so far, in the order it reported them.
 *
 * An empty list is a real answer and the commonest one: a run that has not
 * reached its first step, a turn that answers with a plan and takes none, and
 * every run recorded before this table was written to. So this returns `[]`
 * rather than throwing when the table cannot be read -- the run status beside
 * it is still true and still worth serving, and a reconnect that failed
 * outright because the narration was unreadable would be a worse outcome than
 * a reconnect without narration.
 */
export async function readStageEvents(store: LakebaseReader, runId: string): Promise<Record<string, unknown>[]> {
  const rows = await stageQuery(
    store,
    { reported: false },
    'stage replay read',
    `SELECT payload FROM ${APP_SCHEMA}.run_events
      WHERE run_id = $1 AND event_type = $2
      ORDER BY seq
      LIMIT ${STAGE_REPLAY_LIMIT}`,
    [runId, STAGE_EVENT_TYPE]
  );
  if (rows === null) return [];
  return rows
    .map((row) => parsePayload(row.payload))
    .filter((payload): payload is Record<string, unknown> => payload !== null);
}

export interface StageRecorder {
  /** Files one step. Returns immediately: the run must never wait on its own narration. */
  record(stage: Record<string, unknown>): void;
  /** Resolves once every filed step has settled. For tests, and for nothing on the request path. */
  settled(): Promise<void>;
}

/**
 * The thing the ask route hands its stage hook.
 *
 * TWO PROPERTIES, AND BOTH ARE THE POINT.
 *
 * It does not block. The step is already on its way to the browser by the time
 * this is called, and a run that waited on a Lakebase round trip per step would
 * have made every question slower in order to help the minority of readers who
 * navigate away. So `record` returns at once and the write happens behind it.
 *
 * It preserves order. Appends are chained rather than issued in parallel, so
 * `seq` is dense and ascending in the order the run reported the steps. Fired
 * off concurrently they would land in whatever order the pool returned them,
 * and a replay ordered by `seq` would then be a replay of a run that never
 * happened in that order. The sequence is allocated on the calling side of the
 * chain so a slow write cannot renumber the steps behind it.
 */
export function createStageRecorder(store: LakebaseReader, runId: string): StageRecorder {
  // Shared across every append of this run, so an unreadable table is described
  // once rather than once per step.
  const reporter = { reported: false };
  let seq = 0;
  let tail: Promise<void> = Promise.resolve();
  return {
    record(stage) {
      seq += 1;
      const at = seq;
      tail = tail.then(() => recordStageEvent(store, { runId, seq: at, stage }, reporter)).then(() => undefined);
    },
    settled: () => tail,
  };
}
