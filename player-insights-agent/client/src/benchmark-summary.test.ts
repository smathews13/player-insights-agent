import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_QUALIFICATION_FIELDS,
  benchmarkQualifications,
  benchmarkStatus,
  benchmarkStatusLabel,
  benchmarkSummary,
  formatDuration,
  isTerminal,
  ratingLabel,
  type BenchmarkMetrics,
} from './benchmark-summary';

/**
 * The Benchmark Lab previously carried three totals at once (a six-row table, a
 * "8 / 10" tile, and an alert announcing "8 of 10 scenarios passed"), from three
 * unrelated literals. These tests hold the property that replaced them: every
 * figure comes from one derivation over one run, so there is nothing left to
 * disagree.
 */

describe('benchmarkSummary', () => {
  it('reports nothing as a measurement when the run recorded nothing', () => {
    const summary = benchmarkSummary(null, null);
    expect(summary.passedLabel).toBe('Not recorded');
    expect(summary.durationLabel).toBe('Not recorded');
    expect(summary.groundednessLabel).toBe('Not recorded');
    expect(summary.relevanceLabel).toBe('Not recorded');
    expect(summary.contradiction).toBeNull();
  });

  it('keeps recorded zeroes distinct from missing evidence', () => {
    const summary = benchmarkSummary('complete', {
      passed: 0,
      total: 0,
      durationMs: 0,
      groundedness: 0,
      relevance: 0,
      guidelines: 0,
      judgeRates: {
        groundedness: { scored: 0 },
        relevance_to_context: { scored: 0 },
        guidelines: { scored: 0 },
      },
    });
    expect(summary.passedLabel).toBe('0 / 0');
    expect(summary.durationLabel).toBe('0.0s');
    expect(summary.groundednessLabel).toBe('0%');
    expect(summary.relevanceLabel).toBe('0%');
    expect(summary.guidelinesLabel).toBe('0%');
    expect(Object.values(summary)).not.toContain('Not recorded');
  });

  it('never renders a figure the run did not record', () => {
    // The whole class of defect: a plausible number standing in for a missing one.
    const labels = Object.values(benchmarkSummary('complete', {})).filter(
      (value): value is string => typeof value === 'string'
    );
    for (const label of labels) {
      expect(label).not.toMatch(/\d/);
    }
  });

  it('states a pass count as a fraction of everything attempted', () => {
    // A suite where three of ten cases error must read "5 / 10", so it can never
    // be reported as a score out of the seven that produced an answer. The slash
    // is the form the design fixes for every count-out-of-count on the page, and
    // it is the same one the Run Explorer's rating tile uses.
    expect(benchmarkSummary('partial', { passed: 5, total: 10 }).passedLabel).toBe('5 / 10');
  });

  it('names the population the pass fraction is out of, and the shortfall when there is one', () => {
    // The caption is the denominator's meaning. "9 / 12 of cases that ran" is a
    // result; "9 / 12" beside a judged percentage invites the reader to assume both
    // are over the same population, and for a run that stopped early neither is.
    const whole = benchmarkSummary('partial', {
      passed: 9,
      total: 12,
      counts: { total: 12, attempted: 12, passed: 9, failed: 3, errored: 0, clarified: 0, unresolved: 0 },
    });
    expect(whole.passedCoverage).toBe('of cases that ran');

    const cutShort = benchmarkSummary('partial', {
      passed: 9,
      total: 20,
      truncation: { code: 'USER_AUTH_REJECTED', fromCaseIndex: 12, unattempted: 8, detail: 'the credential expired' },
    });
    // Not "of cases that ran", which would be false by eight cases, and not a
    // smaller denominator either: a suite must not get shorter by failing.
    expect(cutShort.passedCoverage).toBe('of the 20 in the suite · 8 never attempted');

    // A case the suite named with no question behind it never ran either, and it
    // is the same lie in a different shape.
    const missingQuestion = benchmarkSummary('partial', {
      passed: 4,
      total: 6,
      counts: { total: 6, attempted: 5, passed: 4, failed: 1, errored: 0, clarified: 0, unresolved: 1 },
    });
    expect(missingQuestion.passedCoverage).toBe('of the 6 in the suite · 1 never ran');
  });

  it('says how many cases the suite duration covers, so it is never read per case', () => {
    expect(benchmarkSummary('complete', { durationMs: 282_000, total: 12 }).durationCoverage).toBe('12 cases');
    expect(benchmarkSummary('complete', { durationMs: 282_000, total: 1 }).durationCoverage).toBe('1 case');
    // Absent rather than guessed at from anything else on the run.
    expect(benchmarkSummary('complete', { durationMs: 282_000 }).durationCoverage).toBeNull();
  });

  it('refuses to show a pass count with no denominator', () => {
    expect(benchmarkSummary('complete', { passed: 8 }).passedLabel).toBe('Not recorded');
    expect(benchmarkSummary('complete', { passed: 8, total: null }).passedLabel).toBe('Not recorded');
  });

  it('counts a rate over the cases its judge scored, not over the suite', () => {
    // A rubric that did not apply to one case was measured over five of six, and
    // "across 6 cases" would state something the run does not claim. The judge's
    // own `scored` count is the denominator.
    const summary = benchmarkSummary('complete', {
      groundedness: 0.4,
      relevance: 1,
      total: 6,
      judgeRates: {
        groundedness: { rate: 0.4, scored: 5, yes: 2, no: 3, notApplicable: 1, errored: 0 },
        relevance_to_context: { rate: 1, scored: 5, yes: 5, no: 0, notApplicable: 1, errored: 0 },
      },
    });

    // The rate is the figure and the population is the caption, which is the pair
    // the design fixes. Neither may be shown without the other, and the caption
    // must never be the case count.
    expect(summary.groundednessLabel).toBe('40%');
    expect(summary.groundednessCoverage).toContain('of 5 judged cases');
    expect(summary.groundednessCoverage).not.toContain('6 judged');
    expect(summary.relevanceLabel).toBe('100%');
    expect(summary.relevanceCoverage).toContain('of 5 judged cases');
  });

  it('never borrows the case count as a rubric population', () => {
    // The conflation this replaces: a rate computed over the cases a judge
    // reached, displayed as a rate over every case in the suite.
    const summary = benchmarkSummary('complete', { groundedness: 0.92, total: 10 });
    expect(summary.groundednessCoverage).not.toContain('10');
    expect(summary.groundednessCoverage).toBe('Population not reported');
  });

  it('never leaves a rate without a population under it, whatever the run recorded', () => {
    // The one property that makes a percentage safe to show at all. Every path
    // through the rate is checked, because a caption that is null on one of them
    // renders as a bare "87%" and a reader will read it as a rate over the suite.
    const runs: BenchmarkMetrics[] = [
      { groundedness: 0.87, total: 12, judgeRates: { groundedness: { rate: 0.87, scored: 11, yes: 10, no: 1 } } },
      { groundedness: 0.87 },
      { total: 12, judgeRates: { groundedness: { rate: null, scored: 0, yes: 0, no: 0, notApplicable: 12 } } },
      {},
    ];
    for (const metrics of runs) {
      const summary = benchmarkSummary('complete', metrics);
      expect(summary.groundednessCoverage).toBeTruthy();
      expect(summary.relevanceCoverage).toBeTruthy();
      expect(summary.guidelinesCoverage).toBeTruthy();
    }
    // And the two kinds of absence are not the same fact: a rubric no case reached
    // a verdict on was measured and found inapplicable, where a run with no judge
    // record never measured it at all.
    expect(
      benchmarkSummary('complete', {
        judgeRates: { groundedness: { rate: null, scored: 0 } },
      }).groundednessCoverage
    ).toBe('No case reached a verdict on this rubric');
    expect(benchmarkSummary('complete', {}).groundednessCoverage).toBe('Not recorded by this run');
  });

  it('keeps a judge that did not apply apart from a judge that said no', () => {
    const summary = benchmarkSummary('complete', {
      total: 6,
      guidelines: 1,
      judgeRates: { guidelines: { rate: 1, scored: 1, yes: 1, no: 0, notApplicable: 5, errored: 0 } },
    });

    // The governance refusal is scored by guidelines alone, so a judge that did
    // not apply being counted as a failure is what would make a correct refusal
    // impossible to pass. Guidelines reads as its own fraction rather than as a
    // percentage, because it is the rubric whose population moves most: "100%"
    // over one case and over twelve are not the same claim.
    expect(summary.guidelinesLabel).toBe('1 / 1');
    expect(summary.guidelinesCoverage).toContain('followed · judge-scored');
    expect(summary.guidelinesCoverage).toContain('5 did not apply');
    expect(summary.guidelinesCoverage).toContain('not counted as failures');
  });

  it('separates a case that errored from a case that failed', () => {
    const summary = benchmarkSummary('partial', {
      passed: 2,
      total: 6,
      counts: { total: 6, attempted: 6, passed: 2, failed: 3, errored: 1, clarified: 0, unresolved: 0 },
    });

    // An errored case is the run not getting an answer; a failed case is a wrong
    // answer. Averaging them hides a broken endpoint behind a pass rate.
    expect(summary.outcomeLabel).toBe('2 passed · 3 failed · 1 errored');
  });

  it('presents a finished run as one run rather than a settled score', () => {
    const summary = benchmarkSummary('complete', {
      passed: 2,
      total: 6,
      servedModel: { version: '9', determinate: true },
    });

    expect(summary.runCaveat).toContain('a single run');
    expect(summary.runCaveat).toContain('varies between runs');
    // The version is carried separately so the ledger row can lead with it, which
    // is where a reader comparing two runs looks first. Never defaulted: a run
    // that did not pin a version says so instead.
    expect(summary.servedVersion).toBe('9');
    expect(benchmarkSummary('complete', { passed: 2, total: 6 }).servedVersion).toBeNull();
    // Nothing is settled while it is still going, so no such claim is made.
    expect(benchmarkSummary('running', { passed: 1, total: 6 }).runCaveat).toBeNull();
  });

  it('carries what scored the run, so a score is never unattributed on screen', () => {
    const summary = benchmarkSummary('complete', {
      passed: 2,
      total: 6,
      judge: {
        endpoint: 'databricks-claude-sonnet-4-5',
        promptVersion: 'mlflow-3.14.0',
        badge: 'MLflow mlflow-3.14.0 prompts · databricks-claude-sonnet-4-5',
        disclosure: 'MLflow prompts run against a Claude endpoint, not the Databricks managed judge service.',
      },
    });

    expect(summary.judgeBadge).toContain('databricks-claude-sonnet-4-5');
    expect(summary.judgeBadge).toContain('mlflow-3.14.0');
    expect(summary.judgeDisclosure).toContain('not the Databricks managed judge');
  });

  it('says so when a rate arrives with no population to name', () => {
    const summary = benchmarkSummary('complete', { groundedness: 0.92 });
    expect(summary.groundednessLabel).toBe('92%');
    expect(summary.groundednessCoverage).toBe('Population not reported');
  });

  it('reports a self-contradicting run instead of displaying it', () => {
    const summary = benchmarkSummary('complete', { passed: 12, total: 10 });
    expect(summary.contradiction).toContain('12 passes out of 10 cases');
    // And it does not print the impossible fraction as though it were a result.
    expect(summary.passedLabel).toBe('Not recorded');
  });

  it.each([
    ['a rate above one', { groundedness: 1.4 }, 'groundedness is outside'],
    ['a negative pass count', { passed: -1, total: 4 }, 'pass count is negative'],
    ['a negative case count', { total: -4 }, 'case count is negative'],
  ])('flags %s', (_label, metrics, expected) => {
    expect(benchmarkSummary('complete', metrics).contradiction).toContain(expected);
  });

  it('treats a run that has not finished as not final', () => {
    expect(benchmarkSummary('running', { passed: 2, total: 6 }).inProgress).toBe(true);
    expect(benchmarkSummary('complete', { passed: 6, total: 6 }).inProgress).toBe(false);
  });

  it('keeps partial failure as its own outcome rather than a kind of failure', () => {
    const summary = benchmarkSummary('partial', { passed: 3, total: 6 });
    expect(summary.status).toBe('partial');
    expect(summary.inProgress).toBe(false);
  });

  it('does not let the score badge claim the run broke', () => {
    // The stored status is a scoring verdict, so wording `partial` as "Partly
    // failed" said the run itself broke. For five of six passing that is false,
    // and the badge is what a reader takes the headline from.
    expect(benchmarkStatusLabel('partial')).toBe('Mixed result');
    expect(benchmarkStatusLabel('partial')).not.toContain('failed');
    expect(benchmarkStatusLabel('complete')).toBe('All cases passed');
    expect(benchmarkStatusLabel('failed')).toBe('No cases passed');
  });

  it('reports whether every case ran separately from how they scored', () => {
    // Five passed and one failed: the suite ran perfectly and scored imperfectly.
    const scoredBadly = benchmarkSummary('partial', {
      passed: 5,
      total: 6,
      counts: { total: 6, attempted: 6, passed: 5, failed: 1, errored: 0, clarified: 0, unresolved: 0 },
    });
    expect(scoredBadly.executionNote).toBeNull();

    // Five passed and one errored: the suite did not fully run. Same pass count,
    // different fact, and the two must not be readable as each other.
    const ranBadly = benchmarkSummary('partial', {
      passed: 5,
      total: 6,
      counts: { total: 6, attempted: 5, passed: 5, failed: 0, errored: 1, clarified: 0, unresolved: 0 },
    });
    expect(ranBadly.executionNote).toContain('1 case errored');
    expect(ranBadly.executionNote).toContain('did not fully execute');
    expect(scoredBadly.passedLabel).toBe(ranBadly.passedLabel);
    expect(scoredBadly.outcomeLabel).not.toBe(ranBadly.outcomeLabel);
  });

  it('says a suite stopped partway, so its rates are not read as a score for the whole suite', () => {
    // Ten cases, cut short after two, and both of those passed. Every rate on
    // the page is a perfect one over a population of two. Without this sentence
    // beside them that reads as an excellent run rather than an abandoned one.
    const summary = benchmarkSummary('partial', {
      passed: 2,
      total: 10,
      groundedness: 1,
      counts: { total: 10, attempted: 10, passed: 2, failed: 0, errored: 8, clarified: 0, unresolved: 0 },
      judgeRates: { groundedness: { rate: 1, scored: 2, yes: 2, no: 0, notApplicable: 0, errored: 0 } },
      truncation: {
        code: 'USER_AUTH_REJECTED',
        fromCaseIndex: 2,
        unattempted: 8,
        detail: 'the credential was rejected',
      },
    });

    expect(summary.truncationNote).toContain('USER_AUTH_REJECTED');
    expect(summary.truncationNote).toContain('the credential was rejected');
    expect(summary.truncationNote).toContain('8 cases were never attempted');
    // How many cases the rates actually cover, which is the number the reader
    // needs and the one nothing else on the page states. Ten less the eight never
    // reached, and deliberately not `counts.attempted`: the runner records an
    // abandoned case rather than dropping it, so that field counts all ten.
    expect(summary.truncationNote).toContain('only the 2 cases that ran');
    // The denominator stays the suite's, so the run cannot get shorter by
    // failing, and the badge still cannot say every case passed.
    expect(summary.passedLabel).toBe('2 / 10');
    expect(summary.status).not.toBe('complete');
    // And it says outright that nothing was retried as anybody else, which is
    // the specific reassurance this whole workstream exists to be able to give.
    expect(summary.truncationNote).toContain('under any other identity');
  });

  it('says nothing about truncation for a run that attempted every case', () => {
    const summary = benchmarkSummary('partial', {
      passed: 5,
      total: 6,
      counts: { total: 6, attempted: 6, passed: 5, failed: 1, errored: 0, clarified: 0, unresolved: 0 },
    });
    expect(summary.truncationNote).toBeNull();
  });

  it('names whose permissions produced the scores', () => {
    const summary = benchmarkSummary('complete', {
      passed: 6,
      total: 6,
      executedAs: { mode: 'signed_in_user', email: 'alice@example.com', verified: true, credentialExpiresAt: null },
    });
    // The address leads the ledger row rather than sitting mid-paragraph, because
    // it is the first thing a reader comparing two runs needs.
    expect(summary.executedAsIdentity).toBe('alice@example.com');
    // The same suite genuinely scores differently for two readers, so the
    // identity is part of the result rather than metadata about it.
    expect(summary.executedAsNote).toContain('own permissions');
    expect(summary.executedAsNote).toContain('scores differently for readers with different access');
  });

  it('does not claim an unverified session was checked', () => {
    const summary = benchmarkSummary('complete', {
      passed: 6,
      total: 6,
      executedAs: { mode: 'signed_in_user', email: 'alice@example.com', verified: false, credentialExpiresAt: null },
    });
    expect(summary.executedAsNote).toContain("platform's word");
  });

  it('says an older run ran as the application, rather than leaving it blank', () => {
    // Silence here would let a run recorded before benchmarks were bound to a
    // user sit beside one that was, as though they measured the same thing.
    const summary = benchmarkSummary('complete', { passed: 6, total: 6 });
    expect(summary.executedAsNote).toContain('ran as the application');
    expect(summary.executedAsNote).toContain('not comparable');
  });

  it('derives every headline from the one run it was given', () => {
    // The property that makes the old three-way disagreement unrepresentable:
    // there is one input, so two figures cannot come from different places.
    const metrics = {
      passed: 4,
      total: 6,
      groundedness: 0.8,
      relevance: 0.75,
      durationMs: 250_000,
      judgeRates: { groundedness: { rate: 0.8, scored: 5, yes: 4, no: 1, notApplicable: 1, errored: 0 } },
    };
    const first = benchmarkSummary('complete', metrics);
    const second = benchmarkSummary('complete', metrics);
    expect(first).toEqual(second);
    expect(first.passedLabel).toBe('4 / 6');
    expect(first.groundednessLabel).toBe('80%');
    expect(first.groundednessCoverage).toContain('of 5 judged cases');
    expect(first.durationLabel).toBe('4m 10s');
  });
});

describe('formatDuration', () => {
  it('reads a multi-minute suite in minutes, not in hundreds of seconds', () => {
    // A suite takes four to five minutes. "268.0s" makes the reader divide.
    expect(formatDuration(268_000)).toBe('4m 28s');
    expect(formatDuration(300_000)).toBe('5m 00s');
  });

  it('keeps short durations in seconds, where a decimal still means something', () => {
    expect(formatDuration(7_340)).toBe('7.3s');
    expect(formatDuration(89_000)).toBe('89.0s');
  });
});

describe('benchmarkStatus', () => {
  it.each([
    ['complete', 'complete'],
    ['completed', 'complete'],
    ['succeeded', 'complete'],
    ['partial', 'partial'],
    ['failed', 'failed'],
    ['error', 'failed'],
    ['running', 'running'],
    ['queued', 'running'],
    ['pending', 'running'],
    ['in_progress', 'running'],
  ])('maps %s', (raw, expected) => {
    expect(benchmarkStatus(raw)).toBe(expected);
  });

  it('does not guess at a status it does not recognise', () => {
    expect(benchmarkStatus('something-new')).toBe('unknown');
    expect(benchmarkStatus(null)).toBe('unknown');
  });

  it('treats an unrecognised status as not finished, so totals are not called final', () => {
    // Erring the safe way: an unknown status must not license the page to present
    // a partial reading as a completed suite.
    expect(isTerminal(benchmarkStatus('something-new'))).toBe(false);
    expect(isTerminal(benchmarkStatus('complete'))).toBe(true);
    expect(isTerminal(benchmarkStatus('partial'))).toBe(true);
  });
});

describe('ratingLabel', () => {
  it('treats an absent rating as absent, not as zero', () => {
    // The runner never invents a rating; a person supplies one afterwards. An
    // empty star would read as a rating of zero, which is a claim nobody made.
    expect(ratingLabel(null)).toEqual({ rated: false });
    expect(ratingLabel(undefined)).toEqual({ rated: false });
  });

  it('keeps a real rating, including a genuine zero', () => {
    expect(ratingLabel(4)).toEqual({ rated: true, value: 4 });
    expect(ratingLabel(0)).toEqual({ rated: true, value: 0 });
  });
});

/**
 * The qualifications, which used to be a stack of separate alerts above the tiles
 * and are now the rows of one ledger.
 *
 * That regrouping is the one change on this screen that could cost a reader
 * something, because a ledger which quietly renders five of six qualifications
 * looks tidier than the stack it replaced and is worse: each of them exists to
 * stop a specific misreading of a score, and the reader cannot tell that one is
 * missing. So the property tested here is not that the ledger looks right — it is
 * that every qualification the summary produces reaches it, in full.
 */

/** A run carrying every qualification at once, which is rare and the case that matters. */
const FULLY_QUALIFIED: BenchmarkMetrics = {
  passed: 9,
  total: 6, // A contradiction: more passes than cases, shown rather than corrected.
  durationMs: 268_000,
  counts: { total: 6, attempted: 4, passed: 3, failed: 1, errored: 1, unresolved: 1 },
  judge: {
    endpoint: 'judge-endpoint-x',
    promptVersion: 'mlflow-3.14.0',
    badge: 'Judged by Claude via MLflow prompts v3',
    disclosure: 'Scored by an LLM judge, not by a person.',
    groundednessBasis: 'Groundedness is judged against the rows the agent retrieved.',
  },
  servedModel: { version: '7' },
  executedAs: { mode: 'signed_in_user', email: 'reader@example.com', verified: false },
  truncation: { code: 'PERMISSION_DENIED', unattempted: 2 },
};

describe('benchmarkQualifications', () => {
  it('renders every qualification the run carries, and drops none of them', () => {
    const summary = benchmarkSummary('partial', FULLY_QUALIFIED);
    const carried = BENCHMARK_QUALIFICATION_FIELDS.filter((field) => Boolean(summary[field]));
    // Every one of them, so this fixture is exercising the full stack and not a
    // convenient subset of it.
    expect(carried).toEqual([...BENCHMARK_QUALIFICATION_FIELDS]);

    const rows = benchmarkQualifications(summary);
    expect(rows.map((row) => row.field)).toEqual(carried);
    for (const row of rows) {
      // The summary's own sentence, whole. A row that paraphrases a qualification
      // is a row that has shortened a disclosure.
      expect(row.sentence).toContain(summary[row.field]);
      expect(row.lead.length).toBeGreaterThan(0);
    }
  });

  it('says which judge, which prompt version, and on what basis on the row itself', () => {
    // Scores from two prompt versions are not comparable, and this row is the only
    // thing that says which version and which endpoint produced them.
    const [judge] = benchmarkQualifications(benchmarkSummary('complete', FULLY_QUALIFIED));
    expect(judge.field).toBe('judgeDisclosure');
    expect(judge.lead).toBe('Scored by a judge model');
    expect(judge.sentence).toContain('Endpoint judge-endpoint-x');
    expect(judge.sentence).toContain('MLflow prompt version 3.14.0');
    expect(judge.sentence).toContain('Groundedness is judged against the rows the agent retrieved.');
    // And how the rates above are counted, which is the claim a percentage cannot
    // make for itself.
    expect(judge.sentence).toContain('only the cases the judge reached a verdict on');
    expect(judge.sentence).toContain('are not counted as failures');
  });

  it('names no judge endpoint or prompt version when the run recorded none', () => {
    // An older run gets silence rather than whatever the app is configured with
    // today, which would be a claim about a configuration that run never saw.
    const [judge] = benchmarkQualifications(
      benchmarkSummary('complete', {
        passed: 1,
        total: 1,
        judge: { disclosure: 'Scored by an LLM judge, not by a person.' },
      })
    );
    expect(judge.sentence).not.toContain('Endpoint');
    expect(judge.sentence).not.toContain('prompt version');
    expect(judge.sentence).toContain('Scored by an LLM judge');
  });

  it('keeps the two sentences the page used to append in its own markup', () => {
    // Both are load-bearing and both were previously written into the alerts
    // rather than into the derivation, which is exactly how a regroup loses them.
    const rows = benchmarkQualifications(benchmarkSummary('partial', FULLY_QUALIFIED));
    const byField = new Map(rows.map((row) => [row.field, row.sentence]));
    expect(byField.get('contradiction')).toContain('shown as stored');
    expect(byField.get('executionNote')).toContain('not over the whole suite');
  });

  it('keeps the danger treatment on the rows that say the run misbehaved', () => {
    // Truncation and unexecuted cases mean the numbers do not describe what the
    // reader thinks they describe. Regrouping is allowed to move them; it is not
    // allowed to make them read as ordinary notes.
    const tones = new Map(
      benchmarkQualifications(benchmarkSummary('partial', FULLY_QUALIFIED)).map((row) => [row.field, row.tone])
    );
    expect(tones.get('truncationNote')).toBe('danger');
    expect(tones.get('executionNote')).toBe('danger');
    expect(tones.get('contradiction')).toBe('danger');
    expect(tones.get('executedAsNote')).toBe('identity');
    expect(tones.get('runCaveat')).toBe('info');
  });

  it('says nothing when the run carries nothing to qualify', () => {
    // An empty ledger, not a ledger with an empty row in it.
    expect(benchmarkQualifications(benchmarkSummary(null, null))).toEqual([]);
  });

  it('covers every qualification field the summary can produce', () => {
    // The failure this guards is a new qualification added to BenchmarkSummary and
    // not added to the ledger's field list, which would compile, render nothing,
    // and be invisible in review. Read off the interface rather than trusted.
    const source = readFileSync(new URL('./benchmark-summary.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export interface BenchmarkSummary'));
    const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\??:/gm)].map(([, name]) => name);
    expect(fields).toContain('runCaveat'); // The extraction works at all.
    const qualifying = fields.filter((name) => /Note$|Caveat$|Disclosure$|contradiction/.test(name));
    expect([...qualifying].sort()).toEqual([...BENCHMARK_QUALIFICATION_FIELDS].sort());
  });

  it('renders the ledger from the derivation, not from per-qualification markup', () => {
    // The screen maps the derived rows. It matters that it does: a hand-written row
    // per field is how the stack came to have six near-identical branches, and how
    // one of them could be deleted without anything failing.
    const screen = readFileSync(new URL('./BenchmarkLab.tsx', import.meta.url), 'utf8');
    expect(screen).toContain('benchmarkQualifications(summary)');
    expect(screen).toContain('qualifications.map');
    expect(screen).toContain('Read before comparing these scores');
    // No qualification is reachable only through its own conditional any more.
    for (const field of BENCHMARK_QUALIFICATION_FIELDS) {
      expect(screen).not.toContain(`summary.${field} &&`);
    }
  });
});
