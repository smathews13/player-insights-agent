import { describe, expect, it } from 'vitest';
import {
  benchmarkStatus,
  benchmarkStatusLabel,
  benchmarkSummary,
  formatDuration,
  isTerminal,
  ratingLabel,
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
    expect(summary.passedLabel).toBe('Not reported');
    expect(summary.durationLabel).toBe('Not reported');
    expect(summary.groundednessLabel).toBe('Not reported');
    expect(summary.relevanceLabel).toBe('Not reported');
    expect(summary.contradiction).toBeNull();
  });

  it('never renders a figure the run did not record', () => {
    // The whole class of defect: a plausible number standing in for a missing one.
    const labels = Object.values(benchmarkSummary('complete', {})).filter((value): value is string => typeof value === 'string'
    );
    for (const label of labels) {
      expect(label).not.toMatch(/\d/);
    }
  });

  it('states a pass count as a fraction of everything attempted', () => {
    // A suite where three of ten cases error must read "5 of 10", so it can never
    // be reported as a score out of the seven that produced an answer.
    expect(benchmarkSummary('partial', { passed: 5, total: 10 }).passedLabel).toBe('5 of 10');
  });

  it('refuses to show a pass count with no denominator', () => {
    expect(benchmarkSummary('complete', { passed: 8 }).passedLabel).toBe('Not reported');
    expect(benchmarkSummary('complete', { passed: 8, total: null }).passedLabel).toBe('Not reported');
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

    expect(summary.groundednessLabel).toBe('2 of 5 scored');
    expect(summary.relevanceLabel).toBe('5 of 5 scored');
    expect(summary.groundednessLabel).not.toContain('6');
  });

  it('never borrows the case count as a rubric population', () => {
    // The conflation this replaces: a rate computed over the cases a judge
    // reached, displayed as a rate over every case in the suite.
    const summary = benchmarkSummary('complete', { groundedness: 0.92, total: 10 });
    expect(summary.groundednessLabel).not.toContain('10');
    expect(summary.groundednessLabel).toContain('population not reported');
  });

  it('keeps a judge that did not apply apart from a judge that said no', () => {
    const summary = benchmarkSummary('complete', {
      total: 6,
      guidelines: 1,
      judgeRates: { guidelines: { rate: 1, scored: 1, yes: 1, no: 0, notApplicable: 5, errored: 0 } },
    });

    // The governance refusal is scored by guidelines alone, so a judge that did
    // not apply being counted as a failure is what would make a correct refusal
    // impossible to pass.
    expect(summary.guidelinesLabel).toBe('1 of 1 scored');
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

    expect(summary.runCaveat).toContain('one run');
    expect(summary.runCaveat).toContain('version 9');
    expect(summary.runCaveat).toContain('varies between runs');
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
    expect(benchmarkSummary('complete', { groundedness: 0.92 }).groundednessLabel).toBe('92% (population not reported)'
    );
  });

  it('reports a self-contradicting run instead of displaying it', () => {
    const summary = benchmarkSummary('complete', { passed: 12, total: 10 });
    expect(summary.contradiction).toContain('12 passes out of 10 cases');
    // And it does not print the impossible fraction as though it were a result.
    expect(summary.passedLabel).toBe('Not reported');
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
    expect(first.passedLabel).toBe('4 of 6');
    expect(first.groundednessLabel).toBe('4 of 5 scored');
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
