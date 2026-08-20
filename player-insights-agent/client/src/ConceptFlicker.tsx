/**
 * The loader: four mark concepts flickering through one stacked slot (`#17a`).
 *
 * The rete, the reticle, the horizon and the d-pad each fade in, hold and fade
 * out on a 3.2s cycle at 0.8s intervals, so the slot is always showing exactly
 * one of them. The d-pad is the app's identity mark and the other three are the
 * concepts it was chosen from; the loader is the only place they are ever seen.
 *
 * THE STATIC MARK NEVER FLICKERS. A header lockup that cycled through four
 * drawings would make the app's identity a thing in motion, which is the
 * opposite of what an identity is for. This is a working state and nothing else.
 *
 * Decorative: every mark is `aria-hidden` and the seating supplies the one
 * `aria-live` string (§5). Under `prefers-reduced-motion: reduce` the guard in
 * astrolabe-animation.css hides all four but the one carrying `data-ast-rest`,
 * which is the d-pad -- a reader who asked for no motion should be looking at
 * the app's mark rather than at an archive concept.
 */
import { AstrolabeMark, type MarkInk } from './AstrolabeMark';
import {
  FLICKER_CYCLE_SECONDS,
  FLICKER_ORDER,
  FLICKER_REST,
  FLICKER_SIZES,
  flickerDelay,
  type FlickerSeat,
} from './astrolabe-mark';

/**
 * Which ink each seating hands the marks.
 *
 * The splash and the inline row are on white; the strip inside a navy panel and
 * the agent path's status slot are on dark; the in-button mark is all white,
 * because #6FAEDD on the blue primary button is 1.6:1 and the accent dots would
 * vanish.
 */
const SEAT_INK: Readonly<Record<FlickerSeat, MarkInk>> = {
  splash: 'light',
  inline: 'light',
  button: 'mono',
  strip: 'dark',
  status: 'dark',
};

export function ConceptFlicker({ seat, className }: { seat: FlickerSeat; className?: string }) {
  const size = FLICKER_SIZES[seat];
  return (
    <span
      className={`ast-flick-slot ast-flick-slot--${seat} ${className ?? ''}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {FLICKER_ORDER.map((concept) => (
        <AstrolabeMark
          key={concept}
          size={size}
          concept={concept}
          ink={SEAT_INK[seat]}
          className="ast-anim-flick"
          // The still frame under reduced motion. Marked in the markup because
          // CSS cannot choose which of four stacked drawings a frozen slot
          // should show, and a slot that marks none of them renders nothing --
          // which fails visibly rather than showing four marks in a pile.
          rest={concept === FLICKER_REST}
          style={{
            animationDuration: `${FLICKER_CYCLE_SECONDS}s`,
            animationDelay: `${flickerDelay(concept)}s`,
          }}
        />
      ))}
    </span>
  );
}
