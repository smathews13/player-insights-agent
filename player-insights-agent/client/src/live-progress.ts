/**
 * What to show while a run is still going, said only from what has been
 * observed.
 *
 * 1. the request was sent;
 * 2. the endpoint accepted it and opened the stream (the route writes `: open`
 *    before it calls the agent, so this is a real event with a real time);
 * 3. how long each of those has been true.
 *
 * Nothing else. There is no step to name, so none is named: no "Planning…",
 * no "Analysing…", no percentage. The four hardcoded stage names that used to
 * drive the progress bar were removed for exactly this reason and must not
 * return under a new name; see progress-labels.ts.
 */
import type { TraceStage } from './answer-shape';
import { stageType, toolNameFromId, type ToolType } from './trace-timeline';
import { describePayload } from './trace-payload';

/**
 * How far a run has got, in terms of what the browser has actually seen.
 *
 * `sending` and `accepted` are distinguishable because the route opens the
 * stream before invoking the agent, so "the server has this" is a fact rather
 * than an assumption about elapsed time.
 */
export type RunPhase = 'sending' | 'accepted' | 'reporting';

/** One reported step, with what it did read off its own record. */
export interface LiveStep {
  id: string;
  name: string;
  type: ToolType;
  status: TraceStage['status'];
  /** Measured duration of the step. */
  durationMs: number;
  /** Offset into the run, or null when the stage carried no measured start. */
  startMs: number | null;
  /**
   * What this step was actually given: the Genie question, the SQL, the table.
   * Empty when the stage recorded nothing, in which case the row shows nothing
   * rather than a placeholder.
   */
  detail: string;
  /** What came back, clamped for the rail. Empty when nothing was recorded. */
  result: string;
  calls: number;
  depth: number;
}

export interface LiveRun {
  phase: RunPhase;
  /**
   * The sentence under the elapsed counter. True in every phase, including the
   * first one, where the only true thing is that the question is in flight.
   */
  detail: string;
  steps: LiveStep[];
  /**
   * Wall-clock milliseconds since the newest step arrived in the browser, or
   * null before any has.
   */
  quietMs: number | null;
  /**
   * Whether the run is demonstrably further along than this list, and by how
   * much, or null when it cannot be shown to be.
   *
   * Computed rather than asserted so that it stops being said the moment it
   * stops being true. If the buffering this was written for is ever fixed
   * upstream, this goes quiet on its own instead of leaving a stale sentence
   * on screen that nobody thinks to re-check.
   */
  lag: { openMs: number; reportedToMs: number } | null;
}

/** Past this, the gap is the transport rather than the endpoint's own startup. */
const LAG_FLOOR_MS = 3_000;

/** Longest recorded value shown inline on a step row. */
const DETAIL_LIMIT = 180;

/**
 * A recorded string, shortened for a one-line row and marked when shortened.
 *
 * The ellipsis is load-bearing. The expanded trace shows these fields whole and
 * says so; a silently cut Genie question here would have the two views quietly
 * disagreeing about what was asked.
 */
function clamp(value: string, limit = DETAIL_LIMIT): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

/** One named argument out of a recorded payload, or '' when it is not there. */
function field(payload: string, key: string): string {
  const described = describePayload(payload);
  const found = described.fields?.find((entry) => entry.key === key);
  return found ? found.value : '';
}

/**
 * Every argument as `key: value`, for a tool this module does not know by name.
 *
 * An object with no keys returns nothing rather than `{}`. The agent records
 * `json.dumps({})` for a tool called without arguments, and printing that on a
 * row reads as a malfunction rather than as "it was called with none".
 */
function allFields(payload: string): string {
  const described = describePayload(payload);
  if (described.empty) return '';
  if (!described.fields) return described.body.trim() === '{}' ? '' : described.body;
  return described.fields.map((entry) => `${entry.key}: ${entry.value}`).join(' \u00b7 ');
}

/**
 * What a step was given, in a sentence.
 *
 * Every branch reads a recorded field. A tool whose name is not listed falls
 * through to its arguments verbatim, so a tool added to the agent shows up with
 * its real arguments rather than with nothing or with a guess at what it does.
 */
export function describeStage(stage: TraceStage, question = ''): string {
  const tool = toolNameFromId(stage.id);
  switch (tool) {
    case 'data_genie':
      return quoted('Asked the governed data Genie space', field(stage.input, 'question'));
    case 'dictionary_genie':
      return quoted('Asked the data dictionary Genie space', field(stage.input, 'question'));
    case 'run_sql':
      return prefixed('Ran a read-only query', field(stage.input, 'sql'));
    case 'query_named_table':
      return prefixed('Queried the table it was given', allFields(stage.input));
    case 'describe_table': {
      const table = clamp(field(stage.input, 'full_name'));
      return table ? `Read the columns of ${table}` : 'Read a table\u2019s columns';
    }
    case 'list_data_assets': {
      const scope = allFields(stage.input);
      return scope
        ? `Listed the tables it may read under ${clamp(scope)}`
        : 'Listed every table it is permitted to read';
    }
    default:
      // A tool this module has no wording for still shows what it was given.
      // The alternative is a row that says only its category, which is what
      // this change exists to get away from, and a tool added to the agent
      // must not silently degrade to that.
      if (tool) return clamp(allFields(stage.input));
      break;
  }

  if (stage.id.endsWith('-clarify')) {
    return quoted('Stopped to ask you', field(stage.input, 'question') || stage.output);
  }

  // A model turn records the tool calls it decided on as its output, which is
  // the most useful thing on screen while the run is going: it names what is
  // about to happen, from the run's own record, before that work reports.
  if (/^step-\d+$/.test(stage.id) && stage.output) {
    const chose = stage.output
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    if (chose.length > 0 && chose.every((name) => /^[a-z_][a-z0-9_]*$/.test(name))) {
      return `Chose to call ${chose.join(' and ')}`;
    }
  }

  // Anything else: the recorded input, unless it is the question being asked,
  // which the reader is already looking at further up the page.
  const input = clamp(stage.input);
  if (input && input !== clamp(question)) return input;
  return clamp(stage.output);
}

function quoted(lead: string, value: string): string {
  const text = clamp(value);
  return text ? `${lead}: \u201c${text}\u201d` : lead;
}

function prefixed(lead: string, value: string): string {
  const text = clamp(value);
  return text ? `${lead}: ${text}` : lead;
}

/**
 * What a step returned, for the second line of its row.
 *
 * Only for tool steps. A model turn's output is either the tool names (already
 * used as the detail above), or the prose it is about to answer with, and
 * putting the answer in the progress rail spoils it and doubles it.
 */
function describeResult(stage: TraceStage): string {
  if (stage.kind !== 'tool') return '';
  return clamp(stage.output, 140);
}

export function toLiveStep(stage: TraceStage, question = ''): LiveStep {
  return {
    id: stage.id,
    name: stage.name,
    type: stageType(stage),
    status: stage.status,
    durationMs: stage.duration,
    startMs: stage.startMeasured === false ? null : stage.start,
    detail: describeStage(stage, question),
    result: describeResult(stage),
    calls: stage.calls,
    depth: Math.min(stage.depth ?? 0, 3),
  };
}

/**
 * Everything the panel draws, from what has been observed and nothing else.
 *
 * `openedAt` is when the stream's opening bytes arrived, `lastStageAt` when the
 * newest stage did. Both are wall-clock instants recorded by the caller as they
 * happened; neither is estimated, and when one is absent the corresponding
 * claim is simply not made.
 */
export function buildLiveRun({
  openedAt,
  lastStageAt,
  now,
  stages,
  question = '',
}: {
  openedAt: number | null;
  lastStageAt: number | null;
  now: number;
  stages: TraceStage[];
  question?: string;
}): LiveRun {
  const steps = stages.map((stage) => toLiveStep(stage, question));

  if (steps.length > 0) {
    const newest = steps[steps.length - 1];
    const reportedToMs = newest.startMs === null ? null : newest.startMs + newest.durationMs;
    const openMs = openedAt === null ? null : now - openedAt;
    const behind =
      openMs !== null && reportedToMs !== null && openMs - reportedToMs > LAG_FLOOR_MS
        ? { openMs, reportedToMs }
        : null;
    return {
      phase: 'reporting',
      detail: `${steps.length} step${steps.length === 1 ? '' : 's'} reported so far. The newest one the endpoint sent was “${newest.name}”.`,
      steps,
      quietMs: lastStageAt === null ? null : Math.max(0, now - lastStageAt),
      lag: behind,
    };
  }

  if (openedAt !== null) {
    return {
      phase: 'accepted',
      // Says what is true and what is not yet known, and nothing about which
      // step is running: the endpoint has not said, and it is the endpoint's
      // record of its own run that this panel exists to show.
      detail:
        'The agent endpoint has your question and the run has started. Each step is reported only once it has finished, so the first one appears when the agent finishes it, not before.',
      steps,
      quietMs: null,
      lag: null,
    };
  }

  return {
    phase: 'sending',
    // "Nothing has come back yet" rather than "nothing has run yet". A server
    // that will not stream (a stale build, a proxy that drops
    // `text/event-stream`), answers this request in one lump at the end, and
    // the run is well under way while this line is on screen. What is true in
    // every case is that no response has arrived.
    detail: 'Sending your question to the agent endpoint. Nothing has come back yet.',
    steps,
    quietMs: null,
    lag: null,
  };
}
