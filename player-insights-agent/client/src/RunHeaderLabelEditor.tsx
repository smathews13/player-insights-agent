/**
 * The dropdowns an administrator gets after clicking the rail pencil.
 *
 * Only Outcome and Feedback. Those are the two closed sets this screen can
 * honestly change. Conversation, run, message, user and tool-count stay as
 * chips on the rail above; they are not reassigned from here.
 *
 * Shared AppSelect, not a native <select>: the native control was a second
 * form-field recipe on a rail of chips, and its menu was in-flow. These hang
 * as overlays the same way Monitoring and Settings do.
 */
import { AppSelect } from './AppSelect';
import { RAIL_FEEDBACK_OPTIONS, RAIL_OUTCOME_OPTIONS, type RailFeedback, type RailOutcome } from './run-header-labels';

export function RunHeaderLabelEditor({
  outcome,
  feedback,
  onOutcome,
  onFeedback,
}: {
  outcome: RailOutcome;
  feedback: RailFeedback;
  onOutcome: (value: RailOutcome) => void;
  onFeedback: (value: RailFeedback) => void;
}) {
  return (
    <div className="run-header-label-editor" data-testid="run-header-label-editor">
      <AppSelect
        label="Outcome"
        ariaLabel="Outcome"
        value={outcome}
        options={RAIL_OUTCOME_OPTIONS}
        onValueChange={onOutcome}
      />
      <AppSelect
        label="Feedback"
        ariaLabel="Feedback"
        value={feedback}
        options={RAIL_FEEDBACK_OPTIONS}
        onValueChange={onFeedback}
      />
    </div>
  );
}
