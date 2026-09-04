/**
 * The run pill: a dot, a word, and whether either of them is entitled to move.
 *
 * One component for the two places it is drawn -- the inspector column, and the
 * strip that stands in for that column below 1180px where it is hidden. It was
 * the same nine lines of JSX twice, which is how the two copies came to differ:
 * only one of them was a live region for a while, so the readers who had the
 * strip and not the column heard nothing at all.
 *
 * `role="status"` rather than an alert, on both: a run in progress has not gone
 * wrong and may not interrupt what is being read. It cannot spam either, and that
 * is a property of the label rather than of a throttle -- the elapsed clock
 * re-renders the page several times a second and the string is unchanged across
 * all of them, so the text node is only written when the state genuinely moves:
 * once per completed step, and once when the endpoint check comes back. The two
 * copies cannot talk over each other, because the media query that shows one
 * hides the other and a region inside `display: none` is not read at all.
 *
 * `aria-atomic` because "Live · step 8" is one sentence and the useful half of it
 * is the number; without it a reader is handed the digit on its own.
 */
import { Check } from 'lucide-react';
import { RUN_TONE_FAMILY, type RunStatus } from './run-status';
import { PiaLoadingLabel } from './PiaLoadingLabel';

export function RunStatusPill({ status, onDark = false }: { status: RunStatus; onDark?: boolean }) {
  if (status.checkingConnection) {
    return (
      <PiaLoadingLabel
        as="span"
        seat="status"
        tone={onDark ? 'dark' : 'light'}
        className={`run-status-loader${onDark ? ' run-status-loader--dark' : ''}`}
        label={status.label}
      />
    );
  }
  // `ast-pill` is the recipe, the family is the colour, and `run-status` is what
  // this seating adds to both: a dot in a fixed lane, a check in the same lane,
  // and the one animation the app runs on a chip. The tone class rides along
  // because the live and ready rules still key off the state class as well as
  // the family: the breathing dot, and the quiet fill live shares with waiting.
  const family = RUN_TONE_FAMILY[status.tone];
  return (
    <span
      className={`ast-pill run-status ${onDark ? 'run-status--dark ' : ''}${family ? `${family} ` : ''}${status.tone}${status.alive ? ' is-alive' : ''}`}
      role="status"
      aria-atomic="true"
    >
      {/* A check on the finished badge and a dot on every other, which is the
          design's distinction and cannot be read off the tone: "Complete" and
          "Ready" are the same green. Both are decoration -- the word carries the
          state -- so neither is ever spoken. */}
      {status.finished && !onDark ? (
        <Check className="run-status-check" aria-hidden="true" />
      ) : (
        <span className="run-status-dot" aria-hidden="true" />
      )}
      {status.label}
    </span>
  );
}
