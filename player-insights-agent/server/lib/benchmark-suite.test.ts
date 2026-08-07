import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CASE_CATALOG,
  CANONICAL_SUITE,
  canonicalSuite,
  catalogFallbackCases,
  resolveSuiteCases,
} from './benchmark-suite';

/** The six ids both stored suites carry in `cases_json`. */
const STORED_CASE_IDS = [
  { id: 'player-count' },
  { id: 'dictionary-lookup' },
  { id: 'cross-title' },
  { id: 'data-quality' },
  { id: 'visualization' },
  { id: 'access-boundary' },
];

describe('the case catalog', () => {
  it('covers every id the stored suites name', () => {
    const known = new Set(BENCHMARK_CASE_CATALOG.map((entry) => entry.id));
    for (const stored of STORED_CASE_IDS) expect(known.has(stored.id)).toBe(true);
  });

  it('gives every case a question and at least one guideline', () => {
    for (const entry of BENCHMARK_CASE_CATALOG) {
      expect(entry.question.trim().length).toBeGreaterThan(0);
      expect(entry.guidelines.length).toBeGreaterThan(0);
      expect(entry.judges.length).toBeGreaterThan(0);
    }
  });

  it('states no expected figure anywhere', () => {
    // The Unity Catalog data is regenerated, so an expectation naming a number
    // would have to be rewritten each time and would silently start failing
    // when it was not. Digits in a *question* are fine ("last 30 days"); an
    // expectation asserting one is not.
    for (const entry of BENCHMARK_CASE_CATALOG) {
      for (const guideline of entry.guidelines) {
        expect(guideline, `${entry.id} guideline names a figure: ${guideline}`).not.toMatch(/\d/);
      }
    }
  });

  it('applies only the guidelines rubric to the governance refusal, with a stated reason for each omission', () => {
    const refusal = BENCHMARK_CASE_CATALOG.find((entry) => entry.id === 'access-boundary');
    expect(refusal?.judges).toEqual(['guidelines']);
    // The omissions are the load-bearing part: a refusal scored by
    // groundedness or relevance would fail for being correct. Each must say why
    // it does not apply, so a not-applicable score is never a bare gap.
    expect(refusal?.judgeNotes?.groundedness).toBeTruthy();
    expect(refusal?.judgeNotes?.relevance_to_context).toBeTruthy();
    expect(refusal?.structuralChecks).toEqual([]);
  });

  it('does not require figures of the definitional case', () => {
    // A correct answer to "which identifier should count unique players" is
    // prose, so a figures check would fail it for being right.
    const lookup = BENCHMARK_CASE_CATALOG.find((entry) => entry.id === 'dictionary-lookup');
    expect(lookup?.structuralChecks).toEqual([]);
  });

  it('checks for a chart deterministically rather than asking a judge', () => {
    const visualization = BENCHMARK_CASE_CATALOG.find((entry) => entry.id === 'visualization');
    expect(visualization?.structuralChecks).toContain('has-charts');
    for (const guideline of visualization?.guidelines ?? []) {
      expect(guideline.toLowerCase()).not.toContain('chart');
    }
  });
});

describe('suite identity', () => {
  it('resolves both stored ids to one suite', () => {
    // `poc-benchmark` is re-seeded by the app's DDL on every boot and
    // `executive-poc` also sits in the store with a byte-identical case list.
    // Two names for one thing is a question nobody can answer mid-demo.
    expect(canonicalSuite('poc-benchmark')).toEqual(CANONICAL_SUITE);
    expect(canonicalSuite('executive-poc')).toEqual(CANONICAL_SUITE);
    expect(canonicalSuite('  executive-poc ')).toEqual(CANONICAL_SUITE);
  });

  it('refuses an id it does not know rather than running a default suite', () => {
    expect(canonicalSuite('made-up')).toBeNull();
  });
});

describe('resolving cases', () => {
  it('fills questions from the catalog when the row carries ids only', () => {
    const resolved = resolveSuiteCases(STORED_CASE_IDS);
    expect(resolved).toHaveLength(6);
    expect(resolved.every((entry) => entry.question !== null)).toBe(true);
    expect(resolved.every((entry) => entry.questionSource === 'catalog')).toBe(true);
  });

  it('lets the suite row override the catalog question', () => {
    const [resolved] = resolveSuiteCases([{ id: 'player-count', question: 'Ask it this instead.' }]);
    expect(resolved.question).toBe('Ask it this instead.');
    expect(resolved.questionSource).toBe('suite-row');
    // The catalog's rubric declaration still applies: the row overrode the
    // question, not what it means to answer it well.
    expect(resolved.guidelines).toEqual(
      BENCHMARK_CASE_CATALOG.find((entry) => entry.id === 'player-count')?.guidelines
    );
  });

  it('lets the suite row override the guideline too', () => {
    const [resolved] = resolveSuiteCases([
      { id: 'player-count', question: 'Q', guidelines: ['Answer in one sentence.'] },
    ]);
    expect(resolved.guidelines).toEqual(['Answer in one sentence.']);
  });

  it('accepts a single guideline string as well as a list', () => {
    const [resolved] = resolveSuiteCases([{ id: 'cross-title', guidelines: 'Just the one.' }]);
    expect(resolved.guidelines).toEqual(['Just the one.']);
  });

  it('keeps an id it cannot resolve instead of dropping it', () => {
    const resolved = resolveSuiteCases([{ id: 'player-count' }, { id: 'ghost-case' }]);
    expect(resolved).toHaveLength(2);
    const ghost = resolved[1];
    // Dropping it would make the suite quietly shorter, so a run could report
    // "all cases passed" over a list that lost one.
    expect(ghost.question).toBeNull();
    expect(ghost.questionSource).toBeNull();
  });

  it('scores an unknown id that brought its own question with the rubrics that still apply', () => {
    const [resolved] = resolveSuiteCases([{ id: 'ghost-case', question: 'Q' }]);
    expect(resolved.question).toBe('Q');
    // No guideline was supplied and the catalog has none for this id, so the
    // guidelines rubric is not attempted; the other two need only Q and A.
    expect(resolved.judges).toEqual(['groundedness', 'relevance_to_context']);
  });

  it('ignores entries with no id and non-array case lists', () => {
    expect(resolveSuiteCases([{ question: 'orphan' }, { id: '  ' }])).toEqual([]);
    expect(resolveSuiteCases(null)).toEqual([]);
    expect(resolveSuiteCases('[]')).toEqual([]);
  });

  it('offers the catalog as a fallback case list', () => {
    expect(catalogFallbackCases()).toHaveLength(BENCHMARK_CASE_CATALOG.length);
  });
});
