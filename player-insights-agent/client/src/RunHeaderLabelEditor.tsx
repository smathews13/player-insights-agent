/**
 * The dropdowns an administrator gets after clicking the rail pencil.
 *
 * Only Outcome and Rating. Those are the two closed sets this screen can
 * honestly change. Conversation, run, message, user and tool-count stay as
 * chips on the rail above; they are not reassigned from here.
 *
 * Shared AppSelect, not a native <select>: the native control was a second
 * form-field recipe on a rail of chips, and its menu was in-flow. These hang
 * as overlays the same way Monitoring and Settings do.
 */
import { AppSelect } from './AppSelect';
import { RAIL_OUTCOME_OPTIONS, RAIL_RATING_OPTIONS, type RailOutcome, type RailRating } from './run-header-labels';

export function RunHeaderLabelEditor({
  outcome,
  rating,
  onOutcome,
  onRating,
}: {
  outcome: RailOutcome;
  rating: RailRating;
  onOutcome: (value: RailOutcome) => void;
  onRating: (value: RailRating) => void;
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
        label="Rating"
        ariaLabel="Rating"
        value={rating}
        options={RAIL_RATING_OPTIONS}
        onValueChange={onRating}
      />
    </div>
  );
}
