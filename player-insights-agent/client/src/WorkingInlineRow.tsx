/**
 * The flicker's inline seating (`#17a`): one row, one mark, one real number.
 *
 * It uses the same "Planning out your answer" phrase as the centered pre-stage
 * state, followed by a separately pinned mono elapsed time. It is the loading
 * suite's narrow seating, for a column that a 520px panel does not fit in.
 *
 * WHY THIS IS NOT A LIVE REGION, when the two constellation panels are. §5 allows
 * one `aria-live="polite"` string per surface and the surface this sits on already
 * spends it: the inspector's head carries `RunStatusPill`, which is a
 * `role="status"` and announces "Live · step 8" as the run moves. A second region
 * six pixels below it, saying the same run is in flight in different words, would
 * interrupt the first every time the count ticked. The label is visible and the
 * pill is what speaks.
 *
 * The mark is decorative and `ConceptFlicker` marks it so. Under
 * `prefers-reduced-motion: reduce` the guard in astrolabe-animation.css leaves the
 * d-pad still in the slot, so the row keeps a mark rather than emptying out.
 */
import { ConceptFlicker } from './ConceptFlicker';
import { INLINE_WORKING_LABEL } from './working-animation';

export function WorkingInlineRow({
  elapsed,
  label = INLINE_WORKING_LABEL,
  className,
}: {
  /**
   * The seconds so far, already formatted, or null before there are enough of
   * them to say. The caller counts, because it is the caller that knows when the
   * run started.
   */
  elapsed: string | null;
  /** Shared current-stage label; defaults to the pre-stage planning copy. */
  label?: string;
  className?: string;
}) {
  return (
    <div className={`ast-flick-row ${className ?? ''}`.trim()}>
      <ConceptFlicker seat="inline" />
      <span className="ast-flick-row-say">{label}</span>
      {/* Right-pinned and mono, per the spec. Mono because it changes in place
          every second: DM Sans digits are proportional, so a count set in it
          shifts its own right edge as it ticks. Absent rather than "0s" while
          there is nothing to report, which is the same rule the panels follow --
          a number that appears at zero and corrects itself reads as a stutter. */}
      {elapsed ? <span className="ast-num ast-flick-row-count">{elapsed}</span> : null}
    </div>
  );
}
