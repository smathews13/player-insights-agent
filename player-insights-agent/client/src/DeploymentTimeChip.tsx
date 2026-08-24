/**
 * The running app deployment's release date, small enough to sit in the lockup.
 *
 * The timestamp is the Apps API's active deployment `create_time`, shared with
 * the Build and telemetry card.
 *
 * ONLY THE DATE IS DRAWN. The chip used to print "Deployed Aug 20, 11:07" at the
 * far right of the header, where it was the last thing in a row that gives, so
 * on an ordinary window it truncated to "Deployed Aug 20, 11:07 ..." -- a label
 * whose most precise part was the part that got cut. Beside the wordmark, where
 * it now sits, the question it answers is "which build am I looking at", and the
 * date answers it in six characters. The time and the commit are on the tooltip
 * for the reader who is reconciling a deploy against a push.
 */
import { useId } from 'react';
import { Clock3 } from 'lucide-react';

import { deploymentTimeLabel, deploymentTimeTitle } from './deployment-time';

/**
 * THE TOOLTIP IS AN ELEMENT, NOT A `title` ATTRIBUTE, and the difference is the
 * whole of why this chip spent a release claiming a tooltip nobody could read.
 *
 * A `title` is pointer-only. `<time>` takes no focus, so there was no keystroke
 * that could reach the release time at all, and a `title` on an element that has
 * its own text content is not the element's accessible description either -- the
 * name comes from the contents and the attribute is dropped. So the string was
 * in the markup, the suite asserted the string was in the markup, and the fact
 * was unreachable by hover on a 40px target, by keyboard, and by screen reader.
 *
 * What replaces it is a described-by element that is always rendered whenever
 * there is a stamp to describe. Its visibility is one CSS rule keyed to `:hover`
 * and `:focus-visible` on the chip, so there is no provider to wrap it in, no
 * portal to mount, and no state that can be wrong -- the three ways a tooltip
 * component fails open. It is `opacity`-hidden rather than `visibility`-hidden
 * because `aria-describedby` must still resolve while it is not on screen.
 */
export function DeploymentTimeChip({
  deployedAt,
  deployedBy = '',
  buildSha = '',
}: {
  deployedAt: string;
  deployedBy?: string;
  buildSha?: string;
}) {
  // The header and the mobile sheet both draw a chip, so the id has to be per
  // instance: two tooltips under one id is a description that resolves to
  // whichever happened to render first.
  const tooltipId = `${useId()}deployed`;
  const label = deploymentTimeLabel(deployedAt);
  const detail = deploymentTimeTitle(deployedAt, buildSha, deployedBy);
  if (!label || !detail) return null;

  return (
    <time
      className="deployment-time-chip"
      data-testid="deployment-time-chip"
      dateTime={new Date(deployedAt).toISOString()}
      // Focusable so the tooltip has a keyboard route. base.css draws the ring.
      tabIndex={0}
      aria-describedby={tooltipId}
    >
      {/* 14px, which is the glyph size the account badge and the gear beside it
          draw. At 12px this chip read as a smaller-grade control than its two
          neighbours on the same rail. */}
      <Clock3 className="size-3.5" aria-hidden="true" />
      <span className="deployment-time-label">{label}</span>
      <span className="deployment-time-tooltip" data-testid="deployment-time-tooltip" id={tooltipId} role="tooltip">
        {detail}
      </span>
    </time>
  );
}
