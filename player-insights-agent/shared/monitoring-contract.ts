/**
 * What Monitoring reads, and the two classifications the server and the browser
 * have to agree about.
 *
 * Shared rather than declared twice because both classifications are the kind
 * that drift silently. The first is the outcome of a question: answered,
 * refused, or failed. The second is the cause of a refusal: a grant somebody can
 * make, versus a rule this release enforces on itself. Both are derived from the
 * failure taxonomy's LAYER rather than from a list of codes, so a code added
 * there lands in the right bucket without anybody remembering to come here.
 *
 * WHY REFUSED AND FAILED ARE NEVER ONE NUMBER. A refusal is the app working:
 * somebody asked for data they are not entitled to and was told so. A failure is
 * the app not working. Added together they produce a figure that rises for two
 * unrelated reasons and can be reduced by fixing either, which is the same as
 * measuring nothing. Every shape in this file keeps them apart, and nothing here
 * exposes a sum of the two.
 */

import { FAILURE_TAXONOMY, isFailureCode, type FailureCode, type FailureLayer } from './failure-taxonomy';
import type { Role } from './user-roster-contract';
import type { RunRuntimeUsed } from './run-runtime-used';

/**
 * What came of one question, using the same run vocabulary as Run Explorer.
 */
export type QuestionOutcome = 'completed' | 'partial' | 'refused' | 'failed';

/**
 * The run ledger's terminal states, mapped to the three words.
 *
 * Keyed on the state rather than on the code because the state is what the
 * ledger stores as its verdict, and `run-state.ts` already derives the state
 * from the code's layer. Reading the code here as well would be a second
 * derivation of one fact, and the two would eventually disagree about a
 * governance refusal.
 */
const OUTCOME_BY_STATE: Record<string, QuestionOutcome> = {
  REFUSED: 'refused',
  FAILED: 'failed',
  DEADLINE_EXCEEDED: 'failed',
  PERSISTENCE_FAILED: 'failed',
  CLARIFICATION_REQUIRED: 'partial',
  CANCELLED: 'partial',
};

/**
 * The outcome of one question, from what the stores actually recorded.
 *
 * Two sources, in order of authority. The run ledger's state is the verdict and
 * is preferred wherever there is one. Where there is not, the question predates
 * the ledger, and the only evidence is the stored answer's trace, which is what
 * `RUNS_QUERY` has always read: a trace carrying a failed stage is a failure and
 * a trace without one is an answer.
 *
 * A question with neither is `other`, never `answered`. It is a question whose
 * outcome nobody recorded, and the summary strip counts it as such rather than
 * assuming the good case.
 */
export function classifyOutcome(input: {
  /** The run ledger's terminal state, when a ledger row exists. */
  runState?: string | null;
  /** Whether a stored assistant reply exists for this question. */
  hasStoredAnswer?: boolean;
  /** Whether that reply's trace carries a stage the agent marked failed. */
  traceHasFailedStage?: boolean;
  /** Whether that reply's trace carries a non-cosmetic partial stage. */
  traceHasPartialStage?: boolean;
  /**
   * Whether the stored answer already has figures or a pipe table.
   *
   * A writer timeout after SQL produced tables is Partial, not Failed, and
   * not Complete. Without this flag Monitoring said Failed while Run Explorer
   * said Complete over the same run.
   */
  answerLanded?: boolean;
  /**
   * Whether "Prepared the answer" itself failed or stopped short.
   *
   * Any failed or partial step used to count as a writer miss, which painted
   * a finished answer Partial whenever one SQL or Genie call had missed.
   */
  synthesisIncomplete?: boolean;
  /**
   * Words-only degraded reply: enough narrative to look landed, no figures
   * or table. Same rule as the Ask card, so Monitoring cannot call it Completed
   * while Ask says Partial.
   */
  proseOnlyDegraded?: boolean;
}): QuestionOutcome {
  const state = (input.runState ?? '').trim().toUpperCase();
  const writerMissed = state === 'DEADLINE_EXCEEDED' || input.synthesisIncomplete === true;
  if (input.answerLanded && writerMissed && state !== 'REFUSED') {
    return 'partial';
  }
  if (state && OUTCOME_BY_STATE[state]) return OUTCOME_BY_STATE[state];
  if (input.proseOnlyDegraded) return 'partial';
  if (state && state !== 'SUCCEEDED') return 'partial';
  if (input.answerLanded && (state === 'SUCCEEDED' || input.hasStoredAnswer)) {
    return 'completed';
  }
  if (input.traceHasFailedStage) return 'failed';
  if (input.traceHasPartialStage) return 'partial';
  if (state === 'SUCCEEDED' || input.hasStoredAnswer) return 'completed';
  return 'partial';
}

/**
 * An administrator's stored outcome, when one exists. Classification is
 * unchanged; this is the same word every surface must show after a pencil save.
 */
export function applyAdminOutcome(classified: QuestionOutcome, overlayStatus?: string | null): QuestionOutcome {
  const word = (overlayStatus ?? '').trim().toLowerCase();
  if (word === 'complete' || word === 'completed') return 'completed';
  if (word === 'partial') return 'partial';
  if (word === 'failed') return 'failed';
  if (word === 'refused') return 'refused';
  return classified;
}

/** An administrator's stored rating, when one exists. */
export function applyAdminRating(
  classified: 'up' | 'down' | null,
  overlayRating?: string | null
): 'up' | 'down' | null {
  const word = (overlayRating ?? '').trim().toLowerCase();
  if (word === 'unrated') return null;
  if (word === 'up' || word === 'down') return word;
  return classified;
}

/**
 * Which of the two refusal causes a code belongs to, or neither.
 *
 * The split the per-user panel renders as two tiles that are never added
 * together. `authorization` is a grant somebody can make. `governance` and
 * `evidence` are this release refusing to read something it is not declared to
 * read, or refusing to use evidence it could not attribute, and the fix is a
 * change to the release or to the question.
 *
 * `identity`, `request` and `release` are refusals too, and they are
 * deliberately in neither bucket: none of them is about what the reader may
 * read. Counting them in either tile would make that tile's caption false.
 */
export type RefusalCause = 'missing-grant' | 'agent-rules' | 'other';

const CAUSE_BY_LAYER: Partial<Record<FailureLayer, RefusalCause>> = {
  authorization: 'missing-grant',
  governance: 'agent-rules',
  evidence: 'agent-rules',
};

export function classifyRefusal(code: string | null | undefined): RefusalCause {
  const value = (code ?? '').trim();
  if (!isFailureCode(value)) return 'other';
  return CAUSE_BY_LAYER[FAILURE_TAXONOMY[value].layer] ?? 'other';
}

/**
 * The taxonomy's own sentence for a code, or nothing.
 *
 * Nothing rather than a generic sentence, for the reason `failureDefinition`
 * throws on an unknown code: a sentence invented here would be this build
 * describing a refusal it does not have a definition of. The row's `title`
 * attribute is simply absent in that case, which is honest, and the outcome pill
 * still carries the word.
 */
export function refusalSentence(code: string | null | undefined): string | null {
  const value = (code ?? '').trim();
  return isFailureCode(value) ? FAILURE_TAXONOMY[value].uiMessage : null;
}

/** The codes behind one refusal tile, for its `title`. Sorted, so it is stable. */
export function codesForCause(cause: RefusalCause): FailureCode[] {
  return (Object.keys(FAILURE_TAXONOMY) as FailureCode[]).filter((code) => classifyRefusal(code) === cause).sort();
}

/** One row in the question list. Every field is what a store recorded. */
export interface MonitoringQuestion {
  /** The user message's id, which is what the drawer is opened by. */
  id: string;
  conversationId: string;
  question: string;
  /** Full address. The list shows the local part and puts this on `title`. */
  askedBy: string;
  askedAt: string;
  outcome: QuestionOutcome;
  /**
   * The taxonomy sentence for a refusal or failure, or null.
   *
   * Resolved on the server so the browser does not have to hold the taxonomy's
   * wording as well, and null wherever no code was recorded.
   */
  outcomeDetail: string | null;
  /** Recorded total run time in milliseconds, or null when not recorded. */
  durationMs: number | null;
  /** The agent's own count of external calls, or null when not recorded. */
  toolCalls: number | null;
  /** 'up', 'down', or null for the overwhelming majority that are never rated. */
  rating: 'up' | 'down' | null;
  /** Fully-qualified tables this run read, as the answer recorded them. */
  tables: string[];
}

/**
 * The five figures across the top, as counts rather than as sentences.
 *
 * Counts and not formatted strings, so that the honesty rules are applied once
 * in the view and can be tested there: a rate is refused when its population is
 * zero, and a percentile is refused under twenty runs. A server that sent
 * pre-formatted values would be making those decisions somewhere no render test
 * can see them.
 */
export interface MonitoringSummary {
  questionsAsked: number;
  /**
   * Distinct conversation threads containing a real user question in the
   * selected period. This is not a distinct-user count: one person can start
   * several threads in the same period.
   */
  userThreads: number;
  completed: number;
  partial: number;
  refused: number;
  failed: number;
  /** Thumbs up, and the population it is a share of. Never one without the other. */
  ratedUp: number;
  ratedTotal: number;
  /** Median recorded run time in milliseconds, or null when nothing was recorded. */
  medianMs: number | null;
  /** How many of `questionsAsked` carried a recorded run time. */
  timedCount: number;
}

/** Whether the store answered, and whether it answered completely. */
export type MonitoringReadState = 'ok' | 'partial' | 'unavailable';

/** Stable keyset paging metadata for a Monitoring question list. */
export interface MonitoringPagination {
  /** The bounded number of rows requested for this page. */
  pageSize: number;
  /**
   * Exact matching-row count when the server can establish it cheaply.
   *
   * Null is deliberate for filters derived from answer metadata: returning the
   * unfiltered range count there would put a precise-looking false total beside
   * a filtered list.
   */
  total: number | null;
  /** Whether another keyset page can be requested. */
  hasMore: boolean;
  /** Opaque cursor for that page, or null at the end. */
  nextCursor: string | null;
}

export interface MonitoringQuestionsPayload {
  readState: MonitoringReadState;
  /** ISO stamp of this read, for the shared freshness line. */
  readAt: string;
  summary: MonitoringSummary;
  questions: MonitoringQuestion[];
  /**
   * How many questions the figures above were computed over.
   *
   * Present only on a partial read, together with `foundQuestions`. The strip
   * renders over the counted number and says so, which is the one arrangement
   * that never shows a figure over an unknown denominator.
   */
  countedQuestions?: number;
  /** How many the range actually holds, when that is more than were read. */
  foundQuestions?: number;
  /** Distinct askers in range, for the Person chip. */
  people: string[];
  /** Distinct tables read in range, for the table-touched chip. */
  tables: string[];
  /**
   * Whether the admin's own table grants could be resolved for this range.
   *
   * 'failed' does not hide anything. It puts one line above the list and shows
   * every answer, which is the decision in section 5.4 of the plan: an admin's
   * grants normally cover what was asked, so the likely truth is that they were
   * entitled to all of it, and Unity Catalog is still the boundary either way.
   */
  grantsResolution: 'ok' | 'failed';
  pagination: MonitoringPagination;
}

/**
 * Why one answer body was replaced by a line naming a table.
 *
 * The unit is the table, and nothing finer. A stored answer is finished prose
 * with figures inside it; there is no reliable way to remove one figure from a
 * sentence a model wrote, and an implementation that tried would either leave
 * the number in place or mangle the sentence into something that reads as a
 * defect. See section 5.4 of the plan, which argues this at length so that
 * nobody attempts better later.
 */
export interface AnswerConditioning {
  /** Fully qualified, as the run recorded it. */
  table: string;
  /** `SELECT`, or whichever privilege the check found missing. */
  permission: string;
}

/** What the drawer renders for one question. */
export interface MonitoringDetail {
  id: string;
  conversationId: string;
  question: string;
  askedBy: string;
  askedAt: string;
  outcome: QuestionOutcome;
  outcomeDetail: string | null;
  /** The recorded terminal code, shown in monospace under the sentence. */
  outcomeCode: string | null;
  /**
   * The stored answer, in the shape Ask PIA's own components already render.
   *
   * `null` when the run produced none, and `null` when the reader's grants do
   * not cover a table it read. In the second case `conditioning` says which
   * table, and the answer is not sent at all: conditioning that happened in the
   * browser would mean the body had already been delivered.
   */
  answer: unknown;
  conditioning: AnswerConditioning | null;
  /**
   * The run's recorded trace, sent whatever the reader's grants are.
   *
   * Beside the answer rather than inside it, because it is in the always-shown
   * set and the answer is not. Which tools ran and how long each took is a record
   * about the agent, not another person's data, and the conditioned drawer in the
   * design shows the timeline exactly as the full one does.
   */
  trace: unknown;
  /**
   * Token counts, also always shown. Null where the run was not metred.
   *
   * Null and not zero. A run whose gateway reported no usage did not make a free
   * call, and the two are indistinguishable once a zero is on screen.
   */
  tokens: { prompt: number | null; completion: number | null; total: number | null } | null;
  /** The run's recorded execution identity, for the existing footer wording. */
  execution: { mode: string; verified: boolean } | null;
  rating: 'up' | 'down' | null;
  usefulness: number | null;
  comment: string | null;
  /** Absent, not dead, when the run recorded no trace id. */
  mlflowUrl: string | null;
  /** The run id Run Explorer opens, which is the answer message's id. */
  runId: string | null;
  /**
   * The runtime this Ask sent. Extracted on the server so a conditioned drawer
   * still shows the budget even when the answer body is withheld. Null when the
   * run stored none — never today's Settings.
   */
  runtimeUsed?: RunRuntimeUsed | null;
}

/** One table on the per-user panel, read live rather than recalled. */
export interface EffectiveGrant {
  table: string;
  canRead: boolean;
  /** The privilege found missing, when the answer was no. */
  missing: string | null;
  /** Whether the table carries a row filter, or null where it was not read. */
  rowFilter: boolean | null;
  /** The masked columns, or an empty list. Null where masks were not read. */
  maskedColumns: string[] | null;
}

export interface PersonPanelPayload {
  email: string;
  role: Role;
  persona: { id: string; name: string } | null;
  firstSeen: string | null;
  lastSeen: string | null;
  summary: MonitoringSummary;
  /** Recorded run times in range, so the view can apply the percentile rule. */
  durationsMs: number[];
  tokens: { total: number; metredRuns: number; totalRuns: number };
  /**
   * What those tokens cost, when the endpoint's price is known.
   *
   * Null when it is not. The panel omits the cost tile in that case rather than
   * giving an unmeasured configuration detail the same weight as a KPI.
   */
  tokenCostUsd: number | null;
  ratedUp: number;
  ratedDown: number;
  /**
   * The top recorded source tables in this person's runs for the selected
   * period. Ranked by run count descending, then table name, and capped by the
   * server. A run contributes at most once to a table even if its source list
   * repeated that table.
   */
  tablesReadMost: { table: string; runs: number }[];
  /** Which identity executed their runs, counted. */
  executionSplit: { asThemselves: number; asApplication: number; unrecorded: number };
  /** Whether the forwarded token's subject could be checked. Both are ordinary. */
  subjectSplit: { verified: number; confirmedByEndpoint: number; unrecorded: number };
  /*
   * `gateSplit` WAS HERE, and is not coming back while the gate is off.
   *
   * It counted the runs the access gate had verified, skipped, or not yet
   * checked, and the panel printed all three. `ACCESS_GATE_ENABLED` in
   * shared/access-gate.ts is false, so those were counts about a feature that is
   * switched off, and the panel spent two more sentences explaining that a run
   * recorded as skipped was not a run that ran without permissions. The
   * `access_mode` column is still written and still read back elsewhere; nothing
   * reads it into a figure for a reader.
   */
  /** Live, as the application. Null when the read could not run at all. */
  grants: EffectiveGrant[] | null;
  refusedMissingGrant: number;
  refusedAgentRules: number;
  questions: MonitoringQuestion[];
  readState: MonitoringReadState;
  readAt: string;
  pagination: MonitoringPagination;
}
