/**
 * The plan the agent proposes before it runs anything, and the two answers to
 * it.
 *
 * Split out of App.tsx when the pages became modules. Ask PIA is its only
 * caller: it is a turn in the transcript, drawn wherever an assistant message
 * carries a plan.
 *
 * A plan is a ranked list of data sources, not a procedure. Revise picks among
 * those sources; Approve sends the plan object back so the agent can honour
 * the choice the reader just saw.
 */
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardDescription,
  CardContent,
  CardHeader,
  CardTitle,
  Textarea,
} from './ui';
import { useMemo, useReducer, useState } from 'react';
import { Play, Send, Shield, ShieldCheck } from 'lucide-react';
import { PlanText } from './InlineEntityText';
import { BrandIcon } from './BrandIcon';
import { productForPlanKind } from './brand-icons';
import { declaredColumns, mentionedIdentifiers } from './data-entities';
import { PiaAvatar } from './PiaMark';
import {
  canSubmitRevision,
  displaySourceTitle,
  isRecommendedSourceTitle,
  planRevisionReducer,
  planWithSelectedSource,
  ranSourceStepId,
  recommendedSourceId,
  revisedRequest,
} from './plan-revision';
import type { AnalysisPlan, PlanCandidate } from './app-types';

function planColumnNames(plan: AnalysisPlan): string[] {
  const lines = [
    plan.summary,
    ...plan.steps.flatMap((step) => [step.title, step.description]),
    ...(plan.candidates ?? []).flatMap((candidate) => [candidate.table, candidate.field, candidate.definition]),
  ];
  const declared = declaredColumns(lines);
  const mentioned = mentionedIdentifiers(lines);
  return [...declared, ...mentioned.filter((name) => !declared.includes(name))];
}

function PlanSourceStep({
  step,
  index,
  columns,
  candidate,
  pick,
  recommended: recommendedOverride,
  recommendedLabel = 'Recommended',
}: {
  step: AnalysisPlan['steps'][number];
  index: number;
  columns: string[];
  candidate?: PlanCandidate;
  pick?: { name: string; checked: boolean; onSelect: () => void };
  /** Overrides the agent's `recommended` flag, for a settled card marking what ran. */
  recommended?: boolean;
  /** The word on the badge: the agent's suggestion before a run, what ran after one. */
  recommendedLabel?: string;
}) {
  const product = productForPlanKind(step.kind);
  const recommended = recommendedOverride ?? candidate?.recommended ?? isRecommendedSourceTitle(step.title);
  const title = candidate?.table ?? displaySourceTitle(step.title);
  return (
    <div className={`plan-step${pick ? ' plan-step-pick' : ''}`}>
      {pick ? (
        <input
          type="radio"
          name={pick.name}
          checked={pick.checked}
          aria-label={`Use ${title}`}
          onChange={pick.onSelect}
        />
      ) : null}
      <span className="ast-num">{index + 1}</span>
      <div>
        <div className="plan-step-heading">
          <strong>
            {product && <BrandIcon product={product} size={14} />}
            <PlanText text={title} columns={columns} />
          </strong>
          {recommended ? (
            <Badge variant="outline" className="ast-pill ast-pill--pos">
              {recommendedLabel}
            </Badge>
          ) : null}
        </div>
        {candidate ? (
          <ul className="plan-candidate-details">
            <li>
              <strong>Field</strong>
              <PlanText text={candidate.field} columns={columns} />
            </li>
            <li>
              <strong>Definition</strong>
              <PlanText text={candidate.definition} columns={columns} />
            </li>
            <li>
              <strong>Why</strong>
              <PlanText text={candidate.why} columns={columns} />
            </li>
          </ul>
        ) : (
          <p>
            <PlanText text={step.description} columns={columns} />
          </p>
        )}
      </div>
    </div>
  );
}

export function PlanCard({
  plan,
  loading,
  resolved,
  approved,
  approvalExecuted,
  approvalPending,
  canRevise,
  onApprove,
  onRevise,
  ranSourceNames = [],
}: {
  plan: AnalysisPlan;
  loading: boolean;
  /** Whether a later turn has settled this plan, whichever way it went. */
  resolved: boolean;
  /**
   * Whether the way it was settled was approval.
   *
   * Separate from `resolved`, because a plan can be settled by being revised
   * away, and a card that says "You approved this plan" over the revision that
   * replaced it is telling the reader something they did not do.
   */
  approved: boolean;
  approvalExecuted: boolean;
  approvalPending: boolean;
  /** A plan may be revised once. The revised plan must be approved or left behind. */
  canRevise: boolean;
  /** Approve the given plan and run it. The plan carries the reader's chosen source. */
  onApprove: (plan: AnalysisPlan) => void;
  /** The revised question to ask, composed from the picker below. */
  onRevise: (request: string) => void;
  /**
   * The tables the answer that ran this plan read, so a settled card can mark
   * the source that ran rather than the one the agent first suggested. Empty
   * until an answer exists, or when the run states no reading source.
   */
  ranSourceNames?: string[];
}) {
  /**
   * The picker, when it is open. `null` is the card as it arrives: the plan as
   * the agent wrote it, with the two answers to it under it.
   *
   * Held here rather than on the page, because a revision is a draft of THIS
   * card and dies with it. The transitions are in plan-revision.ts, which is
   * where they can be read and tested.
   */
  const [revision, dispatch] = useReducer(planRevisionReducer, null);
  /**
   * Which source approving will run, when the reader is choosing among ranked
   * options rather than revising. Starts on the agent's recommended source, so
   * approving without touching the radios runs exactly what it did before. Held
   * here because it is a decision about THIS card and dies with it.
   */
  const [selectedStepId, setSelectedStepId] = useState(() => recommendedSourceId(plan));
  /** More than one ranked source, so the reader has a choice worth showing. */
  const canChooseSource = (plan.candidates?.length ?? 0) > 1;
  /**
   * The three things this card can be: waiting on the reader, approved by them,
   * or settled some other way -- revised, or left behind by the next question.
   * The badge, its tint and the sentence at the foot are three statements of
   * this one fact and are read off it, so they cannot disagree.
   */
  const state = approved ? 'approved' : resolved ? 'superseded' : 'review';
  /**
   * Identifiers this plan names, from a leftover `Columns:` list if one is
   * still present and from underscored field names in the new source
   * descriptions. Collected across the whole plan so a measure named in the
   * summary and again in a step is marked the same way on both lines.
   */
  const columns = useMemo(() => planColumnNames(plan), [plan]);
  /**
   * Once a plan has been approved and run, the badge marks the source that ran,
   * read from the answer's own reading tables rather than the agent's original
   * pick -- the reader may have chosen option 2 or 3. Empty when the run named no
   * single source, in which case the agent's `recommended` flag is left to stand.
   */
  const ranStepId = state === 'approved' && approvalExecuted ? ranSourceStepId(plan, ranSourceNames) : '';
  return (
    <Card className={`plan-card ${resolved ? 'resolved' : ''}`}>
      <CardHeader>
        <div className="flex items-start gap-3">
          {/* The agent's mark, as on every other turn it takes. It was a workflow
              glyph, which said "plan" rather than "the agent" -- and a mark that
              changes with the kind of turn is not a mark. What kind of turn this
              is has two louder statements of its own directly to the right: the
              badge, and a title reading "Proposed analysis plan". */}
          <div className="agent-avatar">
            <PiaAvatar size={32} />
          </div>
          {/* `min-w-0`, because a flex child's floor is its content and this
              plan's content is a fully-qualified table name with no spaces in
              it. Without this the header column cannot shrink to the card and
              the row it is in overflows, which on the widest name in the demo
              catalog is about forty pixels of the summary hidden past the edge. */}
          <div className="min-w-0 space-y-2">
            {/* Amber while it waits and green once it is answered, which is the
                one place in this card evaluation and reachability are the right
                two colours: the badge is a verdict on the plan's state, not a
                control, and the buttons that ARE controls are blue below. Both
                are tinted pills with a deep-rung label, because neither hue can
                be type at full strength. */}
            {/* The app's one pill recipe, in the family the state picks: warning
                while the plan is waiting on a decision, positive once it has
                one. It used to declare its own size, weight, radius and padding
                and then a fill per state, which is one of the twenty-one chip
                recipes the astrolabe pass collapses into this one. */}
            <Badge
              variant="outline"
              className={`ast-pill plan-state ast-pill--${state === 'approved' ? 'pos' : state === 'review' ? 'warn' : 'neutral'}`}
              data-state={state}
            >
              {state === 'approved' ? 'Approved' : state === 'review' ? 'Review needed' : 'Not run'}
            </Badge>
            <CardTitle className="plan-title">Proposed analysis plan</CardTitle>
            {/* Inline Markdown, not blocks. The plan is already structured --
                the steps below are its sections -- so what is left for Markdown
                here is a backticked column name in a sentence, and a heading
                would be a second sectioning of something already sectioned.

                The plan names the tables it proposes to read and the columns it
                proposes to read from them, and it names them in prose. Passing
                `sources={[]}` left every one of them as grey text a reader had
                to copy out and look up by hand. PlanText links the tables this
                deployment tracks and bolds the rest; see DataEntityLinks.tsx for
                why a plan's candidate set is the tracked list rather than the
                sources an answer declared. */}
            <CardDescription>
              <PlanText text={plan.summary} columns={columns} />
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {revision ? (
          <div className="plan-revision">
            {/* Ranked sources as a picker. Editing a fully-qualified table name
                in a text box is not a revision the agent can honour, so the
                choice is a radio that writes into the note below. */}
            <div className="plan-steps">
              {plan.steps.map((step, index) => (
                <PlanSourceStep
                  key={step.id}
                  step={step}
                  index={index}
                  columns={columns}
                  candidate={plan.candidates?.[index]}
                  pick={
                    plan.candidates?.[index]
                      ? {
                          name: `plan-source-${plan.id}`,
                          checked: revision.selectedStepId === step.id,
                          onSelect: () => dispatch({ type: 'select', id: step.id }),
                        }
                      : undefined
                  }
                />
              ))}
            </div>
            {/* The other half, and on its own the whole of it: a reader can send
                a revision without touching a source, because "also break this
                out by platform" is a sentence and not a different table. */}
            <label className="plan-revision-note">
              <span>What should change?</span>
              <Textarea
                value={revision.note}
                rows={2}
                placeholder="e.g. use the Northwind table instead"
                onChange={(event) => dispatch({ type: 'note', note: event.target.value })}
              />
            </label>
          </div>
        ) : (
          <div className="plan-steps">
            {/* Ranked sources as a picker in the ordinary view too, so the reader
                can approve option 2 or 3 directly. The radios only appear while
                the plan is still waiting on a decision and there is a choice to
                make; a settled plan, or one with a single source, renders plain. */}
            {plan.steps.map((step, index) => (
              <PlanSourceStep
                key={step.id}
                step={step}
                index={index}
                columns={columns}
                candidate={plan.candidates?.[index]}
                recommended={ranStepId ? step.id === ranStepId : undefined}
                recommendedLabel={ranStepId ? 'Ran' : 'Recommended'}
                pick={
                  !resolved && canChooseSource && plan.candidates?.[index]
                    ? {
                        name: `plan-run-${plan.id}`,
                        checked: selectedStepId === step.id,
                        onSelect: () => setSelectedStepId(step.id),
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
        <div className="plan-context">
          {plan.uses_conversation_context && <Badge variant="secondary">Uses conversation context</Badge>}
          {plan.uses_attachment_context && <Badge variant="secondary">Uses attached reports</Badge>}
        </div>
        {/* Green: what this alert reports is that nothing has run, or that what
            ran is what you approved. The check arrives with the approval, so an
            unanswered plan gets the plain shield -- a tick over "no query has
            run yet" would be claiming something had been confirmed. */}
        <Alert className="plan-reassurance" data-state={state}>
          {state === 'approved' ? <ShieldCheck /> : <Shield />}
          <AlertDescription>
            <p>
              {state === 'approved'
                ? approvalPending
                  ? 'You approved this plan. The analysis is running now.'
                  : approvalExecuted
                    ? 'You approved this plan. The next turn ran the approved source decision.'
                    : 'You approved this plan, but it was not executed. Review the replacement plan below.'
                : state === 'review'
                  ? canRevise
                    ? 'No analytical query runs until you approve this plan. You can revise the request once.'
                    : 'This plan already includes your revision. Approve it to start the analysis.'
                  : 'None of these steps ran. The turn below replaced this plan.'}
            </p>
          </AlertDescription>
        </Alert>
        {!resolved &&
          (revision ? (
            <div className="plan-actions">
              {/* Cancel puts the plan back as the agent wrote it, edits and all
                  discarded -- see planRevisionReducer for why it does not keep
                  them. */}
              <Button type="button" variant="outline" onClick={() => dispatch({ type: 'cancel' })} disabled={loading}>
                Cancel
              </Button>
              {/* Sends the choice as a question and gets a new plan back. Off
                  until the picker says something the plan does not already say,
                  because an untouched revision asks for the same plan again. */}
              <Button
                type="button"
                onClick={() => {
                  onRevise(revisedRequest(plan, revision));
                  dispatch({ type: 'cancel' });
                }}
                disabled={loading || !canSubmitRevision(plan, revision)}
              >
                <Send /> Send revised request
              </Button>
            </div>
          ) : (
            <div className="plan-actions">
              {canRevise ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => dispatch({ type: 'open', plan })}
                  disabled={loading}
                >
                  Revise request
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={() => onApprove(planWithSelectedSource(plan, selectedStepId))}
                disabled={loading}
              >
                <Play /> {canRevise ? 'Approve and run' : 'Run revised plan'}
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
