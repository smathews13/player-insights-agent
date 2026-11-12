/**
 * The held-out evaluation scorecard: the shape the evaluation writes and the
 * Benchmark Lab reads.
 *
 * WHO WRITES IT, WHICH CHANGED. It was going to be `agent/eval/run_eval.py`.
 * That harness exists and its scorers are the same set, but it reaches the agent
 * in-process with no forwarded user token, and the agent's identity gate
 * correctly refuses every turn that has no caller to attribute -- so the only
 * scorecard it could produce was twelve refusals. The numbers now come from the
 * Benchmark Lab's own run path, which executes as the signed-in caller because
 * that is the one path in this product that has a caller. `producedBy` records
 * which, and a reader should treat `mlflow-harness` as the weaker provenance of
 * the two until a service identity exists that is allowed to hold grants.
 *
 * WHY A COMMITTED ARTIFACT RATHER THAN A ROUTE. The held-out evaluation is an
 * offline job measured in minutes, not something a page can trigger and poll. So
 * the run emits a file, the file is committed, and the pane renders it with the
 * date and the model version it was produced against attached. That makes it a
 * published result rather than a live reading, and the pane has to say so --
 * which is what `ScorecardProvenance` exists to force. A number on this screen
 * with no date beside it would be read as current, and the whole point of the
 * Benchmark Lab is that a figure carries what it is a figure of.
 *
 * NO ANSWER TEXT, NO QUESTION TEXT FROM A REAL SESSION, NO IDENTIFIERS. A
 * per-case entry carries the case id and its scores and nothing else. An
 * evaluation record must not become a way to reconstruct what somebody asked or
 * who a row was about, and the easiest way to hold that line is for the record
 * to have nowhere to put it. The labelled questions themselves live in
 * `agent/eval/dataset.py`, which is authored rather than captured.
 */

/** A scorer that produced no value on a case, and why. */
export type ScoreState = 'scored' | 'not-applicable' | 'unimplementable' | 'errored';

export interface ScorecardValue {
  scorerId: string;
  state: ScoreState;
  /**
   * The aggregate. Null unless `state` is `scored` -- never 0 standing in for
   * "not measured", which is the single most common way a scorecard lies.
   */
  value: number | null;
  /** How many cases the scorer reached a verdict on. The denominator of a rate. */
  scored: number;
  /** Cases the scorer did not apply to, which are in neither half of the rate. */
  notApplicable: number;
  errored: number;
  /** Why it did not report, in a sentence. Empty when `state` is `scored`. */
  reason: string;
}

export interface ScorecardCase {
  caseId: string;
  /** Which held-out slice the case belongs to, for reading the set's balance. */
  group: string;
  /** `answer`, `refusal`, `clarification`, or `unavailable`. */
  outcome: string;
  /**
   * How checkable this case's label is by somebody who did not write it:
   * `data-query`, `data-and-contract` or `policy-document`. Per case rather than
   * per set, because the set is not uniform -- three of its labels are settled
   * by a query and three are settled by nothing but a reading of policy, and a
   * reader deciding how much to trust a row needs to know which kind it is.
   */
  labelSource: string;
  /** The statement that settles the label, on a `data-query` case. */
  verification: string;
  scores: ScorecardValue[];
}

/**
 * Where the numbers came from, in enough detail to disbelieve them.
 */
export interface ScorecardProvenance {
  /** ISO instant the evaluation finished. */
  evaluatedAt: string;
  /** The commit the agent was at. */
  agentCommit: string;
  /**
   * The account the evaluation executed under, and what that account is.
   *
   * Present because it is the single biggest qualifier on the whole scorecard:
   * an evaluation run by an administrator measures the agent as an
   * administrator sees it, and the governed-access scorers are exactly the ones
   * that flatters.
   */
  executedAs: string;
  executedAsNote: string;
  /** The judge endpoint behind the `judged` scorers. */
  judgeEndpoint: string;
  /** How the labels were produced and by whom, verbatim from the dataset module. */
  labelProvenance: string;
  /**
   * Whether a domain expert has reviewed the labels. FALSE TODAY, AND THE MOST
   * IMPORTANT FIELD ON THE SCORECARD.
   *
   * A boolean rather than a sentence buried in `labelProvenance`, because the
   * pane has to branch on it: an unreviewed set gets a warning above the numbers
   * rather than a note below them. A correctness rate is misleading in
   * proportion to how good it looks when the standard it was graded against was
   * written by the same kind of process that produced the answers, and the
   * person most likely to notice that is the customer's proof-of-concept lead.
   *
   * Anyone flipping this to `true` should be able to name the reviewer.
   */
  labelsReviewed: boolean;
  /** The sentence the pane leads with while `labelsReviewed` is false. */
  labelReviewHeadline: string;
  /** What follows from it, in plain words, for the same reader. */
  labelReviewConsequence: string;
  /** How many labels are checkable by query versus readable only. */
  labelSourceCounts: Record<string, number>;
  /** What the set is held out from. */
  heldOutFrom: string;
  /** `benchmark-runner` (signed-in path) or `mlflow-harness` (offline). */
  producedBy: string;
  /** The model version that answered, or why it is not known. */
  servedModel: string;
  /** Empty when the run did not go through MLflow. */
  mlflowRunId: string;
  caseCount: number;
}

export interface Scorecard {
  provenance: ScorecardProvenance;
  aggregates: ScorecardValue[];
  cases: ScorecardCase[];
}

/**
 * The state the app is in before any evaluation has been published.
 *
 * A real state with its own rendering, not an empty object: the pane must be
 * able to say "no evaluation has been published yet" rather than draw a row of
 * dashes that reads as a set of zeroes.
 */
export type ScorecardState = { published: true; scorecard: Scorecard } | { published: false; reason: string };

/**
 * What the runner adds to a stored run, without widening the benchmark contract.
 *
 * The same idiom the runner already uses for `caseListSource`: the field is
 * attached by intersection at the point of writing rather than declared on
 * `BenchmarkCaseResult`, so a reader that predates the scorers still parses
 * every run and a sibling agent's work in `benchmark-contract.ts` is untouched.
 */
export interface ScoredCaseFields {
  /** Every scorer's verdict on this case, including its abstentions. */
  scores?: ScorecardValue[];
}

export interface ScoredRunFields {
  /**
   * The scorer set aggregated over the run. Present on any suite, not only the
   * held-out one -- the scorers that need a labelled expectation abstain on the
   * POC suite and say so, which is more useful than not running them.
   */
  scorecard?: {
    aggregates: ScorecardValue[];
    /** True only for the held-out set, whose labels are unreviewed. */
    labelsReviewed: boolean;
    nonGating: true;
  };
}
