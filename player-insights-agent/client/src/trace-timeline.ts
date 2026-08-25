/**
 * The arithmetic behind the inline trace panel, kept out of the component.
 *
 * What the agent actually records, which is what makes the geometry possible:
 * `TraceStage.start` is milliseconds from the run's own origin
 * (`(started - self.started) * 1000` off a `perf_counter`) and
 * `TraceStage.duration` is the measured elapsed of that step. Both come from
 * one monotonic clock shared with `TraceSummary.totalMs`, so offsets, widths
 * and the envelope are all on the same axis and can be compared directly.
 */
import type { TraceStage, TraceSummary } from './answer-shape';
import { withDisplayedStageStatus } from '../../shared/run-verdict';
import type { RunVerdict } from '../../shared/run-verdict';

/**
 * What a row was, in the vocabulary a reader thinks in.
 *
 * The agent records only two kinds, `agent` and `tool`, which collapses a model
 * call, a catalog lookup and a SQL query into one bucket and makes the roll-up
 * say almost nothing. The finer type here is derived from the recorded tool
 * name, which the stage id carries verbatim. It is a re-reading of something
 * measured, not a new measurement, and the panel says so on screen.
 */
export type ToolType = 'llm' | 'sql' | 'discovery' | 'plot' | 'clarify' | 'agent' | 'run';

/** Display order for the roll-up when two types tie on time. */
const TYPE_ORDER: ToolType[] = ['llm', 'sql', 'discovery', 'plot', 'clarify', 'agent', 'run'];

/**
 * Tool names the agent can call, mapped to the type a reader recognises.
 *
 * Keyed on the tool's real name as it appears in `_TOOL_STAGE_NAMES` in
 * agent.py. A name that is not here falls back to the stage's recorded `kind`,
 * so a tool added to the agent shows up as a plain tool row rather than being
 * silently filed under the wrong heading.
 */
const TOOL_TYPES: Record<string, ToolType> = {
  data_genie: 'sql',
  run_sql: 'sql',
  query_named_table: 'sql',
  dictionary_genie: 'discovery',
  describe_table: 'discovery',
  list_data_assets: 'discovery',
  resolve_table: 'discovery',
  // The two tools that narrow before anything is described. Both read metadata
  // rather than data, so they belong beside the listing rather than with the SQL
  // rows: filing them as unclassified would make the discovery roll-up under-report
  // exactly the step that is meant to be replacing the expensive one.
  search_tagged_assets: 'discovery',
  search_semantics: 'discovery',
  new_plot: 'plot',
};

/**
 * Kinds whose time is the sum of others' and so cannot be added to them.
 */
const CONTAINER_TYPES = new Set<ToolType>(['run']);

export interface TimelineRow {
  id: string;
  /** Position in the table, 1-based, matching the `step` column. */
  step: number;
  name: string;
  type: ToolType;
  status: TraceStage['status'];
  /** The tool's real arguments, or the run's question on the envelope row. */
  input: string;
  output: string;
  durationMs: number;
  /** Offset from the run origin, or null when the stage did not record one. */
  startMs: number | null;
  /** Left edge as a fraction of wall clock, or null when it cannot be known. */
  leftPct: number | null;
  /** Width as a fraction of wall clock, or null when it cannot be known. */
  widthPct: number | null;
  /** True for the run envelope, whose time is the sum of everything below it. */
  container: boolean;
}

export interface RollUpRow {
  type: ToolType;
  /** Time in steps that produced something. Excludes failed steps. */
  totalMs: number;
  /** Share of wall clock, or null when there is no measured wall clock. */
  sharePct: number | null;
  calls: number;
  /** Steps of this type that ended `partial`, counted in `totalMs` but flagged. */
  partialCalls: number;
  /** Time in steps of this type that failed. Reported apart, never added in. */
  failedMs: number;
  failedCalls: number;
}

export interface TimelineModel {
  rows: TimelineRow[];
  rollUp: RollUpRow[];
  /** The run envelope, or null when `totalMs` was not recorded. */
  wallClockMs: number | null;
  /**
   * Sum of every recorded stage, parents included, not just leaves.
   */
  recordedMs: number;
  /**
   * Wall clock less recorded activity, or null when either side is unknown.
   *
   * Negative when rows overlap, which real runs from this agent cannot do, see
   * `overlappingRows`. Computed rather than clamped, because a negative figure
   * is evidence about the data and a zero would be a claim about the run.
   *
   * NOTHING ON SCREEN READS THIS. It headed the run process panel until the
   * figures line was removed, and it is kept as a check on the recording that
   * trace-timeline.test.ts holds the seeded traces to -- the same standing as
   * `overlappingRows`. A timing discrepancy therefore surfaces in the test
   * suite and nowhere a reader would see it.
   */
  unaccountedMs: number | null;
  /** Time in steps that failed, across all types. Never inside `rollUp.totalMs`. */
  failedMs: number;
  failedRows: number;
  /** Steps that ended `partial` or were still running when the answer was built. */
  unsettledRows: number;
  measuredRows: number;
  totalRows: number;
  /** Whether every row carries a recorded start, and so whether bars are drawn. */
  everyRowMeasured: boolean;
  /** Whether the panel can position bars at all. */
  hasGeometry: boolean;
  /** Axis ticks, evenly spread across the true wall clock. */
  ticks: { label: string; pct: number }[];
  /** How many rows overlap another in time. Zero for a serial run. */
  overlappingRows: number;
}

/** Treats a non-finite or non-positive total as absent rather than as zero. */
function measuredTotal(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Above this, a `start` is an absolute clock rather than an offset into the run.
 *
 * 1e9 milliseconds is eleven and a half days, which no run reaches (`agent.py`
 * caps a run at `MAX_RUN_SECONDS`), while epoch milliseconds have been above it
 * since 2001 and epoch seconds since 2001 as well. So the two cases cannot be
 * confused in either direction by any value either could actually take.
 */
const ABSOLUTE_CLOCK_FLOOR = 1e9;

/**
 * The instant every position on the axis is measured from.
 *
 * The one place that decides what `start` means, so that a change in the
 * agent's convention is a change here and nowhere else. Today `agent.py` writes
 * `start=(started - self.started) * 1000` (milliseconds since the run's own
 * origin), so the origin is zero and this returns zero.
 */
export function runOrigin(stages: TraceStage[]): { origin: number; rebased: boolean } {
  const starts = stages.filter((stage) => stage.startMeasured !== false).map((stage) => stage.start);
  if (starts.length === 0) return { origin: 0, rebased: false };
  const earliest = Math.min(...starts);
  return earliest >= ABSOLUTE_CLOCK_FLOOR ? { origin: earliest, rebased: true } : { origin: 0, rebased: false };
}

/**
 * Statuses whose time was spent but produced nothing to attribute.
 *
 * A failed step still consumed wall clock, so it belongs in `recordedMs`. It
 * does not belong in a roll-up read as "where the time went", which a reader
 * takes as a breakdown of work that happened: an endpoint that timed out for
 * eight seconds is not eight seconds of inference. Counted separately and
 * named on the tile, rather than folded in or dropped.
 */
const UNPRODUCTIVE: ReadonlySet<TraceStage['status']> = new Set(['failed']);

/** Statuses that must not be drawn as a finished bar. */
export function isSettled(status: TraceStage['status']): boolean {
  return status === 'complete';
}

/**
 * The tool name inside a stage id.
 *
 * Tool stages are keyed `step-{n}-{index}-{name}` in agent.py, so the name is
 * everything after the second numeric segment. Anything that does not match
 * that shape returns empty and the caller falls back to the recorded kind.
 */
export function toolNameFromId(id: string): string {
  const match = /^step-\d+-\d+-(.+)$/.exec(id);
  return match ? match[1] : '';
}

/**
 * What a stage was, from what the agent recorded about it.
 *
 * Reads identity, never timing. Nothing here can change a duration or a
 * position; the worst a wrong answer does is file a row under the wrong heading
 * in the roll-up, where the time itself is still the measured one.
 */
export function stageType(stage: Pick<TraceStage, 'id' | 'kind'>): ToolType {
  if (stage.id === 'plot') return 'plot';
  // The synthesis call and each loop turn are model calls: `_synthesize` and the
  // loop both time a `chat.completions.create` and nothing else.
  if (stage.id === 'synthesis' || /^step-\d+$/.test(stage.id)) return 'llm';
  if (stage.id.endsWith('-clarify')) return 'clarify';
  const tool = toolNameFromId(stage.id);
  if (tool && TOOL_TYPES[tool]) return TOOL_TYPES[tool];
  // The agent now records sql / discovery / plot / genie on the stage itself.
  // A tool added there but not yet listed above still lands on the heading the
  // agent already chose, instead of disappearing into the unclassified bucket.
  if (stage.kind === 'sql' || stage.kind === 'discovery' || stage.kind === 'plot') return stage.kind;
  if (stage.kind === 'genie') return 'sql';
  return 'agent';
}

/**
 * Milliseconds as the notebook prints them: whole milliseconds below a second,
 * two decimals and an `s` above it. `78ms`, `1.18s`, `24.01s`.
 *
 * Sub-millisecond values keep two decimals instead of rounding. The recorded
 * traces reconcile to within about a millisecond (0.942ms on one run, 0.513ms
 * on another), and that remainder is the panel's own evidence that the figures
 * add up. Rounded to `0ms` it would read as a suspiciously perfect zero; at
 * `0.94ms` it reads as what it is, a real measurement of a real gap.
 */
export function formatMs(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude < 1) return `${value.toFixed(2)}ms`;
  if (magnitude < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

/** Soft cap so the event column stays one line, matching the notebook viz. */
const EVENT_SNIPPET_MAX = 52;

/**
 * Clips a payload fragment the way the notebook event column does.
 *
 * Whole words are not required: the notebook truncates mid-token with an
 * ellipsis, and the full value still lives in the expanded Arguments row.
 */
export function clipEventSnippet(text: string, max = EVENT_SNIPPET_MAX): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * The short payload that rides next to a tool name on the explorer event line.
 *
 * Prefers the fields the notebook itself surfaces (`full_name`, SQL, question)
 * over dumping the whole JSON blob when those keys are present.
 */
export function toolPayloadSnippet(input: string): string {
  const raw = input.trim();
  if (!raw || raw === '{}') return '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['full_name', 'sql', 'query', 'question', 'name', 'catalog', 'schema'] as const) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return clipEventSnippet(value);
      }
      return clipEventSnippet(JSON.stringify(parsed));
    }
  } catch {
    // Not JSON: fall through and clip the recorded text.
  }
  return clipEventSnippet(raw);
}

/**
 * 1-based turn index for every LLM row, in table order.
 *
 * The notebook numbers model calls as "turn N" across the run. Synthesis is a
 * model call too, so it takes the next number after `step-N` rows rather than a
 * separate label that would disagree with that viz.
 */
export function llmTurnByRowId(rows: readonly Pick<TimelineRow, 'id' | 'type' | 'container'>[]): Map<string, number> {
  const turns = new Map<string, number>();
  let next = 1;
  for (const row of rows) {
    if (row.container || row.type !== 'llm') continue;
    turns.set(row.id, next);
    next += 1;
  }
  return turns;
}

/**
 * Event text for Run Explorer's Timeline, in the notebook's vocabulary.
 *
 * Ask keeps the stakeholder stage names (`Queried governed data`). Explorer
 * shows the tool / model identity Acme's viz uses so a reader can match the
 * two side by side. Timing and kinds are unchanged; only the label string moves.
 */
export function explorerEventLabel(
  row: Pick<TimelineRow, 'id' | 'type' | 'name' | 'input' | 'container'>,
  turns: ReadonlyMap<string, number>
): string {
  if (row.container || row.type === 'run') return 'run - [orchestrator]';
  if (row.type === 'llm') {
    const turn = turns.get(row.id) ?? 1;
    return `model call - [orchestrator] turn ${turn}`;
  }
  if (row.type === 'clarify' || row.id.endsWith('-clarify')) {
    const asked = toolPayloadSnippet(row.input);
    return asked ? `clarify ${asked}` : 'clarify - [orchestrator]';
  }
  if (row.type === 'plot' || row.id === 'plot') {
    const payload = toolPayloadSnippet(row.input);
    return payload ? `new_plot ${payload}` : 'new_plot';
  }
  const tool = toolNameFromId(row.id);
  if (tool) {
    const payload = toolPayloadSnippet(row.input);
    return payload ? `${tool} ${payload}` : tool;
  }
  // Unclassified agent rows (orchestrator, data_source_finder, …): keep the
  // recorded name rather than inventing a rival vocabulary.
  return row.name;
}

/**
 * Six ticks across the true wall clock, at the fifths the notebook uses.
 *
 * Derived from the measured envelope rather than rounded to a friendly
 * interval, so the last tick is the run's real duration and the axis cannot
 * imply a longer or shorter run than the one that happened.
 */
function buildTicks(wallClockMs: number | null): { label: string; pct: number }[] {
  if (wallClockMs === null) return [];
  return [0, 1, 2, 3, 4, 5].map((slot) => ({
    label: slot === 0 ? '+0ms' : `+${formatMs((wallClockMs * slot) / 5)}`,
    pct: slot * 20,
  }));
}

/**
 * Counts rows that overlap another in time.
 *
 * The agent loop is a plain `for` loop of blocking calls, so a real run cannot
 * produce an overlap and this should be zero. Measured rather than assumed
 * because a step row that had turned into a true container, spanning the
 * children it is charged separately for, would appear here as an overlap
 * instead of quietly double-counting in the roll-up. Nothing on screen reads
 * it: it is a check on the recording, and the seeded traces are held to zero.
 */
function countOverlaps(rows: TimelineRow[]): number {
  const spans = rows
    .filter((row) => !row.container && row.startMs !== null)
    .map((row) => ({ from: row.startMs as number, to: (row.startMs as number) + row.durationMs }))
    .sort((left, right) => left.from - right.from);
  let overlapping = 0;
  // Against the furthest end reached so far, not against the previous row.
  // A container is the case this exists to catch and the one the predecessor
  // comparison misses: [0,100] over [10,20], [30,40] and [50,60] caught only
  // the first child, because the two after it begin later than that child
  // ended and so read as serial.
  let furthestEnd = -Infinity;
  for (const span of spans) {
    // Touching edges are not an overlap: one call returning at the microsecond
    // the next begins is exactly what a serial loop looks like.
    if (span.from < furthestEnd) overlapping += 1;
    if (span.to > furthestEnd) furthestEnd = span.to;
  }
  return overlapping;
}

/**
 * Turns a recorded trace into everything the panel draws.
 *
 * `question` is the run's own prompt, shown on the envelope row. It is display
 * text rather than a measurement. `verdict` is the run's answer status: when
 * that is Complete, a synthesis span the agent stored as `partial` (optional
 * DSF clip on a finished listing) is shown as complete, so this panel cannot
 * disagree with Ask.
 */
export function buildTimeline(
  trace: TraceSummary | null | undefined,
  question = '',
  verdict?: RunVerdict
): TimelineModel {
  const stages = [...withDisplayedStageStatus(trace?.stages ?? [], verdict)];
  const wallClockMs = measuredTotal(trace?.totalMs);
  const { origin } = runOrigin(stages);

  const rows: TimelineRow[] = [];

  // The envelope row, and only when the run actually reported a total. It is the
  // one row not taken from a stage, and it is still a measurement: `totalMs` is
  // read off the same clock as every `start` below it, at the point the answer
  // was assembled. Without a total there is nothing to draw it against, and a
  // synthesised envelope spanning the last stage's end would be a guess at the
  // one number the whole axis is scaled by.
  if (wallClockMs !== null) {
    rows.push({
      id: '__run__',
      step: 1,
      name: 'Orchestrator run',
      type: 'run',
      status: 'complete',
      input: question,
      output: '',
      durationMs: wallClockMs,
      startMs: 0,
      leftPct: 0,
      widthPct: 100,
      container: true,
    });
  }

  for (const stage of stages) {
    const measured = stage.startMeasured !== false;
    const startMs = measured ? stage.start - origin : null;
    rows.push({
      id: stage.id,
      step: rows.length + 1,
      name: stage.name,
      type: stageType(stage),
      status: stage.status,
      input: stage.input,
      output: stage.output,
      durationMs: stage.duration,
      startMs,
      // Positions exist only when there is both a measured start and an
      // envelope to scale it against. Either missing means no bar for this row;
      // the duration column still carries the true value.
      leftPct: startMs !== null && wallClockMs !== null ? (startMs / wallClockMs) * 100 : null,
      widthPct: startMs !== null && wallClockMs !== null ? (stage.duration / wallClockMs) * 100 : null,
      container: false,
    });
  }

  const counted = rows.filter((row) => !CONTAINER_TYPES.has(row.type));
  const recordedMs = counted.reduce((total, row) => total + row.durationMs, 0);

  type Tally = { totalMs: number; calls: number; partialCalls: number; failedMs: number; failedCalls: number };
  const totals = new Map<ToolType, Tally>();
  for (const row of counted) {
    const existing: Tally = totals.get(row.type) ?? {
      totalMs: 0,
      calls: 0,
      partialCalls: 0,
      failedMs: 0,
      failedCalls: 0,
    };
    if (UNPRODUCTIVE.has(row.status)) {
      // Kept out of the attributed time and counted where it can be seen. Time
      // spent failing is real, and it is reconciled at the top of the panel; it
      // is just not an answer to "where did the time go" in the sense a reader
      // means when they read a column headed with a tool type.
      existing.failedMs += row.durationMs;
      existing.failedCalls += 1;
    } else {
      existing.totalMs += row.durationMs;
      // One row is one call. Deliberately not `stage.calls`, which on a step row
      // counts the tool calls that turn requested: a different quantity, and
      // adding it here would report five model calls where four were made.
      existing.calls += 1;
      if (row.status !== 'complete') existing.partialCalls += 1;
    }
    totals.set(row.type, existing);
  }

  const rollUp: RollUpRow[] = [...totals.entries()]
    .map(([type, value]) => ({
      type,
      totalMs: value.totalMs,
      sharePct: wallClockMs === null ? null : (value.totalMs / wallClockMs) * 100,
      calls: value.calls,
      partialCalls: value.partialCalls,
      failedMs: value.failedMs,
      failedCalls: value.failedCalls,
    }))
    .sort((left, right) => right.totalMs - left.totalMs || TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type));

  const failed = counted.filter((row) => UNPRODUCTIVE.has(row.status));

  const measuredRows = rows.filter((row) => row.startMs !== null).length;

  return {
    rows,
    rollUp,
    wallClockMs,
    recordedMs,
    // Null rather than zero when there is no envelope to subtract from. A zero
    // here reads as a run with nothing unaccounted for, which is a measurement
    // nobody took.
    unaccountedMs: wallClockMs === null ? null : wallClockMs - recordedMs,
    failedMs: failed.reduce((total, row) => total + row.durationMs, 0),
    failedRows: failed.length,
    unsettledRows: counted.filter((row) => !isSettled(row.status) && !UNPRODUCTIVE.has(row.status)).length,
    measuredRows,
    totalRows: rows.length,
    everyRowMeasured: rows.length > 0 && measuredRows === rows.length,
    // Bars need an envelope to scale against and at least one measured start.
    hasGeometry: wallClockMs !== null && measuredRows > 0,
    ticks: buildTicks(wallClockMs),
    overlappingRows: countOverlaps(rows),
  };
}
