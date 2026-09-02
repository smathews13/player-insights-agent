import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BenchmarkLedger, BenchmarkTiles, PerCaseResults, RecordedRuns } from './BenchmarkLab';
import {
  benchmarkCaseRows,
  benchmarkQualifications,
  benchmarkSummary,
  type BenchmarkMetrics,
} from './benchmark-summary';
import type { Run } from './app-types';

/**
 * What the Benchmark Lab actually puts on screen, rendered rather than read.
 *
 * This screen reports scores, which makes it the one place in the app where a
 * test that passes while the page is wrong is worst: a reader takes a number off
 * it and repeats the number to somebody else. It has been wrong twice in ways no
 * source-text assertion could have caught, both times because the statement being
 * checked was true of a component that nothing rendered, or true of a derivation
 * whose output the screen then ignored.
 *
 * So every assertion below goes through the real derivation into the real markup.
 * The page's own run arrives through an effect, which a static render never runs,
 * so the panels are rendered directly with a run — the same shape `RunDetails`
 * next door is tested in. What that cannot cover is anything about the fetch, the
 * poll, or hover and focus: those are named in the report rather than asserted.
 */

/**
 * A run of the shape the design's own mockup describes: judged by a named model,
 * executed as a person, cut short before it attempted every case, and pinned to a
 * served model version. Rare in practice, and the case that matters, because every
 * qualification row and every denominator is exercised at once.
 *
 * The numbers are internally consistent on purpose. Twelve cases in the suite of
 * twenty were reached; groundedness reached a verdict on eleven of them, with one
 * case the rubric did not apply to; guidelines applies to fewer still.
 */
const CUT_SHORT: BenchmarkMetrics = {
  passed: 9,
  total: 20,
  durationMs: 282_000,
  groundedness: 0.87,
  relevance: 0.91,
  guidelines: 0.8333,
  counts: { total: 20, attempted: 12, passed: 9, failed: 3, errored: 8, clarified: 0, unresolved: 0 },
  judgeRates: {
    groundedness: { rate: 0.87, scored: 11, yes: 10, no: 1, notApplicable: 1, errored: 0 },
    relevance_to_context: { rate: 0.91, scored: 11, yes: 10, no: 1, notApplicable: 1, errored: 0 },
    guidelines: { rate: 0.8333, scored: 12, yes: 10, no: 2, notApplicable: 8, errored: 0 },
  },
  judge: {
    endpoint: 'databricks-claude-sonnet-4-5',
    promptVersion: 'mlflow-3.14.0',
    badge: 'LLM judge · MLflow prompt · databricks-claude-sonnet-4-5',
    disclosure: 'This is not the Databricks managed judge service.',
    groundednessBasis: "The groundedness document is what the agent's own trace disclosed.",
  },
  servedModel: { version: '2026-08-09', determinate: true },
  executedAs: { mode: 'signed_in_user', email: 'reader@example.com', verified: true },
  truncation: {
    code: 'USER_AUTH_REJECTED',
    fromCaseIndex: 12,
    unattempted: 8,
    detail: 'the endpoint stopped accepting the credential the run was executing under',
  },
};

/** The same suite, run through to the end and scored perfectly. */
const CLEAN: BenchmarkMetrics = {
  passed: 12,
  total: 12,
  durationMs: 268_000,
  groundedness: 1,
  relevance: 1,
  guidelines: 1,
  counts: { total: 12, attempted: 12, passed: 12, failed: 0, errored: 0, clarified: 0, unresolved: 0 },
  judgeRates: {
    groundedness: { rate: 1, scored: 12, yes: 12, no: 0, notApplicable: 0, errored: 0 },
    relevance_to_context: { rate: 1, scored: 12, yes: 12, no: 0, notApplicable: 0, errored: 0 },
    guidelines: { rate: 1, scored: 4, yes: 4, no: 0, notApplicable: 8, errored: 0 },
  },
  judge: { endpoint: 'databricks-claude-sonnet-4-5', promptVersion: 'mlflow-3.14.0' },
  servedModel: { version: '2026-08-09', determinate: true },
  executedAs: { mode: 'signed_in_user', email: 'reader@example.com', verified: true },
};

function ledgerMarkup(status: string, metrics: BenchmarkMetrics | null): string {
  return renderToStaticMarkup(
    <BenchmarkLedger qualifications={benchmarkQualifications(benchmarkSummary(status, metrics))} />
  );
}

function tileMarkup(status: string, metrics: BenchmarkMetrics | null, hasRun = true): string {
  return renderToStaticMarkup(<BenchmarkTiles summary={benchmarkSummary(status, metrics)} hasRun={hasRun} />);
}

/** Markup with the tags taken out, which is how a reader meets a sentence. */
function readable(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

describe('the qualification ledger, rendered', () => {
  it('opens with the reason to read it rather than with a summary of it', () => {
    // A reader who stops at the head has to still be right about what is below it,
    // so the head is not allowed to be a verdict on the rows.
    const markup = ledgerMarkup('partial', CUT_SHORT);
    expect(markup).toContain('Read before comparing these scores');
  });

  it('names the judge endpoint and prompt version the run recorded, not the one configured now', () => {
    // Two runs judged by different prompt versions are not comparable, and this row
    // is the only thing on the page that says which this is. Both values come off
    // the run: a run that recorded neither gets a row with neither, which is the
    // next assertion, and never a default that describes today's configuration.
    const prose = readable(ledgerMarkup('partial', CUT_SHORT));
    expect(prose).toContain('Scored by a judge model');
    expect(prose).toContain('Endpoint databricks-claude-sonnet-4-5');
    expect(prose).toContain('MLflow prompt version 3.14.0');
  });

  it('states how the rates are counted, because a percentage cannot say it itself', () => {
    // The arithmetic is in `summariseJudge`: the denominator is the cases that judge
    // reached a verdict on, and the two kinds of absence are held out of both halves
    // of the fraction. A reader looking at "87%" would guess the suite instead.
    const prose = readable(ledgerMarkup('partial', CUT_SHORT));
    expect(prose).toContain('only the cases the judge reached a verdict on');
    expect(prose).toContain('did not apply');
    expect(prose).toContain('could not be scored');
    expect(prose).toContain('are not counted as failures');
  });

  it('leads the identity row with the shared user chip', () => {
    const markup = ledgerMarkup('partial', CUT_SHORT);
    const prose = readable(markup);
    expect(prose).toContain('This suite ran as reader');
    expect(markup).toContain('identity-chip identity-chip--compact');
    expect(markup).not.toContain('>RE<');
    expect(prose).toContain('scores differently for readers with different access');
  });

  it('leads the single-run row with the model version those scores belong to', () => {
    const prose = readable(ledgerMarkup('partial', CUT_SHORT));
    expect(prose).toContain('One run against model version 2026-08-09');
    expect(prose).toContain('not a fixed score');
  });

  it('gives the truncation row the alert tone and its own warning glyph', () => {
    // Losing the tone is the one thing the regroup from six alerts into one ledger
    // could have cost a reader. Colour is not carried alone: the row has the
    // triangle as well as the red lead, which is what survives greyscale and what a
    // colour-blind reader is left with.
    const markup = ledgerMarkup('partial', CUT_SHORT);
    const row = markup.slice(markup.indexOf('tone-danger'));
    expect(markup).toContain('bench-ledger-row tone-danger');
    expect(row).toContain('lucide-triangle-alert');
    expect(readable(row)).toContain('The run stopped before attempting every case');
  });

  it('says on the truncation row how many cases the rates actually cover', () => {
    // A suite of twenty cut short after twelve can show a perfect rate over the
    // twelve. Without this sentence beside them those rates read as a result for
    // the suite, which is the misreading this row exists to prevent.
    const prose = readable(ledgerMarkup('partial', CUT_SHORT));
    expect(prose).toContain('USER_AUTH_REJECTED');
    expect(prose).toContain('8 cases were never attempted');
    expect(prose).toContain('only the 12 cases that ran, not the whole suite');
  });

  it('drops each row when its condition does not hold, and the ledger when none do', () => {
    // The rows are conditional on the run and on nothing else. A clean run must not
    // carry a truncation row, because a warning nobody can act on is how a reader
    // learns to skip the whole block -- and the truncation row is the one that
    // matters most when it is real.
    const clean = readable(ledgerMarkup('complete', CLEAN));
    expect(clean).not.toContain('stopped before attempting every case');
    expect(clean).not.toContain('Not every case produced an answer');
    // What a clean run still says, because these qualify a score that is real.
    expect(clean).toContain('Scored by a judge model');
    expect(clean).toContain('This suite ran as reader');

    // No run selected at all: an empty ledger, not a ledger with empty rows in it.
    expect(ledgerMarkup('unknown', null)).toBe('');
  });

  it('shows a contradiction as stored rather than correcting it', () => {
    const prose = readable(ledgerMarkup('complete', { passed: 14, total: 12 }));
    expect(prose).toContain('14 passes out of 12 cases');
    expect(prose).toContain('shown as stored');
  });
});

describe('the figure tiles, rendered', () => {
  it('states the population under every rate, and never a bare percentage', () => {
    // The design's whole point on this row. "87%" and "9 / 20" side by side invite
    // the reader to assume one population, and the judged rates are over another.
    const prose = readable(tileMarkup('partial', CUT_SHORT));
    expect(prose).toContain('87%');
    expect(prose).toContain('of 11 judged cases');
    expect(prose).toContain('91%');
    expect(prose).toContain('1 did not apply, not counted as failures');
  });

  it('names the shortfall under the pass fraction when the suite did not finish', () => {
    const prose = readable(tileMarkup('partial', CUT_SHORT));
    expect(prose).toContain('9 / 20');
    expect(prose).toContain('of the 20 in the suite · 8 never attempted');
    // "of cases that ran" would be false by eight cases here, and it is the caption
    // a run that did finish gets.
    expect(prose).not.toContain('of cases that ran');
    expect(readable(tileMarkup('complete', CLEAN))).toContain('of cases that ran');
  });

  it('gives the suite duration the case count it covers', () => {
    const prose = readable(tileMarkup('partial', CUT_SHORT));
    expect(prose).toContain('4m 42s');
    expect(prose).toContain('20 cases');
  });

  /**
   * THE FIVE FIGURES LINE UP AND THE FIVE CAPTIONS DO NOT BECOME CODE.
   *
   * A row of tiles is read across, so the values have to share a baseline width,
   * and `.summary-grid strong` asked for that with `font-variant-numeric` on DM
   * Sans, whose files declare no `tnum` feature. It got nothing, silently, and
   * "9 / 20" beside "4m 42s" beside "87%" sat at three different rhythms.
   *
   * The class is on the VALUE only. The caption under it names a population in a
   * sentence, and mono there would read as a value rather than as its
   * qualification, which on this page is the distinction the whole row exists to
   * make.
   */
  it('sets every tile value in mono and leaves its caption in DM Sans', () => {
    const markup = tileMarkup('partial', CUT_SHORT);
    expect([...markup.matchAll(/<strong class="ast-num">/g)]).toHaveLength(5);
    expect(markup).not.toMatch(/<small[^>]*class="[^"]*ast-num/);
  });

  it('keeps the guidelines tile as a fraction with the evaluation treatment', () => {
    // Amber means evaluation, and this is the row's one evaluation tile. The class
    // is asserted because the tile's rule and wash hang off it; the CSS itself is
    // pinned in explorer-geometry.
    const markup = tileMarkup('partial', CUT_SHORT);
    expect(markup).toContain('benchmark-score');
    const tile = markup.slice(markup.indexOf('benchmark-score'));
    expect(readable(tile)).toContain('10 / 12');
    expect(readable(tile)).toContain('followed · judge-scored');
    // The eight cases with no guideline to assess are named and are not failures,
    // which is what lets a correct governance refusal pass at all.
    expect(readable(tile)).toContain('8 did not apply, not counted as failures');
  });

  it('separates an errored case from a failed one under the row', () => {
    // Five passed and one failed, and five passed and one errored, give the same
    // fraction and are different facts: one is a wrong answer, the other is no
    // answer at all, and a broken endpoint hides behind the second.
    const prose = readable(tileMarkup('partial', CUT_SHORT));
    expect(prose).toContain('9 passed · 3 failed · 8 errored');
  });

  it('claims nothing while there is no finished run to claim it about', () => {
    const noRun = readable(tileMarkup('unknown', null, false));
    expect(noRun).toContain('No run selected');
    expect(noRun).not.toContain('of cases that ran');

    const running = readable(tileMarkup('running', { passed: 2, total: 12 }));
    expect(running).toContain('Run still in progress');
  });

  it('prints a dash for a figure the run did not record', () => {
    // A plausible number standing in for a missing one is the defect this screen
    // was rebuilt around. "Not recorded" is a fact about the run.
    const prose = readable(tileMarkup('complete', { passed: 3, total: 3 }));
    expect(prose).toContain('Not recorded');
    expect(prose).toContain('Not recorded by this run');
  });
});

/** Three stored runs, one of each status, with feedback only on the newest. */
const RUNS: Run[] = [
  {
    id: 'run-mixed',
    kind: 'benchmark',
    prompt: 'Benchmark suite: POC benchmark suite',
    stakeholder: 'reader@example.com',
    status: 'partial',
    duration_ms: 282_000,
    feedback: 'up',
    created_at: '2026-08-14T09:12:00.000Z',
  },
  {
    id: 'run-complete',
    kind: 'benchmark',
    prompt: 'Benchmark suite: POC benchmark suite',
    stakeholder: 'reader@example.com',
    status: 'complete',
    duration_ms: 303_000,
    feedback: null,
    created_at: '2026-08-11T16:40:00.000Z',
  },
  {
    id: 'run-failed',
    kind: 'benchmark',
    prompt: 'Benchmark suite: POC benchmark suite',
    stakeholder: 'reader@example.com',
    status: 'failed',
    duration_ms: null,
    feedback: null,
    created_at: '2026-08-08T11:05:00.000Z',
  },
];

describe('the recorded runs table, rendered', () => {
  const markup = renderToStaticMarkup(<RecordedRuns runs={RUNS} selectedId="run-mixed" onSelect={() => {}} />);

  it('says that selecting a row is what drives the figures above it', () => {
    expect(readable(markup)).toContain('Selecting a run drives every figure above');
  });

  it('gives each status its own tone, and says what the status is a verdict on', () => {
    // The three tones the design fixes: amber for a mixed result, green for a clean
    // one, red for none passing. The words say what scored rather than whether the
    // run executed, because "Complete" and "Failed" on a scoring verdict tell a
    // reader the run itself finished or broke, and neither is what the status means.
    expect(markup).toContain('bench-pill tone-degraded');
    expect(markup).toContain('bench-pill tone-ok');
    expect(markup).toContain('bench-pill tone-bad');
    const prose = readable(markup);
    expect(prose).toContain('Mixed result');
    expect(prose).toContain('All cases passed');
    expect(prose).toContain('No cases passed');
  });

  it('marks the selected row twice, for a reader who sees it and one who does not', () => {
    // The left edge is the visible mark; `aria-pressed` on the run's own button is
    // the other, and the button is also what puts the row in the tab order. This
    // row is the control for every figure on the page above it.
    expect(markup).toContain('bench-run-row active');
    const selected = markup.slice(markup.indexOf('bench-run-row active'));
    expect(selected).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it('shows canonical feedback and explicit absence', () => {
    const prose = readable(markup);
    expect(prose).toContain('No feedback');
    expect(prose).toContain('Helpful');
  });

  it('prints a dash for a duration the run never recorded', () => {
    // The run that never finished has no duration, and a dash is a fact about it
    // where a zero would be a measurement nobody took.
    expect(readable(markup)).toContain('—');
    expect(readable(markup)).not.toContain('0.0s');
  });

  it('offers the first visit an empty state rather than an empty table', () => {
    const empty = readable(renderToStaticMarkup(<RecordedRuns runs={[]} selectedId={null} onSelect={() => {}} />));
    expect(empty).toContain('Nothing has been benchmarked yet');
    expect(empty).not.toContain('Selecting a run drives');
  });
});

describe('the per-case panel, rendered', () => {
  /**
   * Cases as the runner writes them into `metrics_json`, including the three that
   * arrive as `errored` for entirely different reasons. Those three are the reason
   * this panel cannot just print pass or fail.
   */
  const CASES: BenchmarkMetrics = {
    cases: [
      {
        caseId: 'top-titles',
        question: 'Which titles led on active players?',
        outcome: 'passed',
        durationMs: 21_400,
        note: 'Every judge that applied said yes.',
      },
      {
        caseId: 'churn-risk',
        question: 'Which cohorts are at risk of churning?',
        outcome: 'failed',
        durationMs: 18_900,
        note: 'The groundedness judge said no.',
      },
      {
        caseId: 'access-boundary',
        question: 'Show me another studio’s revenue.',
        outcome: 'errored',
        errorStage: 'identity',
        durationMs: 4_100,
        note: 'The agent refused this turn rather than answering it. Recorded as unscored, not as a failure.',
      },
      {
        caseId: 'ambiguous-window',
        question: 'How did we do recently?',
        outcome: 'clarified',
        durationMs: 6_200,
        note: 'The agent asked a question back instead of answering.',
      },
      {
        caseId: 'late-case',
        question: 'Which platform grew fastest?',
        outcome: 'errored',
        errorStage: 'budget',
        durationMs: null,
        note: 'The suite ran out of time before this case started.',
      },
      {
        caseId: 'no-answer',
        question: 'What drove the weekend spike?',
        outcome: 'errored',
        errorStage: 'agent',
        durationMs: 31_000,
        note: 'The agent produced no answer, so nothing was scored.',
      },
    ],
  };

  const markup = renderToStaticMarkup(<PerCaseResults rows={benchmarkCaseRows(CASES)} inProgress={false} />);

  it('renders the run’s own cases, because the run records them', () => {
    // This panel said a run records suite-level totals only, while the record it
    // was denying sat in the payload it was already reading. The questions come
    // from the run for the same reason: they were once a hardcoded array in the
    // page, which is exactly why the timings printed beside them were invented.
    const prose = readable(markup);
    expect(prose).toContain('Which titles led on active players?');
    expect(prose).toContain('top-titles');
    expect(prose).toContain('21.4s');
    expect(prose).not.toContain('suite-level totals only');
  });

  it('keeps the three kinds of errored case apart, and none of them as a failure', () => {
    // A case the suite never reached, a case the agent never answered, and a case
    // that was answered and could not be scored all arrive as `errored`. Calling
    // all three "Failed" blames the agent for two things it did not do.
    const prose = readable(markup);
    expect(prose).toContain('Never attempted');
    expect(prose).toContain('No answer');
    expect(prose).toContain('Asked to clarify');
    expect(prose).toContain('Failed');
    // The runner's own sentence comes with the row, which is where it says a
    // refusal was not counted as a failure. A pill cannot carry that.
    expect(prose).toContain('Recorded as unscored, not as a failure');
  });

  it('gives no errored case the tone of a pass', () => {
    // Three pills are degraded and exactly one is green, so an unscored case can
    // never be skimmed as a passing one.
    expect(markup.match(/tone-degraded/g)).toHaveLength(3);
    expect(markup.match(/tone-ok/g)).toHaveLength(1);
  });

  it('says a duration is absent rather than printing a zero for it', () => {
    const never = markup.slice(markup.indexOf('late-case'));
    expect(readable(never)).toContain('Not recorded');
    expect(readable(never)).not.toContain('0.0s');
  });

  it('distinguishes a suite that has not got there yet from a run that kept no cases', () => {
    // Two different facts, and neither is an error. The old wording covered both
    // with one sentence that was true of neither once cases started being stored.
    const running = readable(renderToStaticMarkup(<PerCaseResults rows={[]} inProgress={true} />));
    expect(running).toContain('No case in this run has finished yet');

    const older = readable(renderToStaticMarkup(<PerCaseResults rows={[]} inProgress={false} />));
    expect(older).toContain('This run recorded suite-level totals only');
    expect(older).toContain('Not reported per case yet');
  });
});
