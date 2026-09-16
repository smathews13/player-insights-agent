/**
 * "Revise request", which used to do nothing a reader could see.
 *
 * The plan is now a ranked list of data sources. Revise opens a picker on those
 * sources plus a box for the sentence that is faster than a click ("don't use
 * X, also include Y"). The backend reads only that note, so the picker writes
 * into it rather than pasting an edited step list the agent would discard.
 *
 * There is no browser in this repo, so the three transitions are asserted on
 * the reducer the buttons dispatch into and on the request it composes, and the
 * wiring between the two is read off the card's source. See
 * plan-entities.test.ts, which makes the same trade for the same reason.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canSubmitRevision,
  displaySourceTitle,
  isPlanRevisionRequest,
  planRevisionReducer,
  planWithSelectedSource,
  ranSourceStepId,
  recommendedSourceId,
  revisedRequest,
  revisionFromPlan,
  sourceChanged,
  sourceChoiceNote,
  type PlanRevision,
} from './plan-revision';
import type { AnalysisPlan } from './app-types';

const CARD = readFileSync(new URL('./PlanCard.tsx', import.meta.url), 'utf8');

const PLAN: AnalysisPlan = {
  id: 'plan-1',
  question: 'How many customers play VLHO?',
  summary: 'Count distinct players who have ever played VLH Online, all-time.',
  steps: [
    {
      id: 'source-1',
      title: 'cdp_northwind_prod.gold_di.gtav_daily_summary (recommended)',
      description: 'brand_firstpartyid — the governed default unit for counting users. Why: franchise tag northwind.',
      kind: 'data',
    },
    {
      id: 'source-2',
      title: 'cdp_share_prod.global_production.play_by_title',
      description: 'gtao — per-customer flag for VLH Online play. Why: one row per customer across titles.',
      kind: 'data',
    },
  ],
  candidates: [
    {
      table: 'cdp_northwind_prod.gold_di.gtav_daily_summary',
      field: 'brand_firstpartyid',
      definition: 'The governed default unit for counting users.',
      why: 'Franchise tag Northwind.',
      recommended: true,
    },
    {
      table: 'cdp_share_prod.global_production.play_by_title',
      field: 'gtao',
      definition: 'Per-customer flag for VLH Online play.',
      why: 'One row per customer across titles.',
      recommended: false,
    },
  ],
  requires_approval: true,
  uses_conversation_context: false,
  uses_attachment_context: false,
};

/** The picker as the click leaves it. */
const opened = () => planRevisionReducer(null, { type: 'open', plan: PLAN }) as PlanRevision;

describe('clicking Revise request opens the plan as a source picker', () => {
  it('opens on the recommended source rather than on an empty box', () => {
    expect(opened().selectedStepId).toBe('source-1');
    expect(opened().note).toBe('');
    expect(recommendedSourceId(PLAN)).toBe('source-1');
    expect(displaySourceTitle(PLAN.steps[0].title)).toBe('cdp_northwind_prod.gold_di.gtav_daily_summary');
  });

  it('has nothing to send until the reader says something', () => {
    expect(canSubmitRevision(PLAN, opened())).toBe(false);
    expect(sourceChanged(PLAN, opened())).toBe(false);
  });

  it('takes a different source or a typed note as a revision', () => {
    const picked = planRevisionReducer(opened(), { type: 'select', id: 'source-2' }) as PlanRevision;
    const noted = planRevisionReducer(opened(), {
      type: 'note',
      note: 'Also break it out by platform.',
    }) as PlanRevision;

    expect(canSubmitRevision(PLAN, picked)).toBe(true);
    expect(canSubmitRevision(PLAN, noted)).toBe(true);
    expect(sourceChanged(PLAN, picked)).toBe(true);
    expect(sourceChoiceNote(PLAN, picked)).toBe(
      'Use cdp_share_prod.global_production.play_by_title.gtao instead of cdp_northwind_prod.gold_di.gtav_daily_summary.brand_firstpartyid.'
    );
  });

  it('names the field when two options come from the same table', () => {
    const sameTable: AnalysisPlan = {
      ...PLAN,
      steps: [
        PLAN.steps[0],
        { ...PLAN.steps[0], id: 'source-2', title: 'cdp_northwind_prod.gold_di.gtav_daily_summary' },
      ],
      candidates: [PLAN.candidates![0], { ...PLAN.candidates![0], field: 'platformid_accountid', recommended: false }],
    };
    const picked = planRevisionReducer(revisionFromPlan(sameTable), { type: 'select', id: 'source-2' }) as PlanRevision;

    expect(sourceChoiceNote(sameTable, picked)).toBe(
      'Use cdp_northwind_prod.gold_di.gtav_daily_summary.platformid_accountid instead of cdp_northwind_prod.gold_di.gtav_daily_summary.brand_firstpartyid.'
    );
  });

  it('wires the button to the picker rather than to the composer', () => {
    expect(CARD).toContain("dispatch({ type: 'open', plan })");
    expect(CARD).toContain('Revise request');
    expect(CARD).toContain("dispatch({ type: 'select', id: step.id })");
    expect(CARD).not.toContain("type: 'step'");
    expect(CARD).not.toContain("type: 'remove'");
    expect(CARD).not.toContain('.composer textarea');
  });
});

describe('sending a revision asks the revised question', () => {
  const revision = planRevisionReducer(planRevisionReducer(opened(), { type: 'select', id: 'source-2' }), {
    type: 'note',
    note: 'Don’t query the churn table.',
  }) as PlanRevision;
  const request = revisedRequest(PLAN, revision);

  it('carries the note and the chosen source, not a pasted step list', () => {
    expect(request).toContain('Don’t query the churn table.');
    expect(request).toContain(
      'Use cdp_share_prod.global_production.play_by_title.gtao instead of cdp_northwind_prod.gold_di.gtav_daily_summary.brand_firstpartyid.'
    );
    expect(request).not.toContain('Use these steps instead:');
  });

  it('restates the question, because the source alone does not say what it is for', () => {
    expect(request).toContain(PLAN.question);
  });

  it('asks for a plan rather than for the analysis', () => {
    expect(request).toContain('Do not run the analysis yet.');
  });

  it('sends only the note when the recommended source was left selected', () => {
    const justANote = planRevisionReducer(opened(), { type: 'note', note: 'Include console as well.' }) as PlanRevision;

    expect(revisedRequest(PLAN, justANote)).toContain('Include console as well.');
    expect(revisedRequest(PLAN, justANote)).not.toContain('instead of');
    expect(revisedRequest(PLAN, justANote)).not.toContain('Use these steps instead:');
  });

  it('is what the card hands the page, and the page asks it as a question', () => {
    expect(CARD).toContain('onRevise(revisedRequest(plan, revision))');
    const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
    expect(home).toContain('onRevise={(request) => onAsk(request)}');
  });
});

describe('cancelling returns to the plan the agent proposed', () => {
  it('closes the editor', () => {
    expect(planRevisionReducer(opened(), { type: 'cancel' })).toBeNull();
  });

  it('keeps no draft behind the closed editor', () => {
    const edited = planRevisionReducer(opened(), { type: 'note', note: 'Scrap this.' });
    const closed = planRevisionReducer(edited, { type: 'cancel' });

    expect(planRevisionReducer(closed, { type: 'open', plan: PLAN })).toEqual(revisionFromPlan(PLAN));
  });

  it('is the editor’s own button, and it dispatches the same cancel', () => {
    expect(CARD).toContain("dispatch({ type: 'cancel' })");
    expect(CARD).toMatch(/>\s*Cancel\s*<\/Button>/);
  });

  it('ignores typing once the editor is closed', () => {
    expect(planRevisionReducer(null, { type: 'note', note: 'Nowhere to put this.' })).toBeNull();
  });
});

describe('a revised plan is not an approved one', () => {
  it('says which of the two settled the card, rather than assuming approval', () => {
    expect(CARD).toContain("const state = approved ? 'approved' : resolved ? 'superseded' : 'review';");
    expect(CARD).toContain('None of these steps ran. The turn below replaced this plan.');
  });

  it('reads the answer off the turn under the plan', () => {
    const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

    expect(home).toContain("const PLAN_APPROVAL_LABEL = 'Approved the proposed analysis plan.';");
    expect(home).toContain('const planApproved = messages[index + 1]?.content === PLAN_APPROVAL_LABEL');
    expect(home).toContain('approved={planApproved}');
    expect(home).toContain('label: PLAN_APPROVAL_LABEL,');
  });
});

describe('one revision maximum', () => {
  it('recognizes the revision wrapper and no ordinary question as a revision', () => {
    expect(
      isPlanRevisionRequest(revisedRequest(PLAN, { note: 'Use the second source.', selectedStepId: 'source-2' }))
    ).toBe(true);
    expect(isPlanRevisionRequest(PLAN.question)).toBe(false);
  });

  it('removes the revision action from the revised plan and leaves execution available', () => {
    expect(CARD).toContain('canRevise ?');
    expect(CARD).toContain("'Run revised plan'");
  });
});

describe('approval outcome copy', () => {
  it('does not treat the approval click itself as proof that analysis ran', () => {
    expect(CARD).toContain('approvalExecuted');
    expect(CARD).toContain('but it was not executed');
    const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
    expect(home).toContain("approvalResponse.type !== 'plan'");
  });
});

describe('legacy plan revision safety', () => {
  it('only offers source radios for structured candidates', () => {
    expect(CARD).toContain('plan.candidates?.[index]');
    expect(CARD).toContain('? {');
  });
});

/**
 * "Approve and run" now runs the source the reader chose, not always the first
 * one. The choice is expressed by re-marking the plan before it is sent, and the
 * agent rejects a plan whose step titles and candidate flags disagree, so these
 * assert the same invariant the server checks: exactly one recommended, and each
 * step title agreeing with its candidate.
 */
describe('approving runs the selected source', () => {
  const invariantHolds = (plan: AnalysisPlan) => {
    const candidates = plan.candidates ?? [];
    const recommendedCount = candidates.filter((candidate) => candidate.recommended).length;
    const titlesAgree = plan.steps.every((step, index) => {
      const candidate = candidates[index];
      if (!candidate) return true;
      const hasSuffix = /\s\(recommended\)$/i.test(step.title);
      return displaySourceTitle(step.title) === candidate.table && hasSuffix === candidate.recommended;
    });
    return recommendedCount === 1 && titlesAgree;
  };

  it('leaves the plan runnable and unchanged when the recommended source is kept', () => {
    const run = planWithSelectedSource(PLAN, 'source-1');
    expect(invariantHolds(run)).toBe(true);
    expect(run.candidates?.[0].recommended).toBe(true);
    expect(run.candidates?.[1].recommended).toBe(false);
    expect(run.steps[0].title).toBe('cdp_northwind_prod.gold_di.gtav_daily_summary (recommended)');
    expect(run.steps[1].title).toBe('cdp_share_prod.global_production.play_by_title');
  });

  it('moves the recommendation to the chosen source, flag and title together', () => {
    const run = planWithSelectedSource(PLAN, 'source-2');
    expect(invariantHolds(run)).toBe(true);
    expect(run.candidates?.[0].recommended).toBe(false);
    expect(run.candidates?.[1].recommended).toBe(true);
    expect(run.steps[0].title).toBe('cdp_northwind_prod.gold_di.gtav_daily_summary');
    expect(run.steps[1].title).toBe('cdp_share_prod.global_production.play_by_title (recommended)');
    expect(run.id).toBe(PLAN.id);
    expect(run.question).toBe(PLAN.question);
  });

  it('keeps the field, so two options from one table run the one the reader chose', () => {
    const sameTable: AnalysisPlan = {
      ...PLAN,
      steps: [
        PLAN.steps[0],
        { ...PLAN.steps[0], id: 'source-2', title: 'cdp_northwind_prod.gold_di.gtav_daily_summary' },
      ],
      candidates: [PLAN.candidates![0], { ...PLAN.candidates![0], field: 'platformid_accountid', recommended: false }],
    };
    const run = planWithSelectedSource(sameTable, 'source-2');
    expect(invariantHolds(run)).toBe(true);
    expect(run.candidates?.[1].recommended).toBe(true);
    expect(run.candidates?.[1].field).toBe('platformid_accountid');
  });

  it('returns a plan with no candidates unchanged', () => {
    const noCandidates: AnalysisPlan = { ...PLAN, candidates: undefined };
    expect(planWithSelectedSource(noCandidates, 'source-2')).toBe(noCandidates);
  });

  it('is what the card hands the page on approve, and the page runs that plan', () => {
    expect(CARD).toContain('onApprove(planWithSelectedSource(plan, selectedStepId))');
    expect(CARD).toContain('name: `plan-run-${plan.id}`');
    const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
    expect(home).toContain('onApprove={(planToRun) =>');
    expect(home).toContain('plan: planToRun,');
  });
});

/**
 * A settled card marks the source that RAN, not the one first suggested. The
 * stored plan is the original proposal, so the only reload-safe record is the
 * answer's reading tables -- and the mark moves only when they name one source.
 */
describe('a settled plan marks the source that ran', () => {
  it('marks the read table even when it was not the recommended one', () => {
    expect(ranSourceStepId(PLAN, ['cdp_share_prod.global_production.play_by_title'])).toBe('source-2');
  });

  it('marks the recommended table when that is the one that ran', () => {
    expect(ranSourceStepId(PLAN, ['cdp_northwind_prod.gold_di.gtav_daily_summary'])).toBe('source-1');
  });

  it('will not guess when the run named no reading source', () => {
    expect(ranSourceStepId(PLAN, [])).toBe('');
  });

  it('will not guess when a read table is not one of the plan sources', () => {
    expect(ranSourceStepId(PLAN, ['cdp_other_prod.gold_di.some_other_table'])).toBe('');
  });

  it('will not guess when a join read two of the plan sources', () => {
    expect(
      ranSourceStepId(PLAN, [
        'cdp_northwind_prod.gold_di.gtav_daily_summary',
        'cdp_share_prod.global_production.play_by_title',
      ])
    ).toBe('');
  });

  it('will not guess between two options that share the read table', () => {
    const sameTable: AnalysisPlan = {
      ...PLAN,
      steps: [
        PLAN.steps[0],
        { ...PLAN.steps[0], id: 'source-2', title: 'cdp_northwind_prod.gold_di.gtav_daily_summary' },
      ],
      candidates: [PLAN.candidates![0], { ...PLAN.candidates![0], field: 'platformid_accountid', recommended: false }],
    };
    expect(ranSourceStepId(sameTable, ['cdp_northwind_prod.gold_di.gtav_daily_summary'])).toBe('');
  });

  it('is placed from the answer only once the run has produced one', () => {
    expect(CARD).toContain("state === 'approved' && approvalExecuted ? ranSourceStepId(plan, ranSourceNames)");
    expect(CARD).toContain("recommendedLabel={ranStepId ? 'Ran' : 'Recommended'}");
    const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
    expect(home).toContain("source.role === 'reading'");
    expect(home).toContain('ranSourceNames={planRanSourceNames}');
  });
});
