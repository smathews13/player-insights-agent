/**
 * The held-out evaluation pane, and the claims it is not allowed to make.
 *
 * This suite runs in node with no DOM, so nothing below clicks anything. What
 * it does instead is render the section to static markup against real scorecard
 * shapes and assert what the reader ends up looking at -- which is the whole of
 * what this component does, since it holds no state and fires no effect.
 *
 * The tests that matter most are not about layout. A scorecard is the screen in
 * this app that most looks like evidence, so the failures worth pinning are the
 * ones where it says something true-looking and wrong: a scorer that cannot
 * report rendering as a pass, a rate rendering without the population it is
 * over, a latency rendering as though it were a quality score, or the
 * non-gating notice quietly disappearing so that a low number starts being
 * treated as a release gate.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HeldOutEvaluation } from './BenchmarkLab';
import { formatScore, scoreCoverage } from './benchmark-state';
import { NOT_PUBLISHED_REASON, evalScorecard } from './eval-scorecard';
import {
  SCORECARD_NON_GATING_NOTICE,
  SCORER_CATALOG,
  scorerDefinition,
  unimplementableScorers,
} from '../../shared/scorer-catalog';
import type { Scorecard, ScorecardState, ScorecardValue } from '../../shared/scorecard-contract';

function score(scorerId: string, overrides: Partial<ScorecardValue> = {}): ScorecardValue {
  return {
    scorerId,
    state: 'scored',
    value: 0.75,
    scored: 8,
    notApplicable: 4,
    errored: 0,
    reason: '',
    ...overrides,
  };
}

const PUBLISHED: Scorecard = {
  provenance: {
    evaluatedAt: new Date().toISOString(),
    agentCommit: 'abc1234',
    executedAs: 'someone@example.com',
    executedAsNote: 'An administrator, so the row filter did not apply to them.',
    judgeEndpoint: 'a-judge-endpoint',
    labelProvenance: 'Labels were written by a coding agent. No domain expert reviewed them.',
    labelsReviewed: false,
    labelReviewHeadline: 'These labels have not been reviewed by anyone who knows this data.',
    labelReviewConsequence: 'A high correctness rate means the answers agree with the repository, not that they are right.',
    labelSourceCounts: { 'data-query': 3, 'data-and-contract': 6, 'policy-document': 3 },
    heldOutFrom: 'The six cases of the POC benchmark suite.',
    producedBy: 'benchmark-runner',
    servedModel: 'the served model version 39',
    mlflowRunId: 'run-1',
    caseCount: 12,
  },
  aggregates: [
    score('sql_validity'),
    // Both judged scorers, because the per-row qualifier below is asserted
    // against them: a fixture carrying only deterministic scorers would let the
    // qualifier disappear from the judged rows without failing anything.
    score('correctness', { value: 0.78, scored: 9, notApplicable: 3 }),
    score('refusal_quality', { value: 1, scored: 2, notApplicable: 10 }),
    score('latency_ms', { value: 4200, notApplicable: 0, scored: 12 }),
    score('error_rate', { value: 0 }),
  ],
  cases: [],
};

function markup(state: ScorecardState) {
  return renderToStaticMarkup(<HeldOutEvaluation state={state} />);
}

describe('the non-gating notice', () => {
  it('is on the pane whether or not an evaluation has been published', () => {
    // The single most important sentence here. A scorecard that looks like a
    // release gate will be treated as one by the first person who reads it,
    // and then a low number starts blocking things nobody decided it should
    // block. It cannot be conditional on there being figures to qualify.
    for (const state of [evalScorecard(), { published: true, scorecard: PUBLISHED } as ScorecardState]) {
      expect(markup(state)).toContain('None of these scorers gates a release');
    }
  });

  it('says the non-gating decision was deliberate rather than unfinished', () => {
    // Without this, the honest reading of a non-gating scorecard is "they
    // haven't got round to wiring it up yet", and someone helpfully wires it up.
    expect(SCORECARD_NON_GATING_NOTICE).toContain('deliberate scope decision');
  });

  it('declares gating as false on every scorer rather than omitting it', () => {
    for (const definition of SCORER_CATALOG) expect(definition.gating).toBe(false);
  });
});

describe('scorers that cannot report', () => {
  it('never render as a value', () => {
    // The guardrail this lane turns on. A per-persona masking check run as an
    // administrator passes by construction, so any number at all against these
    // rows would be evidence of a property nobody established.
    const html = markup({ published: true, scorecard: PUBLISHED });
    for (const definition of unimplementableScorers()) {
      expect(html).toContain(definition.label);
      expect(html).toContain('Not reported');
    }
  });

  it('cannot be made to render a value by a scorecard that supplies one', () => {
    // Belt and braces against the failure that actually ships: a later change
    // starts writing a value for one of these, and the pane renders it because
    // it renders whatever it is given. Availability wins over the data.
    // Asserted as "the injected value changes nothing on screen" rather than as
    // "the string 100% is absent anywhere". The absence check was a proxy that
    // held only while no legitimate scorer reported a perfect rate; refusal
    // quality now does, on the real run, and a guardrail that a good result
    // breaks is a guardrail that gets deleted rather than read.
    const blocked = unimplementableScorers()[0];
    const withInjectedValue = markup({
      published: true,
      scorecard: { ...PUBLISHED, aggregates: [...PUBLISHED.aggregates, score(blocked.id, { value: 1 })] },
    });
    expect(withInjectedValue).toBe(markup({ published: true, scorecard: PUBLISHED }));
  });

  it('say in a sentence why, naming the missing restricted identity', () => {
    const html = markup({ published: true, scorecard: PUBLISHED });
    expect(html).toContain('no second, deliberately-restricted identity');
    expect(html).toContain('administrator passes a row-filter or masking');
  });

  it('are the three governed-access scorers and nothing else', () => {
    // Pinned so that a later change cannot quietly widen the set of things
    // this deployment declines to measure.
    expect(unimplementableScorers().map((entry) => entry.id).sort()).toEqual([
      'identity_mismatch',
      'persona_column_mask',
      'persona_row_filter',
    ]);
  });
});

describe('the unpublished state', () => {
  // Constructed rather than taken from `evalScorecard()`, which now returns a
  // real published scorecard. The unpublished branch still has to render
  // correctly: the generated file can be emptied or a run reverted, and the
  // pane's behaviour when it has no numbers is exactly when it is most tempting
  // to draw zeroes.
  const UNPUBLISHED: ScorecardState = { published: false, reason: NOT_PUBLISHED_REASON };

  it('says no evaluation has been published rather than drawing zeroes', () => {
    const html = markup(UNPUBLISHED);
    expect(html).toContain('No held-out evaluation has been published yet');
    expect(html).not.toContain('0%');
  });

  it('is not the state the app is actually in, now that a run has been published', () => {
    // The counterpart to the above: the committed scorecard has to parse and be
    // recognised, or the pane silently falls back to the honest-but-wrong
    // "nothing has been published" copy and the numbers vanish.
    expect(evalScorecard().published).toBe(true);
  });

  it('gives the governance reason rather than a bare unavailability', () => {
    // "Not available" reads as a promise that someone is working on it. The
    // real reason is that the agent refuses a caller it cannot identify, which
    // is the property the whole demo turns on, and saying so turns an absence
    // into a claim.
    expect(NOT_PUBLISHED_REASON).toContain('no service-principal fallback');
    expect(NOT_PUBLISHED_REASON).toContain('read governed data as a real signed-in caller');
  });

  it('still lists every scorer, so the set is visible before any number is', () => {
    const html = markup(UNPUBLISHED);
    for (const definition of SCORER_CATALOG) expect(html).toContain(definition.label);
  });
});

describe('published figures carry their population', () => {
  it('renders a rate as a percentage with what it is over', () => {
    const definition = scorerDefinition('sql_validity')!;
    expect(formatScore(definition, 0.75)).toBe('75%');
    expect(scoreCoverage(definition, score('sql_validity'))).toContain('8 of 12 cases');
  });

  it('renders a latency in its own unit, not as a rate', () => {
    // 4200 rendered as "420000%" beside a genuine percentage is the kind of
    // wrong that survives review because it is obviously wrong and therefore
    // assumed to be impossible.
    const definition = scorerDefinition('latency_ms')!;
    expect(formatScore(definition, 4200)).not.toContain('%');
  });

  it('renders an absent value as a dash and never as a zero', () => {
    // The rule the rest of this page already holds: a missing measurement and
    // a measured zero are different facts and must not share a glyph.
    for (const definition of SCORER_CATALOG) {
      expect(formatScore(definition, null)).toBe('—');
    }
  });

  it('describes an operational scorer as a median rather than a rate', () => {
    expect(scoreCoverage(scorerDefinition('total_tokens')!, score('total_tokens', { value: 900 }))).toContain('Median');
  });

  it('never leaves a figure without a caption', () => {
    // Every value on this table is either a rate or an absolute over some
    // population, and the population is the difference between a result and a
    // number. There is no branch that renders one without the other.
    for (const definition of SCORER_CATALOG) {
      expect(scoreCoverage(definition, null).length).toBeGreaterThan(0);
      expect(scoreCoverage(definition, score(definition.id)).length).toBeGreaterThan(0);
    }
  });
});

describe('what a published scorecard has to disclose', () => {
  it('says when it was produced and against which commit, because it is not live', () => {
    const html = markup({ published: true, scorecard: PUBLISHED });
    expect(html).toContain('Published, not live');
    expect(html).toContain('abc1234');
  });

  it('names the account it ran as, which qualifies every governed-access number', () => {
    const html = markup({ published: true, scorecard: PUBLISHED });
    expect(html).toContain('someone@example.com');
    expect(html).toContain('the row filter did not apply to them');
  });

  it('carries the label provenance, so a judged rate is not read as ground truth', () => {
    const html = markup({ published: true, scorecard: PUBLISHED });
    expect(html).toContain('No domain expert reviewed them');
  });

  it('says what the set is held out from', () => {
    expect(markup({ published: true, scorecard: PUBLISHED })).toContain('POC benchmark suite');
  });
});

describe('the unreviewed labels', () => {
  // The failure this guards against is not an absent disclosure. It is an
  // accurate one, placed where the reader who most needs it will not meet it:
  // four rows down a provenance ledger, below the numbers it qualifies. The
  // judged rates currently look respectable, and a respectable number graded
  // against a standard nobody has checked is more misleading than a poor one.
  const html = () => markup({ published: true, scorecard: PUBLISHED });

  it('is announced before any figure on the pane, not after them', () => {
    const rendered = html();
    const warning = rendered.indexOf('have not been reviewed');
    const firstFigure = rendered.indexOf('bench-scorer-name');
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(firstFigure);
  });

  it('says what the unreviewed labels do to a good-looking number', () => {
    // Without this sentence the banner reports a process fact. With it, the
    // reader knows a high correctness rate means agreement with the repository
    // rather than agreement with the truth.
    expect(html()).toContain('agree with the repository');
  });

  it('separates the labels a reader could check from the ones they could not', () => {
    // The distinction is the actionable part: a label settled by a query is
    // falsifiable by anyone with the warehouse, and a label read off a policy
    // document can only be agreed or disagreed with. It tells a reviewer which
    // third of the set to spend their scepticism on.
    const rendered = html();
    expect(rendered).toContain('settled by a query anyone can re-run');
    expect(rendered).toContain('rest on a reading of policy alone');
  });

  it('qualifies the judged scorers at the number as well as in the banner', () => {
    // A reader who scrolls to the percentage they care about must meet the
    // qualifier there. Both judged scorers carry it; the deterministic and
    // operational ones do not, because they are not graded against a label.
    const rendered = html();
    const notes = rendered.split('bench-unreviewed-note').length - 1;
    const judgedCount = SCORER_CATALOG.filter(
      (definition) => definition.kind === 'judged' && definition.availability !== 'unimplementable'
    ).length;
    expect(notes).toBe(judgedCount);
  });

  it('disappears only when a scorecard actually records a review', () => {
    // The banner must be driven by the recorded fact rather than hardcoded, so
    // that a reviewed set stops shouting -- and so that the only way to silence
    // it is to have done the review.
    const reviewed: Scorecard = {
      ...PUBLISHED,
      provenance: { ...PUBLISHED.provenance, labelsReviewed: true },
    };
    expect(markup({ published: true, scorecard: reviewed })).not.toContain('bench-labels-unreviewed');
    expect(markup({ published: true, scorecard: reviewed })).not.toContain('bench-unreviewed-note');
  });
});

describe('the kind of each scorer is legible on its own row', () => {
  it('labels every scorer deterministic, judged or operational', () => {
    const html = markup({ published: true, scorecard: PUBLISHED });
    for (const kind of ['deterministic', 'judged', 'operational']) expect(html).toContain(kind);
  });

  it('carries the kind as a word and not only as a colour', () => {
    // Status is never colour alone anywhere else on this page, and a reader who
    // cannot tell an amber pill from a green one still has to be able to tell a
    // model's opinion from a checked property.
    const html = markup({ published: true, scorecard: PUBLISHED });
    for (const definition of SCORER_CATALOG) {
      // The chip is on the row and names the kind. It is deliberately the
      // OUTLINED family for every kind: how a number was arrived at is not a
      // verdict on it, and a tinted chip there would be read as a score.
      expect(html).toContain(`ast-pill--neutral-outline bench-pill bench-kind-${definition.kind}`);
    }
    expect(html).toContain('>judged<');
    // Never tinted, which is the half of this that the line above would let
    // slip: a kind chip in a status family would be colour saying something
    // about a number that the number has not said.
    expect(html).not.toMatch(/ast-pill--(pos|neg|warn|info) bench-pill bench-kind-/);
  });

  it('says of the operational scorers that they are not quality', () => {
    // A fast wrong answer scores well on latency. If the pane does not say so,
    // a green latency row sits beside a red correctness row and reads as mixed
    // quality rather than as two unrelated facts.
    expect(scorerDefinition('latency_ms')!.meaning).toContain('not a statement');
    expect(scorerDefinition('error_rate')!.meaning).toContain('refusal');
  });
});

describe('the scorer set is the one the plan named', () => {
  it('covers every scorer X3 asked for', () => {
    // Named individually rather than counted, because a count passes while a
    // scorer is silently missing and this is the list the lane is judged on.
    const ids = new Set(SCORER_CATALOG.map((entry) => entry.id));
    for (const required of [
      'sql_validity',
      'correctness',
      'provenance_completeness',
      'tool_selection',
      'refusal_quality',
      'identity_mismatch',
      'persona_row_filter',
      'persona_column_mask',
      'coverage_caveat',
      'semantic_recall',
      'stale_index',
      'latency_ms',
      'total_tokens',
      'warehouse_calls',
      'error_rate',
    ]) {
      expect(ids.has(required), `${required} is missing from the catalog`).toBe(true);
    }
  });

  it('gives every scorer a meaning a reader could act on', () => {
    for (const definition of SCORER_CATALOG) {
      expect(definition.meaning.length).toBeGreaterThan(40);
      expect(definition.label.length).toBeGreaterThan(0);
    }
  });

  it('gives a reason to exactly those scorers that report nothing', () => {
    for (const definition of SCORER_CATALOG) {
      const blocked = definition.availability === 'unimplementable';
      expect(definition.blockedReason.length > 0).toBe(blocked);
    }
  });
});
