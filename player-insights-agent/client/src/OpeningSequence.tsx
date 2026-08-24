/**
 * The app opening (`#19a`): a night sky, the four concepts, the wordmark.
 *
 * The full-viewport half of the sequence. The gate that rises over it at 60% is
 * the REAL gate and is not drawn here -- `loading-suite.md`: "The gate is the real
 * gate (login-gate.md); the sequence only precedes it." `FirstOpenGate` owns both
 * and is where the clock lives.
 *
 * THE SKY OUTLIVES THE INTRO, and that is the one thing about this component worth
 * reading twice. "The constellation keeps drawing behind the gate" is the spec's
 * own sentence, so this layer stays mounted for as long as the gate is on screen
 * rather than unmounting after ten seconds. The constellation's own animations are
 * `infinite` loops, so it goes on drawing without anything having to restart it,
 * and the gate never flips from a navy backdrop to an Ice one under the reader.
 *
 * What DOES end is the middle: the concepts and the wordmark are one-shot
 * animations that are over by 64% of the sequence, and the component stops
 * rendering them once the gate is up. A concept mark cycling behind a login card
 * would be the app still introducing itself to somebody who is trying to read
 * their own email address.
 *
 * DECORATIVE, ENTIRELY. The whole layer is `aria-hidden`: it says nothing a screen
 * reader can use, and the gate that follows it carries the words. There is no
 * `aria-live` here at all -- the one status string §5 allows on this surface is the
 * gate's own copy, and a live region announcing an animation would be read out
 * over it.
 *
 * `leaving` IS THE OTHER END OF THE SAME SEQUENCE. `login-transition.md` has the
 * sky go out the way it came in: the stars travel to the lockup and the layer fades
 * as the app crossfades up under it. It is a prop rather than a second component
 * because the thing leaving has to be the sky the reader has been looking at, with
 * the stars in the positions they popped in.
 */
import { AstrolabeMark } from './AstrolabeMark';
import { ConstellationField } from './ConstellationField';
import { OPENING_CONSTELLATION } from './constellation';
import { FLICKER_ORDER, WORDMARK } from './astrolabe-mark';
import { CONCEPT_SIZE, OPENING_SECONDS, conceptDelay } from './opening-sequence';
import { starDelaySeconds, starTravel } from './login-transition';

/**
 * The sky's exit, once Continue has been taken.
 *
 * Every star travels to the lockup point and the connectors do not travel at all
 * (`login-transition.md` phase 3: "Connector lines do not travel; they fade with
 * the sky"), which is why this is passed to the field rather than being a class on
 * the whole SVG.
 */
const skyExit = (star: { x: number; y: number }, at: number) => ({
  ...starTravel(star),
  delaySeconds: starDelaySeconds(at),
});

export function OpeningSequence({
  intro,
  leaving = false,
  /**
   * Whether the gate's own sky is already on screen behind this layer.
   *
   * WHEN IT IS, THIS LAYER DRAWS NO SKY OF ITS OWN, and that is the whole of
   * the fix for the opening reading as two views in sequence. The gate mounts
   * one `StarField` for as long as it is up. This layer used to paint its own
   * navy over that and draw `OPENING_CONSTELLATION` on it -- a drawing that
   * arrives progressively, so early in the intro the right-hand side has not
   * been drawn yet. When the intro ended the whole layer was unmounted and the
   * gate's field appeared already complete, so the reader saw an empty right
   * side fill in and the sky shift under the card. Two surfaces in sequence,
   * which is what was reported.
   *
   * Transparent, with no field of its own, this is the concepts and the
   * wordmark ON the sky the reader is already looking at. Nothing behind them
   * mounts, unmounts or moves when the intro hands over -- the marks fade and
   * the card rises, and the sky is the same element throughout.
   *
   * The exit keeps its own field: `leaving` travels every star to the lockup,
   * which is a drawing this layer has to own because it is animating it.
   */
  onSky = false,
}: {
  intro: boolean;
  leaving?: boolean;
  onSky?: boolean;
}) {
  const cycle = `${OPENING_SECONDS}s`;
  return (
    <div
      className={`ast-opening${onSky ? ' ast-opening-on-sky' : ''}${leaving ? ' ast-anim-x-sky' : ''}`}
      aria-hidden="true"
    >
      {/* The sky. `#19a` draws five separate patterns around the edges of a
          1180x700 canvas and leaves the middle empty, which is what the concepts,
          the wordmark and the gate occupy. The SVG slices rather than squashes, so
          a viewport of another shape crops the sky instead of distorting it.
          Drawn only where this layer IS the sky; see `onSky` above. */}
      {onSky && !leaving ? null : (
        <ConstellationField
          shape={OPENING_CONSTELLATION}
          className="ast-opening-sky"
          exitTo={leaving ? skyExit : undefined}
        />
      )}
      {intro ? (
        <div className="ast-opening-centre">
          {/* Four marks in one stacked slot, a turn each. The same four concepts
              the loaders flicker through, in the same order, at 96px instead of
              72 and 1.6s instead of 0.8 -- this is the app saying its own name
              rather than reporting that something is in flight.
              `ink="dark"` is the white-on-navy cut: the canvas is #11171C. */}
          <div className="ast-opening-concepts">
            {FLICKER_ORDER.map((concept, at) => (
              <AstrolabeMark
                key={concept}
                size={CONCEPT_SIZE}
                concept={concept}
                ink="dark"
                className="ast-anim-concept"
                style={{ animationDuration: cycle, animationDelay: `${conceptDelay(at)}s` }}
              />
            ))}
          </div>
          {/* The wordmark, held under them. Type rather than artwork and lowercase
              in the string rather than by `text-transform`, for the same two
              reasons the lockup is: it survives a font change, and a reader who
              copies it gets what the app is called. */}
          <p className="ast-opening-wordmark ast-anim-hold" style={{ animationDuration: cycle }}>
            {WORDMARK}
          </p>
        </div>
      ) : null}
    </div>
  );
}
