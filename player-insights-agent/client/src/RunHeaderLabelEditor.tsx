/**
 * The dropdowns an administrator gets after clicking the rail pencil.
 *
 * Only Outcome and Rating. Those are the two closed sets this screen can
 * honestly change. Conversation, run, message, user and tool-count stay as
 * chips on the rail above; they are not reassigned from here.
 */
import {
  RAIL_OUTCOME_OPTIONS,
  RAIL_RATING_OPTIONS,
  type RailOutcome,
  type RailRating,
} from './run-header-labels';

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
      <label className="run-header-label-field">
        <span>Outcome</span>
        <select
          className="run-header-label-select"
          aria-label="Outcome"
          value={outcome}
          onChange={(event) => onOutcome(event.target.value as RailOutcome)}
        >
          {RAIL_OUTCOME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="run-header-label-field">
        <span>Rating</span>
        <select
          className="run-header-label-select"
          aria-label="Rating"
          value={rating}
          onChange={(event) => onRating(event.target.value as RailRating)}
        >
          {RAIL_RATING_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
