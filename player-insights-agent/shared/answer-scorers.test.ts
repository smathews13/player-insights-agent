/**
 * The scorers, against the shared conformance fixture and against the two rules
 * they are not allowed to break.
 *
 * Three things are pinned here, in descending order of how much damage the
 * failure would do:
 *
 *   A scorer that cannot measure something must abstain, and the abstention has
 *   to survive. The fixture asserts `null` as strictly as it asserts `true`,
 *   because an abstention that quietly became a pass is how a scorecard starts
 *   reporting coverage it does not have.
 *
 *   A rationale must not carry the question or the answer. Evaluation records
 *   are operational records; if one can be read back into what a customer asked
 *   or which player a figure was about, the record has become the leak. The
 *   sweep below is deliberately blunt and runs over every rationale the module
 *   can produce.
 *
 *   The scorer ids must be the catalog's ids. The catalog is what the Benchmark
 *   Lab renders, so a scorer reported under a name it does not declare renders
 *   as nothing at all -- silently, and looking like an absent measurement rather
 *   than a wiring bug.
 */
import { describe, expect, it } from 'vitest';

import {
  ANSWER_SCORERS,
  WITHHELD_COLUMNS,
  observedRoutes,
  scoreCase,
  type AnswerEnvelope,
  type CaseExpectations,
} from './answer-scorers';
import conformance from './eval-conformance.json';
import { SCORER_CATALOG, unimplementableScorers } from './scorer-catalog';

interface ConformanceCase {
  name: string;
  only?: 'python' | 'node';
  envelope: AnswerEnvelope;
  expectations: CaseExpectations;
  expect: Record<string, number | boolean | null>;
}

const ALL_CASES = conformance.cases as unknown as ConformanceCase[];
const CASES = ALL_CASES.filter((entry) => entry.only !== 'python');

describe('the conformance fixture', () => {
  it.each(CASES.map((entry) => [entry.name, entry] as const))('holds for %s', (_name, entry) => {
    const verdicts = scoreCase(entry.envelope, entry.expectations);
    for (const [scorerId, expected] of Object.entries(entry.expect)) {
      const verdict = verdicts[scorerId];
      expect(verdict, `${scorerId} is not implemented in this process`).toBeDefined();
      // Asserted through `value` and `state` together: a scorer that returned
      // the right number in the wrong state is still wrong, because the state
      // is what the scorecard renders as an abstention.
      expect(verdict.value, `${scorerId}: ${verdict.rationale}`).toBe(expected);
      expect(verdict.state).toBe(expected === null ? 'not-applicable' : 'scored');
    }
  });

  it('excludes a case from one side only for the one recorded divergence', () => {
    // `only` is the escape hatch that could quietly turn the fixture into two
    // fixtures. Pinning which scorer may use it means the next divergence has
    // to be argued for here rather than added in passing.
    for (const entry of ALL_CASES.filter((candidate) => candidate.only)) {
      expect(Object.keys(entry.expect), `${entry.name} is excluded for more than sql_validity`).toEqual([
        'sql_validity',
      ]);
    }
  });

  it('covers every scorer this process implements', () => {
    // Otherwise a scorer can be added on one side, go unpinned, and drift from
    // the Python for as long as nobody compares two runs by hand.
    const pinned = new Set(CASES.flatMap((entry) => Object.keys(entry.expect)));
    expect([...Object.keys(ANSWER_SCORERS)].filter((id) => !pinned.has(id))).toEqual([]);
  });
});

describe('what a rationale may say', () => {
  // Every string the module can emit, over inputs that carry a question and an
  // answer, plus the identifiers a rationale must never name.
  const rationales = CASES.flatMap((entry) =>
    Object.values(scoreCase(entry.envelope, entry.expectations)).map((verdict) => verdict.rationale)
  );

  it('never quotes the answer text back', () => {
    const answerText = CASES.flatMap((entry) => [
      typeof entry.envelope.answer?.takeaway === 'string' ? entry.envelope.answer.takeaway : '',
      typeof entry.envelope.answer?.narrative === 'string' ? entry.envelope.answer.narrative : '',
      typeof entry.envelope.question === 'string' ? entry.envelope.question : '',
      typeof entry.envelope.message === 'string' ? entry.envelope.message : '',
    ]).filter((value) => value.trim().length > 0);

    for (const rationale of rationales) {
      for (const sentence of answerText) {
        expect(rationale, `rationale quoted answer text: ${rationale}`).not.toContain(sentence);
      }
    }
  });

  it('never names a withheld column, not even to report finding one', () => {
    // The rationale on a failing `sql_validity` is the tempting place to name
    // the column, and it is exactly the wrong place: the record would then hold
    // the identifier the statement was refused for carrying.
    for (const rationale of rationales) {
      for (const column of WITHHELD_COLUMNS) {
        expect(rationale.toLowerCase(), `rationale named ${column}: ${rationale}`).not.toContain(column);
      }
    }
  });

  it('never carries a figure value from a row', () => {
    for (const rationale of rationales) {
      expect(rationale).not.toContain('$1');
    }
  });
});

describe('the scorer ids', () => {
  it('are all declared by the catalog the Benchmark Lab renders', () => {
    const declared = new Set(SCORER_CATALOG.map((definition) => definition.id));
    expect([...Object.keys(ANSWER_SCORERS)].filter((id) => !declared.has(id))).toEqual([]);
  });

  it('do not include a scorer the catalog says cannot be run honestly here', () => {
    // The three persona scorers need a second, deliberately-restricted identity
    // that this deployment does not have. Implementing one anyway would produce
    // a check an administrator passes by construction, which is worse than an
    // absent measurement because it looks like a present one.
    const blocked = unimplementableScorers().map((definition) => definition.id);
    expect(blocked.length).toBeGreaterThan(0);
    for (const id of blocked) {
      expect(ANSWER_SCORERS[id], `${id} is declared unimplementable but has an implementation`).toBeUndefined();
    }
  });
});

describe('the route vocabulary', () => {
  it('reads a run that reached nothing as having reached nothing, rather than as an empty set', () => {
    // An empty set would make `toolSelection` pass any case whose expected
    // routes were also empty, which is the same silent pass the abstention
    // rules exist to prevent.
    expect([...observedRoutes({ type: 'refusal' })]).toEqual(['none']);
  });
});
