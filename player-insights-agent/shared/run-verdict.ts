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
 * Caveat phrases that mean the writer never finished, even when every recorded
 * step is green. The deadline path used to emit a complete synthesis stage over
 * a "turn deadline was reached" caveat, so the rail said Complete while Keep in
 * mind admitted the opposite.
 */
export const INCOMPLETE_ANSWER_CAVEAT = /turn deadline|stopped early|sources for this answer are incomplete|structured presentation was incomplete|this question was not answered|was not reachable/i;

/**
 * The run's verdict from stages and the caveats the agent already wrote.
 *
 * Stages win when they are failed. Otherwise a deadline or salvage caveat
 * downgrades a green stage list to `partial`, which is the 100-second run that
 * had a real table and still was not a finished answer.
 */
export function answerRunVerdict(input: {
  stages?: readonly VerdictStage[];
  caveats?: readonly string[];
}): RunVerdict {
  const fromStages = runVerdict(input.stages ?? []);
  if (fromStages === 'failed') return 'failed';
  const caveats = input.caveats ?? [];
  if (caveats.some((text) => /this question was not answered|was not reachable/i.test(text))) {
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
 */
export const INCOMPLETE_ANSWER_CAVEAT_SQL =
  `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(caveats, '[]'::jsonb)) c WHERE c ~* 'turn deadline|stopped early|sources for this answer are incomplete|structured presentation was incomplete|this question was not answered|was not reachable')`;

/** Deadline / early-stop only, for the stored `truncated` flag. */
export const DEADLINE_TRUNCATED_SQL =
  `EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(caveats, '[]'::jsonb)) c WHERE c ~* 'turn deadline|stopped early')`;
