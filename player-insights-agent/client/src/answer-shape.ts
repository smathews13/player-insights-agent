/**
 * The boundary between what the wire can carry and what the UI is allowed to assume.
 */

import { isAnswerProvenance, type AnswerProvenance } from '../../shared/answer-provenance';
import { normalizeReaderStageStatus, projectReaderStage, type ReaderStageStatus } from '../../shared/stage-lexicon';
import type { AnalyticalExecution } from './analytical-execution';
import type { StepTokenUsage, TokenInvocationUsage, TokenReconciliation } from '../../shared/llm-token-usage';

export type StageStatus = ReaderStageStatus;

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
  /** Fully-qualified tables enumerated by this discovery step. */
  tables?: string[];
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
  /** Direct LLM invocation usage attributed from MLflow spans. */
  token_usage?: StepTokenUsage;
}

export interface TraceSummary {
  id: string;
  totalMs: number;
  toolCalls: number;
  stages: TraceStage[];
  /** Sum of chat-completions prompt tokens this turn; 0 when unmetred. */
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  token_invocations?: TokenInvocationUsage[];
  token_reconciliation?: TokenReconciliation;
}

export interface Figure {
  label: string;
  value: number;
  display?: string;
  comparison: string;
}

/**
 * What the run read a table for. See `Source.role` in the agent's contracts.
 *
 * `reading` is a table a value-returning query read, `reference` is one read for
 * a definition or a column list. Absent means the answer states no role, which
 * is every answer produced before the agent published one. Absent is carried as
 * absent, never defaulted to either word: the app cannot tell from a name, and a
 * default here would print a guess as a fact under a table.
 */
export type SourceRole = 'reading' | 'reference';

export interface SourceRef {
  name: string;
  freshness: string;
  role?: SourceRole;
}

export interface DocumentSnippet {
  filename: string;
  quote: string;
  supports: string;
}

/**
 * What one statement of the run measured, over what, from where.
 *
 * The agent derives these four from the parse of the statement it executed, so
 * they are facts about the query rather than sentences about it. Every field can
 * be empty and empty means the statement did not say: a query with no WHERE
 * clause has no window, and a Genie statement whose tables could not be resolved
 * has no source.
 *
 * A RENDERER MUST DRAW AN EMPTY FIELD AS NOTHING. Not as "unknown", and above
 * all not as "all time" or "no filter": those are claims about the population
 * behind a figure, and nothing in the run checked them.
 */
export interface Derivation {
  source: string;
  metric: string;
  window: string;
  filter: string;
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
  /**
   * Reader headline. New producers should put only the concise answer here
   * (for example, "42 million unique users").
   */
  takeaway?: unknown;
  /**
   * Supporting context. New producers should send Markdown list items here so
   * they render directly below the takeaway; legacy prose remains valid.
   */
  narrative?: unknown;
  content?: unknown;
  figures?: unknown;
  charts?: unknown;
  sources?: unknown;
  document_snippets?: unknown;
  caveats?: unknown;
  derivation?: unknown;
  sql?: unknown;
  trace?: unknown;
  runStored?: unknown;
  execution_identity?: unknown;
  /**
   * The same claim under the name this file gives it after normalizing.
   *
   * Declared because an answer comes back through here a second time. The
   * transcript keeps each turn as the message row it will be reloaded as, and
   * for the turn that just ran it puts the NORMALIZED answer in that row, so
   * every render normalizes it again. Every other field survives that because
   * its wire name and its normalized name are the same word; this one is the
   * single field that is renamed on the way through, so it alone was dropped on
   * the second pass -- and the drop happened one render after the answer landed,
   * which is why a live answer appeared to state its identity and then quietly
   * stopped.
   */
  executionIdentity?: unknown;
}

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
  return normalizeReaderStageStatus(value);
}

function normalizedStepTokenUsage(value: unknown): StepTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const cacheStatus = usage.cacheStatus;
  const attempts = usage.attempts;
  if (
    !['used', 'not-used', 'unavailable'].includes(String(cacheStatus)) ||
    typeof attempts !== 'number' ||
    !Number.isInteger(attempts) ||
    attempts < 1
  ) {
    return undefined;
  }
  const normalized: StepTokenUsage = {
    cacheStatus: cacheStatus as StepTokenUsage['cacheStatus'],
    attempts,
    totalMismatch: usage.totalMismatch === true,
  };
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cacheWriteTokens'] as const) {
    const count = usage[key];
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0) normalized[key] = count;
  }
  return normalized;
}

function normalizedTokenInvocation(value: unknown): TokenInvocationUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const usage = normalizedStepTokenUsage(record);
  if (
    !usage ||
    typeof record.invocationId !== 'string' ||
    !record.invocationId ||
    typeof record.stageId !== 'string' ||
    !record.stageId ||
    typeof record.attempt !== 'number' ||
    !Number.isInteger(record.attempt) ||
    record.attempt < 1
  ) {
    return undefined;
  }
  return {
    ...usage,
    invocationId: record.invocationId,
    stageId: record.stageId,
    attempt: record.attempt,
  };
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
  if (Array.isArray(stage.tables)) {
    normalized.tables = stage.tables
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim())
      .filter((name, index, names) => name.length > 0 && names.indexOf(name) === index);
  }
  const tokenUsage = normalizedStepTokenUsage(stage.token_usage);
  if (tokenUsage) normalized.token_usage = tokenUsage;
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
  return projectReaderStage(normalized);
}

export function normalizeTrace(raw: unknown): TraceSummary {
  const trace = (raw ?? {}) as Record<string, unknown>;
  const normalized: TraceSummary = {
    id: asString(trace.id),
    totalMs: asFiniteNumber(trace.totalMs),
    toolCalls: asFiniteNumber(trace.toolCalls),
    stages: asArray(trace.stages).map(normalizeStage),
  };
  // Only carried through when present: a stored answer from before metering
  // must not gain a fabricated 0 that looks like a measured free run.
  if (typeof trace.prompt_tokens === 'number' && Number.isFinite(trace.prompt_tokens)) {
    normalized.prompt_tokens = trace.prompt_tokens;
  }
  if (typeof trace.completion_tokens === 'number' && Number.isFinite(trace.completion_tokens)) {
    normalized.completion_tokens = trace.completion_tokens;
  }
  if (typeof trace.total_tokens === 'number' && Number.isFinite(trace.total_tokens)) {
    normalized.total_tokens = trace.total_tokens;
  }
  const invocations = asArray(trace.token_invocations)
    .map(normalizedTokenInvocation)
    .filter((item): item is TokenInvocationUsage => item !== undefined);
  if (invocations.length > 0) normalized.token_invocations = invocations;
  if (trace.token_reconciliation && typeof trace.token_reconciliation === 'object') {
    normalized.token_reconciliation = trace.token_reconciliation as TokenReconciliation;
  }
  return normalized;
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
      if (!name) return null;
      // Only the two words the contract defines. Anything else, including the
      // empty string the agent sends for "unstated", leaves the role off.
      const role = asString(source.role);
      return {
        name,
        freshness: asString(source.freshness),
        ...(role === 'reading' || role === 'reference' ? { role } : {}),
      };
    })
    .filter((source): source is SourceRef => source !== null);
}

function normalizeDocumentSnippets(raw: unknown): DocumentSnippet[] {
  return asArray(raw)
    .map((entry) => {
      const snippet = (entry ?? {}) as Record<string, unknown>;
      const filename = asString(snippet.filename).trim();
      const quote = asString(snippet.quote).trim();
      const supports = asString(snippet.supports).trim();
      return filename && quote && supports ? { filename, quote, supports } : null;
    })
    .filter((snippet): snippet is DocumentSnippet => snippet !== null);
}

/**
 * The run's own claim about which credential the endpoint was called with.
 *
 * Both halves are required before it counts as a claim. A record carrying a mode
 * and no `verified` flag, or a flag and no mode, is a half-written claim, and the
 * footer prints no identity line at all for it -- which is the truthful reading
 * of a payload that could not state it. Coercing the missing half would turn that
 * into a sentence naming an identity, which is the failure the footer was changed
 * to stop making.
 */
function normalizeExecutionIdentity(raw: unknown): AnalyticalExecution | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const claim = raw as Record<string, unknown>;
  if (typeof claim.mode !== 'string' || !claim.mode.trim()) return undefined;
  if (typeof claim.verified !== 'boolean') return undefined;
  return { mode: claim.mode, verified: claim.verified };
}

/**
 * The two identity columns of a stored turn, read as the claim a live reply sends.
 *
 * The same fact arrives in two shapes and has to end up as one. A live answer
 * carries `execution_identity` in its reply body; a turn reopened from the rail
 * carries the two columns the ask route wrote beside the answer, because who a
 * run executed as is the app's record about the agent rather than part of the
 * agent's answer. This is the only place the second shape becomes the first, so
 * a reloaded answer and the live one it was reach the footer identically and no
 * second copy of "which sentence do we show" can drift from the first.
 *
 * It DECIDES NOTHING ITSELF, deliberately, and hands both columns to the
 * validator above exactly as the row gave them. That validator already refuses
 * a half-written claim, and every honesty rule this needs falls out of it:
 *
 *   - A turn recorded before those columns existed holds two nulls, states no
 *     identity, and keeps saying so. Reaching for the reader's current session
 *     to fill the gap would be a sentence about a run this build knows nothing
 *     about, and backfilling the row would be inventing an audit trail.
 *   - A row filled in on one side only -- a mode with no verification flag, or
 *     a flag with no mode -- is a record that could not state who ran it, so it
 *     is read as no claim rather than as the half it managed to write.
 *   - `verified` travels as it was recorded. It is a different fact from the
 *     mode (whether this app could read a subject out of the forwarded token,
 *     not which credential the endpoint was called with), and defaulting an
 *     absent one to `true` would turn an unproven run into a confirmed one on
 *     the strength of a missing column.
 */
export function storedExecutionIdentity(row: {
  execution_mode?: unknown;
  execution_identity_verified?: unknown;
}): AnalyticalExecution | undefined {
  return normalizeExecutionIdentity({
    mode: row.execution_mode,
    verified: row.execution_identity_verified,
  });
}

/**
 * Provenance entries, with anything that states nothing dropped.
 *
 * An entry whose four fields are all empty is not provenance, it is four blank
 * labels, and a block of those under an answer reads as a list that failed to
 * load. Fields are carried individually, so an entry that knows its metric but
 * not its window still says the half it knows.
 */
function normalizeDerivation(raw: unknown): Derivation[] {
  return asArray(raw)
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        source: asString(record.source).trim(),
        metric: asString(record.metric).trim(),
        window: asString(record.window).trim(),
        filter: asString(record.filter).trim(),
      };
    })
    .filter((entry) => Boolean(entry.source || entry.metric || entry.window || entry.filter));
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
  content?: string;
  figures: Figure[];
  charts?: unknown;
  sources: SourceRef[];
  document_snippets: DocumentSnippet[];
  caveats: string[];
  /**
   * What each statement of the run measured, over what window, from where.
   *
   * Empty for an answer from a model version logged before the agent derived it,
   * and for a run that executed no statement worth describing. Both render as no
   * provenance block at all rather than as an empty one.
   */
  derivation: Derivation[];
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
  /**
   * Which identity the run this answer came from executed as, when it was recorded.
   *
   * A live reply states it in the body. A stored answer states nothing, because
   * the row holds the agent's answer and the identity columns beside it rather
   * than inside it -- so a turn reopened from the rail gets this filled from
   * `storedExecutionIdentity`, and arrives here indistinguishable from the live
   * answer it was.
   *
   * Absent still means absent, and it is not rare: every turn recorded before
   * those columns existed holds nulls in both. The footer then says nothing about
   * identity, rather than borrowing the reader's current session as though it
   * were the run's, and rather than printing a sentence doubting it.
   */
  executionIdentity?: AnalyticalExecution;
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
    content: asString(raw.content),
    figures: normalizeFigures(raw.figures),
    sources: normalizeSources(raw.sources),
    document_snippets: normalizeDocumentSnippets(raw.document_snippets),
    caveats: normalizeCaveats(raw.caveats),
    derivation: normalizeDerivation(raw.derivation),
    sql: asString(raw.sql),
    trace: normalizeTrace(raw.trace),
  };
  if (raw.type === 'answer') normalized.type = 'answer';
  // Only the three the server can mean. A value this build does not recognise
  // is dropped rather than passed through, so a newer server cannot get an
  // unknown word treated as if it were 'live' by a check written as `!== 'mixed'`.
  if (isAnswerProvenance(raw.provenance)) normalized.provenance = raw.provenance;
  if (raw.runStored === false) normalized.runStored = false;
  // Either spelling, so that normalizing an answer twice says what normalizing
  // it once said. The wire name is what a reply and a stored row use and is
  // therefore preferred; the normalized name is what an answer that has already
  // been through this function carries, which is what the transcript hands back
  // on every render. Both are validated by the same rule, so accepting the
  // second is not a way in for a claim the first would have refused.
  const executionIdentity = normalizeExecutionIdentity(raw.execution_identity ?? raw.executionIdentity);
  if (executionIdentity) normalized.executionIdentity = executionIdentity;
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
