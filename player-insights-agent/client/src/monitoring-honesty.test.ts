import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  answerTimeTile,
  askerGrantsLine,
  conditioningLine,
  emptyCopy,
  medianAnswerTimeTile,
  monitoringState,
  outcomeTile,
  partialSentence,
  PERCENTILE_FLOOR,
  grantBadge,
  NO_FIGURE,
  ratedHelpfulTile,
  ratedTile,
  readScopes,
  tablesReadTile,
  tokenCostTile,
  tokensTile,
} from './monitoring-view';
import * as viewModule from './monitoring-view';
import { classifyOutcome, classifyRefusal, codesForCause, applyAdminOutcome } from '../../shared/monitoring-contract';
import type { MonitoringSummary } from '../../shared/monitoring-contract';

/**
 * The claims Monitoring is allowed to make about its own numbers.
 *
 * Each of these has been got wrong somewhere in this app before, which is why
 * they are asserted rather than left to review. The two that matter most:
 * a share never renders without the population it is a share of, and refused
 * never gets added to failed.
 */

function summary(overrides: Partial<MonitoringSummary> = {}): MonitoringSummary {
  return {
    questionsAsked: 0,
    peopleAsking: 0,
    completed: 0,
    partial: 0,
    refused: 0,
    failed: 0,
    ratedUp: 0,
    ratedTotal: 0,
    medianMs: null,
    timedCount: 0,
    ...overrides,
  };
}

describe('a rate never renders without its population', () => {
  it('shows no percentage at all when nothing was rated', () => {
    const tile = ratedHelpfulTile(summary({ questionsAsked: 214 }));

    expect(tile.value).toBeNull();
    expect(tile.absence).toBe('Not rated yet');
    // And it does not print a zero, which would read as a quality score.
    expect(tile.absence).not.toMatch(/0\s*%/);
    expect(tile.caption).toBe('');
  });

  it('names the denominator beside every share it does print', () => {
    const tile = ratedHelpfulTile(summary({ questionsAsked: 214, ratedUp: 36, ratedTotal: 46 }));

    expect(tile.value).toBe('78%');
    expect(tile.caption).toBe('of 46 rated answers');
  });

  /**
   * The specific shape that makes a bare percentage dangerous: a handful of
   * ratings over hundreds of questions. The share is still printed, because it is
   * a real share, and it is printed with the four it is a share of.
   */
  it('prints a share over four ratings with the four on screen', () => {
    const tile = ratedHelpfulTile(summary({ questionsAsked: 400, ratedUp: 3, ratedTotal: 4 }));

    expect(tile.value).toBe('75%');
    expect(tile.caption).toContain('of 4 rated answers');
  });

  it('says a median is over fewer runs than were asked', () => {
    const tile = medianAnswerTimeTile(summary({ questionsAsked: 40, medianMs: 41_000, timedCount: 8 }));

    expect(tile.value).toBe('41.0s');
    expect(tile.caption).toBe('over 8 of 40 runs');
  });

  it('refuses a median when nothing recorded a run time', () => {
    const tile = medianAnswerTimeTile(summary({ questionsAsked: 12 }));

    expect(tile.value).toBeNull();
    expect(tile.absence).toBe('No run times recorded');
  });

  it('names the token coverage even when it is complete', () => {
    expect(tokensTile({ total: 412_000, metredRuns: 41, totalRuns: 41 }).caption).toBe('over 41 of 41 runs');
    expect(tokensTile({ total: 412_000, metredRuns: 38, totalRuns: 41 }).caption).toBe('over 38 of 41 runs');
  });

  /**
   * A zero and an unknown look identical inside a sum, so a range where nothing
   * was metred reports the total as unknown rather than as zero.
   */
  it('reports an unmetred range as unknown rather than as zero tokens', () => {
    const tile = tokensTile({ total: 0, metredRuns: 0, totalRuns: 41 });

    expect(tile.value).toBeNull();
    expect(tile.absence).toBe('Not metred');
    expect(tile.caption).toBe('');
  });

  /**
   * A mark and three words, where this used to be a paragraph.
   *
   * It read "Price not configured" over "the endpoint has no list price recorded,
   * so this cannot be computed": a sentence and a half about the absence of a
   * number, on the one tile in the grid with nothing to report. The mark says
   * there is no figure and the caption says what is missing, which is the shape
   * the Ops latency block uses for a percentile it will not print.
   */
  it('marks an unpriced cost rather than explaining it at length', () => {
    const tile = tokenCostTile(null);

    expect(tile.value).toBe(NO_FIGURE);
    expect(tile.absence).toBeNull();
    expect(tile.caption).toBe('no price configured');
    // Still never a zero. A free answer and an uncomputable one are not the same.
    expect(tile.value).not.toContain('$0');
    // An em dash is banned in this file, so the mark is the en dash.
    expect(tile.value).not.toBe('\u2014');
    expect(tile.caption.split(' ')).toHaveLength(3);
  });

  it('prints the cost where a price is configured', () => {
    expect(tokenCostTile(3.84).value).toBe('$3.84');
    expect(tokenCostTile(3.84).caption).toBe('at list price · USD');
  });

  it('says nothing was rated rather than rating zero', () => {
    expect(ratedTile(0, 0).value).toBeNull();
    // Up and down, never netted into one number.
    expect(ratedTile(7, 2).caption).toBe('7 up · 2 down');
  });

  it('says no sources were recorded rather than showing no tables', () => {
    const tile = tablesReadTile([]);

    expect(tile.table).toBeNull();
    expect(tile.absence).toBe('No sources recorded');
    expect(tile.caption).toBe('');
  });
});

describe('a scope badge is only listed where runs carried it', () => {
  it('lists the identity a run recorded and nothing about the runs that did not', () => {
    const scopes = readScopes({
      executionSplit: { asThemselves: 40, asApplication: 0 },
      subjectSplit: { verified: 39, confirmedByEndpoint: 0 },
    });

    expect(scopes.map((scope) => scope.label)).toEqual([
      'Their own Unity Catalog grants',
      'Sign-in verified on the token',
    ]);
    expect(scopes[0].runs).toBe('40 runs');
    // Nothing counts a bucket the runs did not fill, so no badge can read as a
    // doubt about the one run that recorded nothing.
    expect(scopes).toHaveLength(2);
  });

  it('offers no badge at all over a range with no runs', () => {
    expect(
      readScopes({
        executionSplit: { asThemselves: 0, asApplication: 0 },
        subjectSplit: { verified: 0, confirmedByEndpoint: 0 },
      })
    ).toEqual([]);
  });

  it('agrees with the run count on singular and plural', () => {
    const scopes = readScopes({
      executionSplit: { asThemselves: 1, asApplication: 0 },
      subjectSplit: { verified: 0, confirmedByEndpoint: 0 },
    });

    expect(scopes[0].runs).toBe('1 run');
  });

  /**
   * Both modes are configured behaviour of this app, so neither is red. The
   * application's grants and an endpoint-confirmed subject take the neutral tone,
   * which is an outline and no fill.
   */
  it('paints no mode of running as a fault', () => {
    const scopes = readScopes({
      executionSplit: { asThemselves: 30, asApplication: 11 },
      subjectSplit: { verified: 38, confirmedByEndpoint: 3 },
    });

    expect(scopes.map((scope) => scope.tone)).toEqual(['ok', 'neutral', 'ok', 'neutral']);
    expect(scopes.map((scope) => scope.tone)).not.toContain('bad');
  });

  /** The gate is off, so no badge may count what it checked. */
  it('offers no access-gate scope for a switched-off gate', () => {
    const scopes = readScopes({
      executionSplit: { asThemselves: 41, asApplication: 0 },
      subjectSplit: { verified: 41, confirmedByEndpoint: 0 },
    });

    for (const scope of scopes) {
      expect(scope.label.toLowerCase()).not.toContain('gate');
      expect(scope.label.toLowerCase()).not.toContain('skipped');
    }
  });
});

describe('a table badge states what was established and nothing more', () => {
  it('reads a table that was never probed as not checked, not as a denial', () => {
    expect(grantBadge({ canRead: false, missing: 'Not checked' })).toEqual({
      label: 'Not checked',
      tone: 'neutral',
    });
  });

  it('still reports a real denial as one', () => {
    expect(grantBadge({ canRead: false, missing: 'SELECT missing' })).toEqual({
      label: 'Cannot read',
      tone: 'bad',
    });
    expect(grantBadge({ canRead: true, missing: null })).toEqual({ label: 'Can read', tone: 'ok' });
  });
});

describe('run outcomes remain separate', () => {
  it('reports the four separately and offers no total', () => {
    const tile = outcomeTile(summary({ questionsAsked: 214, completed: 190, partial: 6, refused: 11, failed: 7 }));

    expect(tile.completed).toBe('190');
    expect(tile.partial).toBe('6');
    expect(tile.refused).toBe('11');
    expect(tile.failed).toBe('7');
    // 11 + 7. Nothing in the tile may be the two added together.
    expect(Object.values(tile)).not.toContain('18');
  });

  it('claims they sum to the questions asked only when they do', () => {
    const exact = outcomeTile(summary({ questionsAsked: 214, completed: 190, partial: 6, refused: 11, failed: 7 }));

    expect(exact.caption).toBe('');
  });

  it('names an unaccounted remainder rather than claiming a false sum', () => {
    const mixed = outcomeTile(summary({ questionsAsked: 214, completed: 189, partial: 6, refused: 11, failed: 7 }));

    expect(mixed.caption).not.toContain('sum to questions asked');
    expect(mixed.caption).toBe('1 more has no recorded outcome');
  });

  it('keeps the two refusal causes on separate code lists', () => {
    const grant = codesForCause('missing-grant');
    const rules = codesForCause('agent-rules');

    expect(grant).toContain('USER_NOT_AUTHORIZED');
    expect(rules).toContain('ASSET_NOT_IN_MANIFEST');
    expect(rules).toContain('COLUMN_POLICY_VIOLATION');
    // No code may be counted in both tiles, or the two counts overlap.
    expect(grant.filter((code) => rules.includes(code))).toEqual([]);
  });

  /**
   * An identity refusal and a malformed idempotency key are refusals, and neither
   * is about what the reader may read. Counting them in either tile would make
   * that tile's caption false.
   */
  it('leaves refusals that are about neither grants nor agent rules out of both', () => {
    expect(classifyRefusal('IDENTITY_REQUIRED')).toBe('other');
    expect(classifyRefusal('IDEMPOTENCY_CONFLICT')).toBe('other');
    expect(classifyRefusal('RELEASE_NOT_CERTIFIED')).toBe('other');
  });
});

describe('a percentile under twenty runs becomes the slowest run', () => {
  it('labels the slowest run instead of naming a percentile', () => {
    const tile = answerTimeTile([3_000, 9_000, 41_000, 84_000, 120_000]);

    expect(tile.value).toBe('41.0s');
    expect(tile.tail).toContain('was the slowest run');
    // No percentile VALUE is reported. The phrase is only allowed in the
    // sentence that says one is not being given.
    expect(tile.tail).not.toContain('at the 95th percentile');
    expect(tile.tail).not.toContain('95th percentile is not reported');
  });

  it('reports a real percentile once there are enough runs', () => {
    const many = Array.from({ length: 40 }, (_value, index) => (index + 1) * 1_000);
    const tile = answerTimeTile(many);

    expect(tile.tail).toContain('at the 95th percentile');
    expect(tile.tail).not.toContain('slowest run');
  });

  it('says nothing was recorded rather than reporting a zero', () => {
    expect(answerTimeTile([]).value).toBeNull();
  });
});

describe('the two empties are different sentences', () => {
  it('separates an empty range from a filter that excludes everything', () => {
    const range = emptyCopy('empty-range');
    const filters = emptyCopy('empty-filters');

    expect(range.sentence).toBe('No questions in this range.');
    expect(filters.sentence).toBe('No questions match these filters.');
    expect(range.sentence).not.toBe(filters.sentence);
    // Only the filter case offers a way out of it.
    expect(filters.clearFilters).toBe(true);
    expect(range.clearFilters).toBe(false);
  });

  it('classifies each state from the read and the filters', () => {
    const base = { loading: false, rowCount: 0, filtersActive: false } as const;

    expect(monitoringState({ ...base, loading: true, readState: 'ok' })).toBe('loading');
    expect(monitoringState({ ...base, readState: 'unavailable' })).toBe('unavailable');
    // A read that never happened is unavailable, not empty. Zero rows is the
    // answer to two different questions and only the server can tell them apart.
    expect(monitoringState({ ...base, readState: null })).toBe('unavailable');
    expect(monitoringState({ ...base, readState: 'ok' })).toBe('empty-range');
    expect(monitoringState({ ...base, readState: 'ok', filtersActive: true })).toBe('empty-filters');
    expect(monitoringState({ ...base, readState: 'partial', rowCount: 3 })).toBe('partial');
    expect(monitoringState({ ...base, readState: 'ok', rowCount: 3 })).toBe('ready');
  });

  it('says what a partial read counted and what it found', () => {
    expect(partialSentence(2000, 5312)).toContain('Counted 2,000 of 5,312 questions');
    // Never a count with no denominator at all.
    expect(partialSentence(2000, null)).toContain('those 2,000');
  });
});

/**
 * The withdrawn line about the size of the window.
 *
 * `slowRangeLine` printed "N questions in this range. This read slows as that
 * number grows." past 500 questions. It was a stand-in for a guard, and it was
 * true when written: the pairing joined on the result of a correlated subquery,
 * so no index could serve it and an all-time window paid once per question.
 *
 * The query now pages first and pairs per page, so the answer-side work is
 * bounded by the page and that growth does not happen. This test is what stops
 * the next audit restoring the line as a missing element. The load-bearing limit
 * is the server's read cap, and `partialSentence` above is what states it.
 */
describe('the withdrawn line about the size of the window', () => {
  it('exports nothing that warns about the range being large', () => {
    const view = viewModule as Record<string, unknown>;

    expect(view.slowRangeLine).toBeUndefined();
    expect(view.SLOW_RANGE_QUESTIONS).toBeUndefined();
  });

  /** The cap the page does still state, so removing the stale line kept the real one. */
  it('still says what a partial read counted', () => {
    expect(partialSentence(2000, 40_000)).toContain('Counted 2,000 of 40,000 questions');
  });
});

describe('an outcome is what a store recorded, never the good case by default', () => {
  it('prefers the run ledger over the stored trace', () => {
    expect(classifyOutcome({ runState: 'REFUSED', hasStoredAnswer: true })).toBe('refused');
    expect(classifyOutcome({ runState: 'SUCCEEDED', hasStoredAnswer: true })).toBe('completed');
    expect(classifyOutcome({ runState: 'DEADLINE_EXCEEDED' })).toBe('failed');
    expect(classifyOutcome({ runState: 'PERSISTENCE_FAILED' })).toBe('failed');
  });

  it('files clarification and cancellation as partial', () => {
    expect(classifyOutcome({ runState: 'CLARIFICATION_REQUIRED' })).toBe('partial');
    expect(classifyOutcome({ runState: 'CANCELLED' })).toBe('partial');
  });

  it('falls back to the trace for a question asked before the ledger existed', () => {
    expect(classifyOutcome({ hasStoredAnswer: true, traceHasFailedStage: false })).toBe('completed');
    expect(classifyOutcome({ hasStoredAnswer: true, traceHasPartialStage: true })).toBe('partial');
    expect(classifyOutcome({ hasStoredAnswer: true, traceHasFailedStage: true })).toBe('failed');
    expect(
      classifyOutcome({
        hasStoredAnswer: true,
        traceHasFailedStage: true,
        answerLanded: true,
      })
    ).toBe('completed');
    expect(
      classifyOutcome({
        hasStoredAnswer: true,
        synthesisIncomplete: true,
        answerLanded: true,
      })
    ).toBe('partial');
    expect(
      classifyOutcome({
        hasStoredAnswer: true,
        traceHasPartialStage: true,
        synthesisIncomplete: false,
        answerLanded: true,
      })
    ).toBe('completed');
    expect(
      classifyOutcome({
        runState: 'SUCCEEDED',
        hasStoredAnswer: true,
        traceHasFailedStage: true,
        answerLanded: true,
      })
    ).toBe('completed');
    expect(classifyOutcome({ runState: 'DEADLINE_EXCEEDED', answerLanded: true })).toBe('partial');
    expect(
      classifyOutcome({
        hasStoredAnswer: true,
        proseOnlyDegraded: true,
        answerLanded: true,
      })
    ).toBe('partial');
  });

  /**
   * The case worth being strict about. A question with no ledger row and no
   * stored answer is a question whose outcome nobody recorded, and calling it
   * answered would be the app claiming an answer that does not exist.
   */
  it('never assumes an answer for a question with nothing recorded', () => {
    expect(classifyOutcome({})).toBe('partial');
    expect(classifyOutcome({ hasStoredAnswer: false })).toBe('partial');
    expect(classifyOutcome({ runState: 'RUNNING' })).toBe('partial');
  });

  it('shows an administrator’s Complete on the same outcome the lists read', () => {
    expect(applyAdminOutcome('partial', 'complete')).toBe('completed');
    expect(applyAdminOutcome('partial', null)).toBe('partial');
  });
});

describe('the wording rules', () => {
  const FILES = ['monitoring-view.ts', 'monitoring-filters.ts', 'MonitoringPage.tsx'];

  function source(name: string): string {
    return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
  }

  /**
   * Asserted against source rather than against a render, because the rule is
   * about every string in these files including the ones only one state reaches.
   */
  it.each(FILES)('%s contains no em dash', (file) => {
    expect(source(file)).not.toContain('\u2014');
  });

  it('reuses the existing footer wording rather than inventing a second one', () => {
    // The ordinary case names the asker rather than the reader.
    expect(askerGrantsLine({ mode: 'signed_in_user', verified: true }, 'user.a')).toBe(
      "Data read under user.a's own Unity Catalog grants."
    );
  });

  it('says nothing about the identity of a run that did not record one', () => {
    // The line here used to read "The identity this data was read as is
    // unconfirmed." On this page of all pages that was the wrong thing to print:
    // Monitoring knows who asked, so doubting the identity beside their name
    // reads as a suggestion that their question was answered as someone else.
    // The segment is dropped instead, and the asker's name is NOT substituted --
    // a run with no recorded identity is the one run it might not describe.
    expect(askerGrantsLine(null, 'user.a')).toBeNull();
    expect(askerGrantsLine({ mode: 'on_behalf_of_group', verified: true }, 'user.a')).toBeNull();
  });

  it('leaves no sentence anywhere on these surfaces that doubts the identity', () => {
    for (const file of FILES) {
      expect(source(file)).not.toMatch(/identity this data was read as/i);
      expect(source(file)).not.toMatch(/identity[^.]{0,40}\bis (?:unconfirmed|unverified|unknown)/i);
    }
  });

  it('names the table and the privilege in the conditioning line, with no tone', () => {
    const line = conditioningLine('a_catalog.a_schema.a_table', 'SELECT');

    expect(line).toBe('a_catalog.a_schema.a_table: you do not have SELECT on this table.');
    // No exclamation, no "denied", no "blocked". It is a statement of fact.
    expect(line).not.toMatch(/denied|blocked|error|warning/i);
  });

  /** "Not checked" always means not checked yet, and never broken. */
  it('never words an unchecked thing as a failure', () => {
    const view = source('monitoring-view.ts');

    expect(view).not.toMatch(/not checked.{0,24}(failed|broken|error)/i);
  });
});
