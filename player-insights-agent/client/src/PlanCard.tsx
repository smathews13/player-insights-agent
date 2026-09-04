/**
 * The plan the agent proposes before it runs anything, and the two answers to
 * it.
 *
 * Split out of App.tsx when the pages became modules. Ask PIA is its only
 * caller: it is a turn in the transcript, drawn wherever an assistant message
 * carries a plan.
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
  Input,
  Textarea,
} from './ui';
import { useMemo, useReducer } from 'react';
import { Play, Send, Shield, ShieldCheck, X } from 'lucide-react';
import { PlanText } from './InlineEntityText';
import { BrandIcon } from './BrandIcon';
import { productForPlanKind } from './brand-icons';
import { declaredColumns } from './data-entities';
import { PiaMark } from './PiaMark';
import { canSubmitRevision, planRevisionReducer, revisedRequest } from './plan-revision';
import type { AnalysisPlan } from './app-types';

export function PlanCard({
  plan,
  loading,
  resolved,
  approved,
  onApprove,
  onRevise,
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
  onApprove: () => void;
  /** The revised question to ask, composed from the editor below. */
  onRevise: (request: string) => void;
}) {
  /**
   * The editor, when it is open. `null` is the card as it arrives: the plan as
   * the agent wrote it, with the two answers to it under it.
   *
   * Held here rather than on the page, because a revision is a draft of THIS
   * card and dies with it. The transitions are in plan-revision.ts, which is
   * where they can be read and tested.
   */
  const [revision, dispatch] = useReducer(planRevisionReducer, null);
  /**
   * The three things this card can be: waiting on the reader, approved by them,
   * or settled some other way -- revised, or left behind by the next question.
   * The badge, its tint and the sentence at the foot are three statements of
   * this one fact and are read off it, so they cannot disagree.
   */
  const state = approved ? 'approved' : resolved ? 'superseded' : 'review';
  /**
   * The columns this plan says it will read, taken from the plan's own
   * `Columns: …` lists and applied to every line of it.
   *
   * Collected across the whole plan rather than per step, because the summary
   * names the measure a step further down lists as a column -- "Aggregate
   * active_players … by title" over "Columns: event_date, title_code,
   * active_players" -- and a reader should not see the same identifier set as
   * data in one line and as a word in the line above it.
   */
  const columns = useMemo(
    () => declaredColumns([plan.summary, ...plan.steps.flatMap((step) => [step.title, step.description])]),
    [plan]
  );
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
            <PiaMark size={32} />
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
            {/* The plan's own steps, as fields. A reader who wants a different
                analysis usually wants most of this one: the fastest way to say
                "not that table" is to edit the line that names it, which is why
                the editor opens on the plan rather than on an empty box. */}
            <div className="plan-steps">
              {revision.steps.map((step, index) => (
                <div className="plan-step plan-step-edit" key={step.id}>
                  <span className="ast-num">{index + 1}</span>
                  <div>
                    <Input
                      value={step.title}
                      aria-label={`Step ${index + 1} title`}
                      onChange={(event) =>
                        dispatch({ type: 'step', id: step.id, field: 'title', value: event.target.value })
                      }
                    />
                    <Textarea
                      value={step.description}
                      rows={2}
                      aria-label={`Step ${index + 1} detail`}
                      onChange={(event) =>
                        dispatch({ type: 'step', id: step.id, field: 'description', value: event.target.value })
                      }
                    />
                  </div>
                  {/* Disabled on the last step: a plan with no steps is not a
                      revision the agent can act on. */}
                  <button
                    type="button"
                    className="plan-step-remove"
                    aria-label={`Remove step ${index + 1}`}
                    disabled={revision.steps.length < 2}
                    onClick={() => dispatch({ type: 'remove', id: step.id })}
                  >
                    <X />
                  </button>
                </div>
              ))}
            </div>
            {/* The other half, and on its own the whole of it: a reader can send
                a revision without touching a step, because "also break this out
                by platform" is a sentence and not an edit to one line. */}
            <label className="plan-revision-note">
              <span>What should change?</span>
              <Textarea
                value={revision.note}
                rows={2}
                placeholder="e.g. don’t query the churn table, and include the last 90 days"
                onChange={(event) => dispatch({ type: 'note', note: event.target.value })}
              />
            </label>
          </div>
        ) : (
          <div className="plan-steps">
            {plan.steps.map((step, index) => {
              const product = productForPlanKind(step.kind);
              return (
                <div className="plan-step" key={step.id}>
                  {/* Mono, because these are read down a column: one numeral per
                  step at the same offset, so the digits of 9 and 10 sit under
                  each other. The stylesheet used to ask DM Sans for tabular
                  figures instead, which does nothing -- the face declares no
                  `tnum` feature and its digits are proportional. */}
                  <span className="ast-num">{index + 1}</span>
                  <div>
                    {/* The title on its own line rather than run into the sentence
                    after it. The agent writes these unpunctuated -- "Confirm
                    metric definitions" -- so setting the two inline produces one
                    run-on line whose first clause has no full stop, and the lead
                    stops reading as a lead.

                    Titles name tables as often as the detail under them does --
                    "Read <your_catalog>.….gold_title_daily_summary" is a
                    title, not a sentence -- so the same treatment applies here.
                    A linked name inside the bold lead keeps the link's own 500
                    rather than the lead's 700; it is still the only blue,
                    underlined run in the line, which is what marks it. */}
                    {/* The product this step will call, where the step's kind names
                    one. Decorative: the line it sits on says what the step does,
                    and the mark is there so a reader can see at a glance that
                    the plan reaches the dictionary before it reaches the
                    warehouse. Context and synthesis steps carry none, because
                    neither is a call on a Databricks product -- see
                    productForPlanKind. */}
                    <strong>
                      {product && <BrandIcon product={product} size={14} />}
                      <PlanText text={step.title} columns={columns} />
                    </strong>
                    <p>
                      <PlanText text={step.description} columns={columns} />
                    </p>
                  </div>
                </div>
              );
            })}
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
                ? 'You approved this plan. The analysis below was produced by running these steps.'
                : state === 'review'
                  ? 'No analytical query runs until you approve this plan. You can revise the request first.'
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
              {/* Sends the edits as a question and gets a new plan back. Off
                  until the editor says something the plan does not already say,
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
              <Button
                type="button"
                variant="outline"
                onClick={() => dispatch({ type: 'open', plan })}
                disabled={loading}
              >
                Revise request
              </Button>
              <Button type="button" onClick={onApprove} disabled={loading}>
                <Play /> Approve and run
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
