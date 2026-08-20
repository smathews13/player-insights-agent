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

import { commitOf, SHORT_SHA_LENGTH } from '../../shared/build-stamps';

/** `Aug 20`. No year, no time, no verb: the chip's context supplies all three. */
export function deploymentTimeLabel(deployedAt: string): string {
  const at = new Date(deployedAt);
  if (!deployedAt || Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

/** `10:51:23 AM MDT`, or '' for a reader whose own zone IS the one already named. */
export function deploymentLocalTime(deployedAt: string): string {
  const at = new Date(deployedAt);
  if (!deployedAt || Number.isNaN(at.getTime())) return '';
  const clock = { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' } as const;
  const local = at.toLocaleString('en-US', clock);
  // Printing "4:51:23 PM UTC · 4:51:23 PM UTC" to a reader in London states one
  // fact twice and reads as a rendering fault rather than as agreement.
  return local === at.toLocaleString('en-US', { ...clock, timeZone: 'UTC' }) ? '' : local;
}

/**
 * The whole fact, for hover and for focus: the release time in UTC and in the
 * reader's own zone, who released it, and the commit it was built from.
 *
 * UTC LEADS because this string is what gets pasted into an incident note, where
 * a reader's own zone is the one thing the note cannot carry. The local clock
 * follows it for the reader who is placing the release against their own
 * afternoon rather than against a log.
 *
 * AN UNSTAMPED BUILD SAYS NOTHING ABOUT A COMMIT. A deploy tree built outside
 * the release script carries no `PLAYER_INSIGHTS_BUILD_SHA`, and appending an
 * empty clause -- "built from" with nothing after it -- would read as a commit
 * this app failed to print rather than as one nobody stamped.
 */
export function deploymentTimeTitle(deployedAt: string, buildSha = '', deployedBy = ''): string {
  const at = new Date(deployedAt);
  if (!deployedAt || Number.isNaN(at.getTime())) return '';
  const when = `Deployed ${at.toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })}`;
  // The same abbreviation the Build card prints, and the same `+dirty` handling:
  // the suffix is the build's opinion of its worktree, not part of the hash.
  const commit = commitOf(buildSha).slice(0, SHORT_SHA_LENGTH);
  const local = deploymentLocalTime(deployedAt);
  const facts = [when, local, deployedBy.trim() ? `by ${deployedBy.trim()}` : '', commit ? `commit ${commit}` : ''];
  return facts.filter(Boolean).join(' \u00b7 ');
}

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
      <Clock3 className="size-3" aria-hidden="true" />
      <span className="deployment-time-label">{label}</span>
      <span className="deployment-time-tooltip" data-testid="deployment-time-tooltip" id={tooltipId} role="tooltip">
        {detail}
      </span>
    </time>
  );
}
