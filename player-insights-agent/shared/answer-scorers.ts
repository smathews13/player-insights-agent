/**
 * The deterministic and operational scorers, over the agent's own answer
 * envelope.
 *
 * WHY THIS FILE EXISTS AT ALL, GIVEN `agent/eval/scorers.py`. The scorer set was
 * written first as MLflow `@scorer` functions, which is the right home for it:
 * that is what a development run scores with, what a pre-release run scores
 * with, and what production monitoring registers. It is also Python, and the
 * only path in this product that reaches the agent as the signed-in caller is
 * the Benchmark Lab's, which is Node. An offline Python harness cannot take that
 * path -- it has no forwarded user token to take it with -- so a scorer set that
 * existed only in Python could be run only as somebody's laptop credential or
 * not at all, and the numbers it produced would describe neither the product nor
 * a person.
 *
 * So there are two implementations, and pretending otherwise would be worse than
 * saying it. What keeps them honest is `eval-conformance.json`: a set of
 * envelopes with the verdict each scorer must return for each one, read by
 * `answer-scorers.test.ts` here and by `agent/tests/test_eval_scorers.py` there.
 * Neither side owns it. A change to one implementation that the other does not
 * match fails on both sides, naming the scorer and the case.
 *
 * THE INPUT IS THE PYTHON ENVELOPE, NOT THE RUNNER'S `BenchmarkAnswer`. Every
 * function below reads `{type, answer, execution_identity, ...}` exactly as the
 * agent's `custom_outputs` carries it, because that is what makes the fixture
 * shared and the conformance test meaningful. The runner adapts into this shape;
 * see `answerEnvelope` in `server/lib/benchmark-runner.ts`.
 *
 * TWO RULES ABOUT WHAT A SCORER MAY SAY, carried over verbatim from the Python
 * because they are properties of the output rather than of the language:
 *
 *   Rationales are structural. They name fields, counts and column names --
 *   never the question, never a sentence of the answer, never a value from a
 *   row. An evaluation record is an operational record and must not become the
 *   way somebody reconstructs what a customer asked or which player a figure was
 *   about. `answer-scorers.test.ts` sweeps every rationale this module can
 *   produce for the fixtures' own question and answer text and fails on a hit.
 *
 *   Scorers abstain rather than guess. Every one of them can return null, and
 *   several routinely do: a definitional answer has no SQL, a refusal has no
 *   sources, a case with no labelled entity has no recall to measure. An
 *   abstention is excluded from both halves of a rate.
 *
 * NOTHING HERE GATES ANYTHING. These functions return numbers and booleans. No
 * caller in this repository blocks a release, a deployment or a certification on
 * one; that is a recorded scope decision (unified plan, X3), not an unfinished
 * edge.
 */

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/** A source the answer named. `role` says what it was read FOR. */
export interface EnvelopeSource {
  name?: unknown;
  role?: unknown;
  freshness?: unknown;
}

export interface EnvelopeTrace {
  totalMs?: unknown;
  total_tokens?: unknown;
  genie_spaces?: unknown;
}

export interface EnvelopeAnswer {
  takeaway?: unknown;
  narrative?: unknown;
  sql?: unknown;
  figures?: unknown;
  sources?: unknown;
  caveats?: unknown;
  trace?: EnvelopeTrace;
}

/**
 * The agent's `custom_outputs`, read loosely.
 *
 * Loose on purpose: an endpoint running an older model version omits keys, and
 * the correct response to a missing key is almost always to abstain rather than
 * to throw. Every reader below narrows what it needs and says so when it cannot.
 */
export interface AnswerEnvelope {
  type?: unknown;
  answer?: EnvelopeAnswer;
  code?: unknown;
  message?: unknown;
  question?: unknown;
  execution_identity?: { mode?: unknown; verified?: unknown };
  /** Which tables the semantic layer the run searched actually describes. */
  semantic_layer_tables?: unknown;
}

/** What a case was labelled as expecting. Mirrors `expectations` in the dataset. */
export interface CaseExpectations {
  expected_routes?: string[];
  expected_entities?: string[];
  expects_caveat?: boolean;
  caveat_must_mention?: string[];
  is_refusal?: boolean;
}

/**
 * One scorer's verdict on one case.
 *
 * `value: null` with a `state` other than `scored` is the abstention, and the
 * two fields are separate so a reader never has to infer "not measured" from a
 * missing number.
 */
export interface ScorerVerdict {
  state: 'scored' | 'not-applicable' | 'errored';
  /** `true`/`false` for a pass-fail scorer, a magnitude for an operational one. */
  value: number | boolean | null;
  rationale: string;
}

const ANSWER = 'answer';

export const ROUTE_GENIE = 'genie';
export const ROUTE_SQL = 'sql';
export const ROUTE_DICTIONARY = 'dictionary';
export const ROUTE_NONE = 'none';

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const scored = (value: number | boolean, rationale: string): ScorerVerdict => ({
  state: 'scored',
  value,
  rationale,
});

const abstain = (rationale: string): ScorerVerdict => ({
  state: 'not-applicable',
  value: null,
  rationale,
});

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function answerOf(envelope: AnswerEnvelope): EnvelopeAnswer | null {
  if (envelope?.type !== ANSWER) return null;
  return (envelope.answer ?? {});
}

function sourcesOf(answer: EnvelopeAnswer): EnvelopeSource[] {
  return list(answer.sources).filter((entry): entry is EnvelopeSource => Boolean(entry) && typeof entry === 'object');
}

/**
 * Which governed routes a run actually took.
 *
 * Exported because the held-out set's labels are written in this vocabulary and
 * a test has to be able to check one against the other. Not a scorer.
 *
 * The tokens come from the published answer contract -- `genie_spaces`, `sql`,
 * and a source's `role` -- rather than from tool names. Tool names are the
 * model's vocabulary and change with the model; contract fields are the app's
 * and are already rendered on screen.
 */
export function observedRoutes(envelope: AnswerEnvelope): Set<string> {
  const answer = answerOf(envelope);
  if (!answer) return new Set([ROUTE_NONE]);
  const routes = new Set<string>();
  if (list(answer.trace?.genie_spaces).length > 0) routes.add(ROUTE_GENIE);
  if (text(answer.sql).trim()) routes.add(ROUTE_SQL);
  for (const source of sourcesOf(answer)) {
    if (text(source.role) === 'reference') routes.add(ROUTE_DICTIONARY);
  }
  return routes.size > 0 ? routes : new Set([ROUTE_NONE]);
}

// ---------------------------------------------------------------------------
// Deterministic scorers
// ---------------------------------------------------------------------------

/**
 * Does the statement the answer published still hold the properties the runtime
 * refused it for not holding?
 *
 * THIS IS A CANARY OVER AN ENFORCED INVARIANT, NOT AN OPINION ABOUT THE SQL, and
 * the difference decides how the number should be read. Every statement that
 * reaches a published answer has ALREADY passed `agent/sql_policy.py`:
 * `validate_sql` for the agent's own SQL, `inspect_generated_sql` for Genie's,
 * and both call the same `refuse_restricted_columns`. A statement that failed
 * was refused and no answer exists to score. So a pass here is expected and
 * means only that the guarantee held; a FAILURE means a statement was published
 * without the check that should have refused it, which is a policy bypass and
 * the thing worth being told about.
 *
 * WHAT THIS DELIBERATELY NO LONGER CHECKS, AND WHY IT WAS WRONG TO. The first
 * version of this scorer re-derived the column policy textually: any appearance
 * of a restricted column failed the statement. On the first real run that
 * reported 0.625 and it was false. The policy permits a restricted column inside
 * a COUNTING aggregate -- `count(distinct player_id)` says how many players,
 * never which, and is the entire point of the product -- and permits one that is
 * filtered, joined or grouped on. A regex cannot see any of that, so it failed
 * two statements the runtime had correctly accepted, and the scorecard reported
 * an agent defect that was a scorer defect. A textual re-check of a parsed
 * policy can only ever produce false positives, so it is gone rather than tuned.
 *
 * Qualification is checked only when the run reached no Genie space. `validate_sql`
 * requires catalog.schema.table of the agent's own statements; `inspect_generated_sql`
 * deliberately does not hold Genie to the manifest, so applying that rule to a
 * Genie statement would fail it for a rule it was never held to.
 *
 * The stronger check -- the runtime policy's own verdict, via sqlglot -- runs in
 * `agent/eval/scorers.py`, which is where MLflow evaluation and production
 * monitoring score this. The conformance fixture records where the two differ.
 */
export function sqlValidity(envelope: AnswerEnvelope): ScorerVerdict {
  const answer = answerOf(envelope);
  if (!answer) return abstain('No answer was produced, so no statement was published.');
  const sql = text(answer.sql).trim();
  if (!sql) {
    return abstain('The answer published no SQL, which is expected for a definitional answer or a refusal.');
  }

  const problems: string[] = [];
  // Comments stripped first: a `--` line can carry any of the words below and a
  // match inside one would fail a statement for what it says rather than does.
  const bare = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const lowered = bare.toLowerCase();

  if (!/^\s*(with|select)\b/.test(lowered)) {
    problems.push('the statement does not begin as a read-only SELECT or WITH');
  }
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke)\b/.test(lowered)) {
    problems.push('the statement is not read-only');
  }

  // A subquery or a CTE reference opens with `(` or names a single identifier a
  // CTE defined, so both are excluded before the qualification rule applies.
  const viaGenie = list(answer.trace?.genie_spaces).length > 0;
  const cteNames = new Set(
    [...bare.matchAll(/(?:with|,)\s+([a-z_][\w]*)\s+as\s*\(/gi)].map((match) => match[1].toLowerCase())
  );
  const targets = [...bare.matchAll(/\b(?:from|join)\s+([^\s(,;]+)/gi)].map((match) => match[1]);
  const unqualified = targets.filter((target) => {
    const name = target.replace(/[`"']/g, '').toLowerCase();
    if (!name || cteNames.has(name)) return false;
    return name.split('.').length < 3;
  });
  if (!viaGenie && unqualified.length > 0) {
    problems.push(`${unqualified.length} table reference(s) are not named as catalog.schema.table`);
  }

  if (problems.length > 0) {
    return scored(false, `${problems.join('; ')}. The runtime policy should have refused this statement.`);
  }
  return scored(
    true,
    `Read-only${viaGenie ? '' : `, ${targets.length} table reference(s) all fully qualified`}. ` +
      'Asserts the guarantees the runtime SQL policy already enforced before publication; ' +
      'it is not a second opinion on the query. The column policy is not re-checked here -- ' +
      'it needs a parser to tell a counting aggregate from a disclosure. ' +
      'agent/eval/scorers.py runs the policy itself.'
  );
}

/**
 * The columns the answer contract treats as identifying.
 *
 * NOT used to fail a statement -- see `sqlValidity` for why a textual check of
 * them produces only false positives. Kept because `answer-scorers.test.ts`
 * sweeps every rationale this module emits for them: a scorer explaining itself
 * by naming the identifier it found would put that identifier in the operational
 * record, which is the disclosure the policy exists to prevent.
 */
export const WITHHELD_COLUMNS = ['crm_customer_ref', 'email', 'player_id', 'partner_player_ref', 'platformid_accountid'];

/**
 * Can a reader trace every figure back to something the answer named?
 *
 * Three conditions, all necessary and none sufficient: the answer named at least
 * one source; every source says what it was read FOR, because a flat list
 * presents the dictionary the agent consulted as though the numbers came out of
 * it; and an answer carrying figures also published the statement behind them.
 *
 * Says nothing about whether the figures are right. A completely wrong number
 * with a named table, a stated role and a published query scores a pass here,
 * and that is correct -- correctness is a different scorer with a different
 * denominator.
 */
export function provenanceCompleteness(envelope: AnswerEnvelope): ScorerVerdict {
  const answer = answerOf(envelope);
  if (!answer) return abstain('No answer was produced, so there is nothing to attribute.');
  const sources = sourcesOf(answer);
  const figures = list(answer.figures);
  if (sources.length === 0 && figures.length === 0) {
    return abstain('The answer stated no figures and named no sources, so completeness of attribution does not apply.');
  }
  const missing: string[] = [];
  if (sources.length === 0) missing.push('figures were stated but no source was named');
  const roleless = sources.filter((source) => !text(source.role).trim()).length;
  if (roleless > 0) {
    missing.push(`${roleless} of ${sources.length} named source(s) did not say what they were read for`);
  }
  if (figures.length > 0 && !text(answer.sql).trim() && list(answer.trace?.genie_spaces).length === 0) {
    missing.push('figures were stated with neither a published statement nor a named Genie space behind them');
  }
  if (missing.length > 0) return scored(false, `${missing.join('; ')}.`);
  return scored(true, `${figures.length} figure(s) over ${sources.length} named source(s), each with a stated role.`);
}

/**
 * Did the run reach the route the case was labelled as needing?
 *
 * Recall over the labelled routes, deliberately, not an exact match. A run that
 * consulted the dictionary AND queried the warehouse when the label named only
 * the dictionary has done nothing wrong; a run that answered a definitional
 * question without consulting the dictionary has, whatever else it did.
 */
export function toolSelection(envelope: AnswerEnvelope, expectations: CaseExpectations): ScorerVerdict {
  const expected = new Set(expectations?.expected_routes ?? []);
  if (expected.size === 0) {
    return abstain('The case declares no expected route, so there is nothing to check the run against.');
  }
  const observed = observedRoutes(envelope);
  const missing = [...expected].filter((route) => !observed.has(route)).sort();
  if (missing.length > 0) {
    return scored(
      false,
      `Expected route(s) not reached: ${missing.join(', ')}. Reached: ${[...observed].sort().join(', ')}.`
    );
  }
  return scored(true, `Reached every expected route (${[...expected].sort().join(', ')}).`);
}

/**
 * On a case with a known gap, did the answer say so?
 *
 * Applies only to cases labelled `expects_caveat`. Checks that a caveat is
 * PRESENT, not that it is the right caveat, unless the case names terms the
 * caveat had to mention -- and the rationale says which of the two was applied
 * so a pass is never read as more than it is.
 */
export function coverageCaveat(envelope: AnswerEnvelope, expectations: CaseExpectations): ScorerVerdict {
  if (!expectations?.expects_caveat) {
    return abstain('The case is not labelled as having a coverage gap to disclose.');
  }
  const answer = answerOf(envelope);
  if (!answer) return abstain('No answer was produced, so there was nothing to attach a caveat to.');
  const caveats = list(answer.caveats).map(text).filter((entry) => entry.trim());
  if (caveats.length === 0) {
    return scored(false, 'The case has a known coverage gap and the answer disclosed no caveat.');
  }
  const required = (expectations.caveat_must_mention ?? []).map((term) => term.toLowerCase());
  if (required.length === 0) {
    return scored(
      true,
      `${caveats.length} caveat(s) present. Presence only: the case named no term the caveat had to mention.`
    );
  }
  const haystack = caveats.join(' ').toLowerCase();
  const absent = required.filter((term) => !haystack.includes(term));
  if (absent.length > 0) {
    return scored(false, `A caveat was present but did not mention ${absent.length} of ${required.length} required term(s).`);
  }
  return scored(true, `${caveats.length} caveat(s) present, mentioning every required term.`);
}

/**
 * Did the answer reach the entity the case was labelled as needing?
 *
 * RECALL OVER THE LABELLED ENTITIES. It is not precision, it does not say the
 * ranking was good, and it cannot say the retriever is healthy -- a case whose
 * entity is reached by the dictionary rather than by the index passes here. Read
 * it with `staleIndex`, which is the scorer that can tell a ranking miss from an
 * index that no longer describes the schema.
 */
export function semanticRecall(envelope: AnswerEnvelope, expectations: CaseExpectations): ScorerVerdict {
  const expected = (expectations?.expected_entities ?? []).map((name) => name.toLowerCase());
  if (expected.length === 0) return abstain('The case names no entity to recall.');
  const answer = answerOf(envelope);
  if (!answer) return abstain('No answer was produced, so nothing was retrieved.');
  const reached = [...sourcesOf(answer).map((source) => text(source.name)), text(answer.sql)].join(' ').toLowerCase();
  const missing = expected.filter((name) => !reached.includes(name));
  if (missing.length > 0) {
    return scored(
      false,
      `${missing.length} of ${expected.length} labelled entity name(s) appear in neither the named sources ` +
        'nor the published statement.'
    );
  }
  return scored(true, `All ${expected.length} labelled entity name(s) were reached.`);
}

/**
 * Did the semantic index describe the tables the run actually read?
 *
 * The question this answers is narrow and worth stating: when `semanticRecall`
 * misses, was the entity absent from the index, or ranked badly within it? A run
 * whose named sources are all present in the semantic layer it searched has an
 * index that at least covers what it used.
 */
export function staleIndex(envelope: AnswerEnvelope): ScorerVerdict {
  const answer = answerOf(envelope);
  if (!answer) return abstain('No answer was produced, so no table was read.');
  const sources = sourcesOf(answer)
    .map((source) => text(source.name).trim())
    .filter(Boolean);
  if (sources.length === 0) {
    return abstain('The run named no source, so there is nothing to compare the index against.');
  }
  const described = new Set(list(envelope.semantic_layer_tables).map((name) => text(name).trim().toLowerCase()).filter(Boolean));
  if (described.size === 0) {
    return abstain(
      'The run did not report which tables the semantic layer describes, so index freshness could not be ' +
        'established. Recorded as unmeasured rather than fresh.'
    );
  }
  const undescribed = sources.filter((name) => !described.has(name.toLowerCase()));
  if (undescribed.length > 0) {
    return scored(
      false,
      `${undescribed.length} of ${sources.length} table(s) the run read are not described by the semantic index ` +
        'it searched.'
    );
  }
  return scored(true, `All ${sources.length} table(s) the run read are described by the semantic index.`);
}

/**
 * Did the run read governed data under the caller's own proven credential?
 *
 * THE NARROW HALF OF THE IDENTITY STORY, AND IT SAYS SO. This establishes whose
 * grants were in force: the signed-in caller's, with the forwarded token proven
 * to belong to them, rather than the application's service principal. It does
 * NOT establish that a wrong identity would have been refused -- that is
 * `identity_mismatch`, which needs a second identity to present and which this
 * deployment cannot run.
 *
 * Worth scoring on its own anyway. Three service-principal fallback paths were
 * closed in this codebase, and on each of them the answer would still have been
 * produced and would still have looked correct. This is the scorer that would
 * have noticed.
 */
export function identityExecutionMode(envelope: AnswerEnvelope): ScorerVerdict {
  const identity = envelope?.execution_identity ?? {};
  const mode = text(identity.mode);
  const verified = Boolean(identity.verified);
  if (!mode) {
    return abstain('The run recorded no execution identity, so the mode could not be established. Unmeasured, not compliant.');
  }
  if (mode !== 'signed_in_user') {
    return scored(
      false,
      `The run executed under '${mode}' rather than the signed-in caller, so its results describe the ` +
        "application's grants and not a person's."
    );
  }
  if (!verified) {
    return scored(false, 'The run executed as the signed-in caller but the forwarded credential was not proven to belong to them.');
  }
  return scored(true, 'Executed as the signed-in caller, with the forwarded credential proven to belong to them.');
}

// ---------------------------------------------------------------------------
// Operational scorers
//
// Measurements of the run, not statements about the answer. A fast, cheap, wrong
// answer scores well on all four, which is why they are labelled `operational`
// in the catalog the app renders and are never summed into a quality figure.
// ---------------------------------------------------------------------------

/**
 * Recorded to the microsecond, because the digits past that are noise with a
 * cost.
 *
 * `totalMs` is a difference of two high-resolution clock readings, so it arrives
 * as something like `15680.038345002686` -- sixteen significant figures on a
 * measurement whose real resolution is nowhere near that, and whose trailing
 * digits change on every run. Nothing reads them: the Benchmark Lab renders a
 * latency in milliseconds and the aggregate is a median.
 *
 * WHAT THEY DID INSTEAD, which is why this is rounded rather than left alone. The
 * scorecard is committed as `client/src/eval-scorecard.generated.json` and vite
 * inlines it into the Benchmark Lab chunk, where the whole bundle is one line. A
 * fractional run of twelve or more digits on that line is indistinguishable from
 * a bare job or workspace id, and check-mirror-leaks.sh blocked a publication on
 * two of them. In unminified source the numeric rules exclude a run that follows
 * a decimal point, so the source file itself was silent -- the finding only
 * exists once the bundler removes the newlines. Rounding here removes the shape
 * at the point the number is recorded, which is better than clearing the built
 * chunk: the chunk carries our own data now, so it should stay scanned.
 */
export function latencyMs(envelope: AnswerEnvelope): ScorerVerdict {
  const total = answerOf(envelope)?.trace?.totalMs;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return abstain('The run reported no total duration.');
  }
  return scored(
    Math.round(total * 1000) / 1000,
    "The agent's own measured wall time, which excludes the network and any plan-approval round trip."
  );
}

/**
 * Prompt and completion tokens summed across the turn.
 *
 * Zero is reported as zero and NOT as unmeasured, because the two are not
 * distinguishable from the totals alone -- an endpoint that returns no usage
 * block and a turn that made no model call both arrive here as 0. The rationale
 * says so, so a free-looking run is never quietly read as free.
 */
export function totalTokens(envelope: AnswerEnvelope): ScorerVerdict {
  const total = answerOf(envelope)?.trace?.total_tokens;
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    return abstain('The run reported no token totals.');
  }
  if (total === 0) {
    return scored(
      0,
      'Zero tokens recorded. This means the endpoint returned no usage block OR the turn made no model call; ' +
        'the totals alone cannot tell the two apart.'
    );
  }
  return scored(total, 'Prompt and completion tokens summed across the turn.');
}

/**
 * Calls the run made to a governed data surface.
 *
 * Counts CALLS, not bytes scanned and not cost. A single call over a year of
 * history and a single call over a day are one each.
 */
export function warehouseCalls(envelope: AnswerEnvelope): ScorerVerdict {
  const answer = answerOf(envelope);
  if (!answer) return abstain('No answer was produced, so no governed surface was read.');
  let calls = list(answer.trace?.genie_spaces).length;
  if (text(answer.sql).trim()) calls += 1;
  return scored(calls, `${calls} governed-surface call(s): Genie spaces reached plus a published warehouse statement, if any.`);
}

/**
 * Did the case produce no answer at all?
 *
 * A REFUSAL IS NOT AN ERROR AND IS NOT COUNTED HERE. Declining to answer a
 * question about restricted data is the behaviour this demo exists to
 * demonstrate, and a scorer that counted it as a failure would report the
 * agent's best moment as its worst. A clarification is not an error either:
 * stopping to ask rather than guessing is a real and correct outcome of a turn.
 * Only a run that failed, or one stopped at the identity gate, counts.
 *
 * Returns 1 for an error so the mean across the set reads directly as the rate
 * the name promises.
 */
export function errorRate(envelope: AnswerEnvelope): ScorerVerdict {
  const kind = text(envelope?.type);
  if (kind === ANSWER) return scored(0, 'The run produced an answer.');
  if (kind === 'clarification') {
    return scored(0, 'The run asked a clarifying question, which is an outcome of a turn rather than a failure of one.');
  }
  if (kind === 'refusal') {
    return scored(0, 'The run declined to answer, which is a correct outcome on a question that asks for restricted data.');
  }
  if (kind === 'unavailable') {
    return scored(1, `The run produced no answer: ${text(envelope.code) || 'unavailable'}.`);
  }
  return scored(1, 'The run produced no recognised outcome.');
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

/** A scorer as the runner calls it: one envelope, one case's labels, one verdict. */
export type AnswerScorer = (envelope: AnswerEnvelope, expectations: CaseExpectations) => ScorerVerdict;

/**
 * Every scorer this process can run, keyed by the id in `scorer-catalog.ts`.
 *
 * Keyed rather than listed so a scorer can never be reported under a name the
 * catalog does not declare: `answer-scorers.test.ts` checks the two key sets
 * against each other, and the catalog is what the Benchmark Lab renders.
 */
export const ANSWER_SCORERS: Record<string, AnswerScorer> = {
  sql_validity: (envelope) => sqlValidity(envelope),
  provenance_completeness: (envelope) => provenanceCompleteness(envelope),
  tool_selection: toolSelection,
  coverage_caveat: coverageCaveat,
  semantic_recall: semanticRecall,
  stale_index: (envelope) => staleIndex(envelope),
  identity_execution_mode: (envelope) => identityExecutionMode(envelope),
  latency_ms: (envelope) => latencyMs(envelope),
  total_tokens: (envelope) => totalTokens(envelope),
  warehouse_calls: (envelope) => warehouseCalls(envelope),
  error_rate: (envelope) => errorRate(envelope),
};

/**
 * Run the whole set over one case.
 *
 * A scorer that throws is recorded as `errored` rather than allowed to end the
 * run: one bad verdict must not cost the other fourteen, and an error is a state
 * the scorecard can render.
 */
export function scoreCase(envelope: AnswerEnvelope, expectations: CaseExpectations): Record<string, ScorerVerdict> {
  const verdicts: Record<string, ScorerVerdict> = {};
  for (const [id, scorer] of Object.entries(ANSWER_SCORERS)) {
    try {
      verdicts[id] = scorer(envelope, expectations);
    } catch (error) {
      verdicts[id] = {
        state: 'errored',
        value: null,
        rationale: `The scorer threw ${(error as Error).name}. Recorded as errored, which is excluded from the rate.`,
      };
    }
  }
  return verdicts;
}
