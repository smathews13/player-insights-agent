/**
 * The boundary between what the wire can carry and what the UI is allowed to assume.
 */

import { isAnswerProvenance, type AnswerProvenance } from '../../shared/answer-provenance';

export type StageStatus = 'complete' | 'partial' | 'failed' | 'running';

export interface TraceStage {
  id: string;
  name: string;
  kind: string;
  start: number;
  duration: number;
  status: StageStatus;
  calls: number;
  input: string;
  output: string;
  depth?: number;
  parent_id?: string;
  /**
   * Whether `start` was actually present on the wire, rather than defaulted.
   *
   * `start` is coerced to 0 when absent, and 0 is also a legitimate start, so
   * the number alone cannot distinguish a measured origin from a missing one.
   * The inline timeline draws bar positions from `start` under a caption that
   * calls them exact, so it needs to know the difference.
   */
  startMeasured?: boolean;
}

export interface TraceSummary {
  id: string;
  totalMs: number;
  toolCalls: number;
  stages: TraceStage[];
}

export interface Figure {
  label: string;
  value: number;
  display?: string;
  comparison: string;
}

export interface SourceRef {
  name: string;
  freshness: string;
}

/** A stage as it may actually arrive: every field optional, nothing trusted. */
type WireStage = Partial<Record<keyof TraceStage, unknown>>;

/**
 * An answer as it may actually arrive.
 */
export interface WireAnswer {
  type?: 'answer';
  id?: unknown;
  mode?: unknown;
  provenance?: unknown;
  takeaway?: unknown;
  narrative?: unknown;
  figures?: unknown;
  charts?: unknown;
  sources?: unknown;
  caveats?: unknown;
  sql?: unknown;
  trace?: unknown;
  runStored?: unknown;
}

const STAGE_STATUSES = new Set<StageStatus>(['complete', 'partial', 'failed', 'running']);

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Rejects NaN and Infinity as well as non-numbers: both format as garbage. */
function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStageStatus(value: unknown): StageStatus {
  return typeof value === 'string' && STAGE_STATUSES.has(value as StageStatus) ? (value as StageStatus) : 'complete';
}

/**
 * Stage ids are React keys and the parent lookup for nesting, so a stage without
 * one gets a positional id rather than `undefined`, duplicate keys silently drop
 * siblings from the timeline.
 */
export function normalizeStage(raw: unknown, index: number): TraceStage {
  const stage = (raw ?? {}) as WireStage;
  const normalized: TraceStage = {
    id: asString(stage.id) || `stage-${index}`,
    name: asString(stage.name, 'Unnamed step'),
    kind: asString(stage.kind, 'agent'),
    start: asFiniteNumber(stage.start),
    duration: asFiniteNumber(stage.duration),
    status: asStageStatus(stage.status),
    calls: asFiniteNumber(stage.calls),
    input: asString(stage.input),
    output: asString(stage.output),
  };
  // Only carried through when present: the timeline distinguishes "depth 0" from
  // "this model version does not report depth", and defaulting erases that.
  if (typeof stage.depth === 'number' && Number.isFinite(stage.depth)) normalized.depth = stage.depth;
  if (typeof stage.parent_id === 'string' && stage.parent_id) normalized.parent_id = stage.parent_id;
  // Whether `start` was a real number on the wire, recorded because the line
  // above cannot say so afterwards: a missing start and a start of zero both
  // arrive here as 0, and the first stage of every run legitimately starts at 0.
  //
  // The Gantt draws bar left edges from `start` and captions them as exact. If a
  // model version stopped reporting starts, every bar would silently stack at
  // the left margin under a caption promising measurement: the one failure
  // that would be worse than drawing no bars at all. This flag lets the timeline
  // refuse to draw rather than draw a fiction.
  normalized.startMeasured = typeof stage.start === 'number' && Number.isFinite(stage.start);
  return normalized;
}

export function normalizeTrace(raw: unknown): TraceSummary {
  const trace = (raw ?? {}) as Record<string, unknown>;
  return {
    id: asString(trace.id),
    totalMs: asFiniteNumber(trace.totalMs),
    toolCalls: asFiniteNumber(trace.toolCalls),
    stages: asArray(trace.stages).map(normalizeStage),
  };
}

/**
 * Figures drive a bar width, so a non-numeric value would render as a NaN-wide
 * bar. A figure with no label is dropped rather than shown blank: an unlabelled
 * number in a "Result breakdown" is worse than one fewer row.
 */
function normalizeFigures(raw: unknown): Figure[] {
  return asArray(raw)
    .map((entry) => {
      const figure = (entry ?? {}) as Record<string, unknown>;
      const label = asString(figure.label);
      if (!label) return null;
      const normalized: Figure = {
        label,
        value: asFiniteNumber(figure.value),
        comparison: asString(figure.comparison),
      };
      if (typeof figure.display === 'string') normalized.display = figure.display;
      return normalized;
    })
    .filter((figure): figure is Figure => figure !== null);
}

function normalizeSources(raw: unknown): SourceRef[] {
  return asArray(raw)
    .map((entry) => {
      const source = (entry ?? {}) as Record<string, unknown>;
      const name = asString(source.name);
      return name ? { name, freshness: asString(source.freshness) } : null;
    })
    .filter((source): source is SourceRef => source !== null);
}

/** Caveats are joined into a sentence, so a non-string entry would print `[object Object]`. */
function normalizeCaveats(raw: unknown): string[] {
  return asArray(raw)
    .map((entry) => asString(entry).trim())
    .filter((entry) => entry.length > 0);
}

export interface NormalizedAnswer {
  type?: 'answer';
  id: string;
  mode: 'live' | 'representative';
  /**
   * Which parts of this answer came from the run, when the server said.
   *
   * Optional, and absent means absent: an answer stored before the server
   * started stating this, or served by one that does not. Defaulting it would
   * make silence indistinguishable from a claim, and the whole point of the
   * field is that only one path is allowed to claim 'live'. See
   * shared/answer-provenance.ts and `answerContentProvenance`.
   */
  provenance?: AnswerProvenance;
  takeaway: string;
  narrative: string;
  figures: Figure[];
  charts?: unknown;
  sources: SourceRef[];
  caveats: string[];
  sql: string;
  trace: TraceSummary;
  /**
   * Whether the run behind this answer reached Lakebase, when the wire said.
   *
   * Only ever `false`, and only on a live reply whose write failed. Absent means
   * stored: every answer reloaded from a conversation is by definition a stored
   * row, and none of them carry this key. So the deep link is offered unless the
   * answer explicitly says there is nothing to link to.
   */
  runStored?: false;
}

/**
 * Fills every field the UI reads, so no render path can meet an absent one.
 *
 * `mode` falls back to 'representative' rather than 'live': an answer whose
 * provenance did not survive the wire is exactly the answer that must not be
 * badged as a live agent response.
 */
export function normalizeAnswer(raw: WireAnswer): NormalizedAnswer {
  const normalized: NormalizedAnswer = {
    id: asString(raw.id),
    mode: raw.mode === 'live' ? 'live' : 'representative',
    takeaway: asString(raw.takeaway, 'The agent returned an answer with no summary line.'),
    narrative: asString(raw.narrative),
    figures: normalizeFigures(raw.figures),
    sources: normalizeSources(raw.sources),
    caveats: normalizeCaveats(raw.caveats),
    sql: asString(raw.sql),
    trace: normalizeTrace(raw.trace),
  };
  if (raw.type === 'answer') normalized.type = 'answer';
  // Only the three the server can mean. A value this build does not recognise
  // is dropped rather than passed through, so a newer server cannot get an
  // unknown word treated as if it were 'live' by a check written as `!== 'mixed'`.
  if (isAnswerProvenance(raw.provenance)) normalized.provenance = raw.provenance;
  if (raw.runStored === false) normalized.runStored = false;
  // Left untouched and unvalidated: AnswerCharts has its own boundary, and a
  // chart this function silently reshaped would fail there in a way that points
  // at the wrong file.
  if (raw.charts !== undefined) normalized.charts = raw.charts;
  return normalized;
}

/** The clarification path reads the same trace shape and can miss it the same way. */
export function normalizeClarification(raw: unknown) {
  const clarification = (raw ?? {}) as Record<string, unknown>;
  return {
    id: asString(clarification.id),
    question: asString(clarification.question, 'The agent needs more detail before it can answer.'),
    reason: typeof clarification.reason === 'string' ? clarification.reason : undefined,
    options: normalizeCaveats(clarification.options),
    trace: normalizeTrace(clarification.trace),
  };
}
