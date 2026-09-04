/**
 * The working state, as the constellation loaders (`#5ar`, `#5br`).
 *
 * The controller-to-database-to-robot scene is retired. What replaces it says the
 * same thing in the register the rest of the app now uses: a navy panel on which
 * a constellation connects itself, with the flickering mark and the real elapsed
 * count sitting in it.
 *
 * Two seatings, and the difference is how much of the answer column is already
 * spoken for:
 *
 *   splash  520x220 panel, five hops. The first question of a session, or
 *           anywhere the answer column has nothing in it yet.
 *   card    56px strip, three hops, inside the live working card.
 *
 * WHAT THE READER IS TOLD IS A REAL NUMBER. `loading-suite.md`: "Elapsed time is
 * real, DM Mono, updates every second. Never a percentage." The bar under the
 * panel is indeterminate for the same reason it always was -- the run reports
 * each step on finishing it, so the client knows what has happened and never how
 * much is left.
 *
 * Every drawing here is `aria-hidden` and the surface carries ONE
 * `aria-live="polite"` string, which is the visible status line (§5).
 */
import { PiaFlicker } from './PiaFlicker';
import { ConstellationField } from './ConstellationField';
import { CARD_CONSTELLATION, SPLASH_CONSTELLATION } from './constellation';
import { WORKING_LABEL, type WorkingSeat } from './working-animation';

/**
 * The status inside the panel.
 *
 * The splash says what the agent is doing and the strip says how long it has
 * been doing it, which is `loading-suite.md`'s split: the splash has the count
 * under it in the heading, so repeating it inside the panel would put the same
 * number on screen twice, six pixels apart.
 */
const SPLASH_STATUS = 'Connecting your answer';

export function WorkingConstellation({
  seat,
  elapsed,
}: {
  seat: WorkingSeat;
  /**
   * The seconds so far, already formatted, or null before there are any. The
   * caller counts, because it is the caller that knows when the run started.
   */
  elapsed: string | null;
}) {
  const splash = seat === 'splash';
  return (
    <div className={`ast-working ast-working--${seat}`}>
      <ConstellationField shape={splash ? SPLASH_CONSTELLATION : CARD_CONSTELLATION} />
      {/* Bottom left on the splash, vertically centred on the strip, which is
          what the two panels have room for. */}
      <div className="ast-working-status">
        <PiaFlicker seat="strip" />
        {/* The one live region for this surface. It is the visible label rather
            than a second string written for a screen reader, so what is read out
            and what is on screen cannot drift. */}
        <span className="ast-working-say" aria-live="polite">
          {splash ? (
            SPLASH_STATUS
          ) : (
            <>
              {WORKING_LABEL}
              {elapsed ? (
                <>
                  <span className="ast-sep" />
                  {/* Mono, because it changes every second in place: DM Sans
                      digits are proportional and a `1` is just over half the
                      width of a `0`, so a count set in it jitters as it ticks. */}
                  <span className="ast-num">{elapsed}</span>
                </>
              ) : null}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
