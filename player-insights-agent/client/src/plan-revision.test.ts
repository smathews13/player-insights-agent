/**
 * "Revise request", which used to do nothing a reader could see.
 *
 * It dropped the plan's own question into the composer and focused it, so the
 * reader clicked a button and got back the words they had already typed, with
 * no editor, no note and nothing to say the click had registered. What it opens
 * now is the plan itself, editable, plus a box for the sentence that is faster
 * than an edit ("don't query X, also include Y").
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
  planRevisionReducer,
  revisedRequest,
  revisionFromPlan,
  stepsEdited,
  type PlanRevision,
} from './plan-revision';
import type { AnalysisPlan } from './app-types';

const CARD = readFileSync(new URL('./PlanCard.tsx', import.meta.url), 'utf8');

const PLAN: AnalysisPlan = {
  id: 'plan-1',
  question: 'How did the title do last month?',
  summary: 'Confirm definitions, analyze governed data, then synthesize.',
  steps: [
    { id: 'context', title: 'Establish context', description: 'Resolve references.', kind: 'context' },
    { id: 'definitions', title: 'Confirm metric definitions', description: 'Ask the dictionary.', kind: 'definitions' },
    { id: 'data-1', title: 'Query gold_title_daily_summary', description: 'Read the table.', kind: 'data' },
  ],
  requires_approval: true,
  uses_conversation_context: false,
  uses_attachment_context: false,
};

/** The editor as the click leaves it. */
const opened = () => planRevisionReducer(null, { type: 'open', plan: PLAN }) as PlanRevision;

describe('clicking Revise request opens the plan as an editor', () => {
  it('opens on the plan rather than on an empty box', () => {
    // The reader who wants a different analysis usually wants most of this one,
    // so every step arrives as text they can change.
    expect(opened().steps).toEqual([
      { id: 'context', title: 'Establish context', description: 'Resolve references.' },
      { id: 'definitions', title: 'Confirm metric definitions', description: 'Ask the dictionary.' },
      { id: 'data-1', title: 'Query gold_title_daily_summary', description: 'Read the table.' },
    ]);
    expect(opened().note).toBe('');
  });

  it('has nothing to send until the reader says something', () => {
    // An untouched editor sent back quotes the plan verbatim, and the honest
    // answer to that is the same plan again -- which is the dead end this
    // change is about, one round trip further in.
    expect(canSubmitRevision(PLAN, opened())).toBe(false);
    expect(stepsEdited(PLAN, opened())).toBe(false);
  });

  it('takes an edit to a step, a typed note, or a dropped step as a revision', () => {
    const retitled = planRevisionReducer(opened(), {
      type: 'step',
      id: 'data-1',
      field: 'title',
      value: 'Query gold_title_weekly_summary',
    }) as PlanRevision;
    const noted = planRevisionReducer(opened(), { type: 'note', note: 'Also break it out by platform.' }) as PlanRevision;
    const dropped = planRevisionReducer(opened(), { type: 'remove', id: 'definitions' }) as PlanRevision;

    expect(canSubmitRevision(PLAN, retitled)).toBe(true);
    expect(canSubmitRevision(PLAN, noted)).toBe(true);
    expect(canSubmitRevision(PLAN, dropped)).toBe(true);
    expect(dropped.steps.map((step) => step.id)).toEqual(['context', 'data-1']);
  });

  it('will not drop the last step, because a plan with no steps is not a request', () => {
    const one = { note: '', steps: [{ id: 'only', title: 'Answer it', description: 'From context.' }] };

    expect(planRevisionReducer(one, { type: 'remove', id: 'only' })).toBe(one);
  });

  it('wires the button to the editor rather than to the composer', () => {
    expect(CARD).toContain("dispatch({ type: 'open', plan })");
    expect(CARD).toContain('Revise request');
    // The reach into the page that used to stand in for this.
    expect(CARD).not.toContain('.composer textarea');
  });
});

describe('sending a revision asks the revised question', () => {
  const revision = planRevisionReducer(
    planRevisionReducer(opened(), {
      type: 'step',
      id: 'data-1',
      field: 'description',
      value: 'Read only the last 90 days.',
    }),
    { type: 'note', note: 'Don’t query the churn table.' }
  ) as PlanRevision;
  const request = revisedRequest(PLAN, revision);

  it('carries the note and the edited steps', () => {
    expect(request).toContain('Don’t query the churn table.');
    expect(request).toContain('3. Query gold_title_daily_summary — Read only the last 90 days.');
    expect(request).toContain('1. Establish context — Resolve references.');
  });

  it('restates the question, because the steps alone do not say what it is for', () => {
    expect(request).toContain(PLAN.question);
  });

  it('asks for a plan rather than for the analysis', () => {
    // A revision is a proposal, not an approval: nothing runs off the back of
    // it, which is what the card's own reassurance promises.
    expect(request).toContain('Do not run the analysis yet.');
  });

  it('sends only the note when no step was touched', () => {
    const justANote = planRevisionReducer(opened(), { type: 'note', note: 'Include console as well.' }) as PlanRevision;

    expect(revisedRequest(PLAN, justANote)).toContain('Include console as well.');
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
    // A remembered draft is a second, invisible version of the plan on screen:
    // the reader reopening this card would have no way to tell that the steps
    // they are reading are not the ones that would be sent.
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
    // Every turn after a plan used to read as an approval, because the only
    // question the card asked was whether something came after it. Sending a
    // revision put a card reading "Approved -- the analysis below was produced
    // by running these steps" directly above the replacement plan.
    expect(CARD).toContain("const state = approved ? 'approved' : resolved ? 'superseded' : 'review';");
    expect(CARD).toContain('None of these steps ran. The turn below replaced this plan.');
  });

  it('reads the answer off the turn under the plan', () => {
    const home = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

    expect(home).toContain("const PLAN_APPROVAL_LABEL = 'Approved the proposed analysis plan.';");
    expect(home).toContain('approved={messages[index + 1]?.content === PLAN_APPROVAL_LABEL}');
    // One spelling of the sentence, so the label an approval writes and the
    // label this reads back cannot drift apart.
    expect(home).toContain('label: PLAN_APPROVAL_LABEL,');
  });
});
