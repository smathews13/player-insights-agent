/**
 * Which of a run's steps are allowed to decide the run's own verdict.
 *
 * A run is stored as an answer with a list of stages, and the verdict the reader
 * meets -- the pill in the conversation rail, the status column in the Run
 * Explorer, the word in the run header -- has always been the worst status any
 * stage ended on. That rule is right for the steps that produce the answer and
 * wrong for one of them, and the exception is the whole reason this module
 * exists.
 *
 * THE CHART STEP IS NOT PART OF THE ANSWER. It runs after the narrative and the
 * figures are already assembled, from the rows the run had already read, and it
 * draws a panel on top of them. A chart that was declined, refused as malformed
 * or never rendered because the plotting endpoint was down costs a picture; the
 * answer above it, its figures, its sources and its SQL are all intact and
 * checkable. Letting that outcome set the verdict published a correct answer as
 * a degraded one, which is worse than a missing panel in two ways: the reader
 * distrusts figures that are fine, and 'partial' stops meaning anything once
 * the commonest cause of it is cosmetic.
 *
 * THE STEP'S OWN STATUS IS UNTOUCHED. `agent.py` still reports what the
 * plotting step did and why -- amber for a spec it would not render, green for a
 * decline -- and the trace timeline still draws it. This is only about what may
 * be aggregated UPWARDS. A reader who opens the run sees the honest step; a
 * reader who does not, sees a verdict about the answer.
 *
 * ONE RULE, TWO EVALUATORS, and that is the hazard this file is written against.
 * The verdict is computed in Postgres by `RUNS_QUERY`, because it is derived
 * from stored JSON at query time rather than written to a column, and the same
 * rule is applied in TypeScript by anything holding stages in memory. Both read
 * `VERDICT_EXEMPT_STAGE_IDS` from here so a step added to the exemption is added
 * once. The SQL is built from this constant rather than restating it.
 */

/**
 * Stage ids whose outcome must never become the run's verdict.
 *
 * Matched on the stage ID rather than its name, which is prose somebody will
 * reword -- the same discipline `RUNS_QUERY` already applies to the `cap` stage
 * it reads truncation from. `plot` is the id `agent.py` emits for the charting
 * step; see the `yield log.stage("plot", ...)` call there.
 *
 * Deliberately short. This is not a place to file steps whose failures are
 * inconvenient: a step belongs here only when its outcome says nothing about
 * whether the answer is sound.
 */
export const VERDICT_EXEMPT_STAGE_IDS = ['plot'] as const;

/** The three words a stored run's verdict can be. */
export type RunVerdict = 'complete' | 'partial' | 'failed';

/** One stage, as much of it as the verdict depends on. */
export interface VerdictStage {
  id?: unknown;
  status?: unknown;
}

/**
 * Whether this stage's outcome may be aggregated into the run's verdict.
 *
 * A stage with no id counts, which is the conservative direction: an unnamed
 * step is one this rule cannot recognise as exempt, and treating it as exempt
 * would silently hide a real degradation.
 */
export function countsTowardVerdict(stage: VerdictStage): boolean {
  const id = typeof stage.id === 'string' ? stage.id.trim() : '';
  return !(VERDICT_EXEMPT_STAGE_IDS as readonly string[]).includes(id);
}

/**
 * The run's verdict, from its stages.
 *
 * `failed` outranks `partial` outranks `complete`. A run with no stages at all
 * is `failed`: that used to be `complete`, which painted a green Complete badge
 * over a 0.0s card that recorded nothing. Absence of steps is not a successful
 * answer; it is a run that never produced one.
 */
export function runVerdict(stages: readonly VerdictStage[]): RunVerdict {
  if (stages.length === 0) return 'failed';
  const counted = stages.filter(countsTowardVerdict);
  const holds = (status: string) => counted.some((stage) => stage.status === status);
  if (holds('failed')) return 'failed';
  if (holds('partial')) return 'partial';
  return 'complete';
}

/**
 * Caveat phrases that used to flip the whole answer to Partial or Failed.
 *
 * Incomplete sources and a turn deadline are notes about how the answer was
 * assembled, not a statement that no answer landed. They stay on the card.
 * They must not decide the rail, the inspector pill, or the Run Explorer
 * status when figures or tables are already on the card.
 */
export const INCOMPLETE_ANSWER_CAVEAT =
  /turn deadline|stopped early|sources for this answer are incomplete|structured presentation was incomplete|this question was not answered|was not reachable|this answer is degraded|no structured result|without a structured result/i;

/** Caveats that only matter when nothing usable actually landed. */
export const UNFINISHED_WITHOUT_ANSWER_CAVEAT =
  /this question was not answered|was not reachable|structured presentation was incomplete/i;

/**
 * Whether the payload already has a reader-facing answer: figures, a pipe
 * table, or narrative that is not the unanswered line.
 *
 * A caveat about Genie tables or a turn deadline is not evidence that this is
 * missing. Historical cards were being failed on read because those notes
 * were treated as the verdict.
 */
export function answerHasLanded(input: {
  figures?: readonly unknown[] | null;
  narrative?: string | null;
  content?: string | null;
}): boolean {
  if ((input.figures?.length ?? 0) > 0) return true;
  const text = [input.narrative, input.content].filter(Boolean).join('\n');
  if (!text.trim()) return false;
  if (/\|.+\|/.test(text)) return true;
  const cleaned = text
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^this question was not answered/i.test(line) &&
        !/^the analysis completed\b/i.test(line) &&
        !/\bfrom assessed sources\b/i.test(line)
    )
    .join(' ')
    .trim();
  return cleaned.length >= 40;
}

/**
 * The takeaway when the writer stopped after tables already landed.
 *
 * Same sentence `agent.py` uses as `DEADLINE_TAKEAWAY`. A 31-character
 * "This question was not answered." over those tables is the defect this
 * exists to stop.
 */
export const TIME_LIMIT_TAKEAWAY =
  'The run reached its time limit before the answer could be composed.';

/** The canned line that must not headline a card that already has tables. */
export const UNANSWERED_LINE = /^this question was not answered\.?$/i;

/**
 * Writer-timeout / unreachable notes. Incomplete sources and a turn-deadline
 * keep-in-mind line are NOT in this set: those stay notes on a Complete card
 * when the writer actually finished. `time limit` and `turn deadline` alone
 * over-fired Partial on every finished answer that still carried that note.
 */
export const WRITER_STOPPED_CAVEAT =
  /was not reachable|run limit was reached|APITimeoutError|Request timed out|time limit before the answer could be composed|time limit before any data was measured/i;

/**
 * Optional DSF package clip. A finished catalog listing that still carries this
 * line has answered the question; the clip is a note, not a failed write.
 */
export const DSF_CLIP_NOTE = /optional detail was clipped at the DSF handoff bound/i;

/** Postgres form of {@link WRITER_STOPPED_CAVEAT}, bound via `__CAVEATS__`. */
const WRITER_STOPPED_CAVEAT_SQL =
  `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(__CAVEATS__, '[]'::jsonb)) c WHERE c ~* 'was not reachable|run limit was reached|APITimeoutError|Request timed out|time limit before the answer could be composed|time limit before any data was measured')`;

/**
 * The takeaway a reader should see when the stored headline is unanswered
 * but tables or figures already landed.
 */
export function takeawayWhenTablesLanded(output: string, evidence: string): string {
  const text = output.trim();
  if (!UNANSWERED_LINE.test(text)) return output;
  const held = [evidence, output].filter(Boolean).join('\n');
  if (/\|.+\|/.test(held)) return TIME_LIMIT_TAKEAWAY;
  return output;
}

/**
 * Whether "Prepared the answer" itself failed or stopped short.
 *
 * A failed writer after tables landed is Partial. A synthesis step marked
 * `partial` because optional DSF detail was clipped is not: the listing
 * finished, and that clip is a note. Only a real writer-stop caveat turns a
 * `partial` synthesis into an incomplete answer.
 */
export function synthesisIncomplete(
  stages: readonly VerdictStage[],
  caveats: readonly string[] = []
): boolean {
  const synthesis = stages.find((stage) => stage.id === 'synthesis');
  if (!synthesis) return false;
  if (synthesis.status === 'failed') return true;
  if (synthesis.status !== 'partial') return false;
  return caveats.some((text) => WRITER_STOPPED_CAVEAT.test(text));
}

/**
 * The run's verdict from stages, and only then from caveats that mean nothing
 * usable was written.
 *
 * A 0-step run is still Failed. A failed step with no figures is still Failed.
 * Incomplete sources on a card that already has tables stay Complete.
 * A writer timeout or failed "Prepared the answer" after SQL already produced
 * tables is Partial on every surface -- never unanswered + Failed while
 * another view says Complete. A finished writer with tables stays Complete
 * even when a tool step failed, a deadline note is still on the card, or
 * optional DSF detail was clipped on a catalog listing.
 */
export function answerRunVerdict(input: {
  stages?: readonly VerdictStage[];
  caveats?: readonly string[];
  figures?: readonly unknown[] | null;
  narrative?: string | null;
  content?: string | null;
}): RunVerdict {
  const stages = input.stages ?? [];
  if (stages.length === 0) return 'failed';
  // Words without figures or a table are not a finished analysis. The
  // 40-character narrative test used to call those Complete, so Ask said
  // Complete while the fallback banner said the run had failed.
  const structured =
    (input.figures?.length ?? 0) > 0 || /\|.+\|/.test([input.narrative, input.content].filter(Boolean).join('\n'));
  const proseOnlyDegraded = (input.caveats ?? []).some(
    (text) => /this answer is degraded/i.test(text) && /structured result/i.test(text)
  );
  if (proseOnlyDegraded && !structured) {
    return runVerdict(stages) === 'failed' ? 'failed' : 'partial';
  }
  if (answerHasLanded(input)) {
    const caveats = input.caveats ?? [];
    if (synthesisIncomplete(stages, caveats)) return 'partial';
    const recordedSynthesis = stages.some((stage) => stage.id === 'synthesis');
    if (!recordedSynthesis && caveats.some((text) => WRITER_STOPPED_CAVEAT.test(text))) {
      return 'partial';
    }
    return 'complete';
  }
  const fromStages = runVerdict(stages);
  if (fromStages === 'failed') return 'failed';
  const caveats = input.caveats ?? [];
  if (caveats.some((text) => UNFINISHED_WITHOUT_ANSWER_CAVEAT.test(text))) {
    return 'failed';
  }
  if (fromStages === 'partial' || caveats.some((text) => INCOMPLETE_ANSWER_CAVEAT.test(text))) {
    return 'partial';
  }
  return 'complete';
}

/**
 * The exemption as a SQL/JSON path filter fragment, to be appended inside an
 * existing `? (...)` predicate on a stage.
 *
 * Built from the constant so the query cannot drift from the TypeScript rule.
 * Only `&&` and `!=` are used, both of which are plain SQL/JSON path operators,
 * because this string is assembled here and executed in Postgres where a syntax
 * error would take the whole run list out rather than one column.
 *
 * A stage object carrying no `id` member evaluates this to unknown and is
 * therefore NOT counted -- the opposite of `countsTowardVerdict` above, and the
 * one place the two evaluators differ. Every stage this agent has ever written
 * carries an id (it is required by `TraceStage` in agent/contracts.py, and the
 * `truncated` column beside this one already depends on it), so the divergence
 * is unreachable rather than tolerated; it is noted because the day a stage
 * arrives without an id, this is where the two answers part.
 */
export const VERDICT_STAGE_EXEMPTION_SQL = VERDICT_EXEMPT_STAGE_IDS.map(
  (id) => `&& @.id != "${id}"`
).join(' ');

/**
 * Empty-stage predicate for the stored-run queries. A missing or empty stages
 * array is a failed turn, not a completed one.
 */
export const EMPTY_STAGES_FAILED_SQL =
  `(jsonb_typeof(trace->'stages') IS DISTINCT FROM 'array' OR jsonb_array_length(trace->'stages') = 0)`;

/**
 * Caveat predicate that matches {@link INCOMPLETE_ANSWER_CAVEAT} in SQL.
 *
 * Only applied when {@link ANSWER_LANDED_SQL} is false. Incomplete sources
 * and a deadline note must not flip a card that already has figures or tables.
 */
export const INCOMPLETE_ANSWER_CAVEAT_SQL =
  `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(caveats, '[]'::jsonb)) c WHERE c ~* 'turn deadline|stopped early|sources for this answer are incomplete|structured presentation was incomplete|this question was not answered|was not reachable|this answer is degraded|no structured result|without a structured result')`;

/**
 * Figures, a pipe table, or a real narrative — the same test as
 * {@link answerHasLanded}, for the stored-run queries. `payload` is the
 * answer JSON object (`response_json`).
 */
export const ANSWER_LANDED_SQL = `(
  (jsonb_typeof(payload->'figures') = 'array' AND jsonb_array_length(payload->'figures') > 0)
  OR COALESCE(payload->>'narrative', '') ~ '\\|'
  OR COALESCE(payload->>'content', '') ~ '\\|'
)`;

/**
 * "Prepared the answer" failed, or stopped short with a real writer-stop
 * caveat. Split on `__TRACE__` and `__CAVEATS__`.
 *
 * Synthesis `partial` alone used to trip this, which painted a finished
 * 12-table catalog listing Partial whenever DSF clipped optional detail.
 */
export const SYNTHESIS_INCOMPLETE_SQL = `(
  jsonb_path_exists(__TRACE__, '$.stages[*] ? (@.id == "synthesis" && @.status == "failed")')
  OR (
    jsonb_path_exists(__TRACE__, '$.stages[*] ? (@.id == "synthesis" && @.status == "partial")')
    AND ${WRITER_STOPPED_CAVEAT_SQL}
  )
)`;

/** Bind {@link SYNTHESIS_INCOMPLETE_SQL} to one query's trace and caveats columns. */
export function bindSynthesisIncompleteSql(trace: string, caveats: string): string {
  return SYNTHESIS_INCOMPLETE_SQL.split('__TRACE__').join(trace).split('__CAVEATS__').join(caveats);
}

/** Deadline / early-stop only, for the stored `truncated` flag. */
export const DEADLINE_TRUNCATED_SQL =
  `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(caveats, '[]'::jsonb)) c WHERE c ~* 'turn deadline|stopped early')`;
