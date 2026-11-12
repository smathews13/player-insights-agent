/**
 * The one way this app renders "we could not find out".
 *
 * One component rather than a convention, because a convention is what the app
 * had: every pane wrote its own red alert at the point it gave up, and they
 * disagreed on whether to name a remedy, whether to offer a retry, and whether
 * to say that the space below was blank rather than zero. Two of them offered a
 * reference row to fill the space, which is the behaviour this whole change
 * exists to delete.
 *
 * All of the wording is decided in `unavailable-copy.ts` and none of it here, so
 * the decision can be tested without a browser. This file is layout and ARIA.
 */
import { CircleAlert } from 'lucide-react';
import type { UnavailableNotice } from './unavailable-copy';
import { Alert, AlertDescription } from './ui';
import { RefreshButton } from './RefreshControl';

export interface UnavailablePanelProps {
  notice: UnavailableNotice;
  /**
   * Offered only when the notice says a retry could work. A caller that passes
   * one for a non-retryable failure does not get a button: the copy module has
   * already decided, and letting the call site override it here is how the two
   * would come to disagree.
   *
   * The label is not a prop. It re-reads the thing that could not be read, which
   * is the same action the Connections and Architecture headers offer, so it is
   * the same button and says the same word.
   */
  onRetry?: () => void;
}

export function UnavailablePanel({ notice, onRetry }: UnavailablePanelProps) {
  return (
    <Alert
      variant="destructive"
      /*
       * A card rather than a strip, which is what `alerts.css` does with this class.
       * The storage banner is a full-width strip on the red wash because it
       * interrupts a page that is otherwise working; this panel stands in the place
       * of the thing the reader came for, so the design gives it the geometry of the
       * panel it replaces -- 8px radius, white, a red edge -- and the wash would
       * make a whole empty region pink.
       */
      className="unavailable-panel"
      // `alert` interrupts a screen reader mid-sentence and `status` waits for a
      // pause. Which is right depends on whether somebody is waiting on this
      // right now, which the caller knows and this component does not, so it
      // arrives on the notice. Marked assertive only for the interrupting kind:
      // a page with three unreadable panes would otherwise announce three
      // interruptions before the reader has heard the first heading.
      role={notice.liveRegion}
      aria-live={notice.liveRegion === 'alert' ? 'assertive' : 'polite'}
    >
      <CircleAlert />
      {/* One element per line, in the order a reader needs them: what is missing,
          then what the blank space does and does not mean, then what to quote to
          support. AppKit lays the description slot out as a grid with a row per
          direct child, which is what this wants, and the app-wide `display: block`
          pin that used to defeat that -- and collapsed this panel's four lines onto
          one in front of a customer -- has been removed. */}
      <AlertDescription>
        <strong className="unavailable-heading">{notice.heading}</strong>
        {/* The provider's own words, before anything of ours. Monospace and
            selectable for the same reason the correlation id is: this is the line
            that gets pasted into a ticket, and prose wrapped around it has to be
            stripped by hand first. `<code>` rather than a styled span so it is
            still recognisably an error string with stylesheets off, which is how
            it will be read if this panel is ever copied into an email. */}
        {notice.error ? <code className="unavailable-error">{notice.error}</code> : null}
        {notice.stage || notice.identity ? (
          <span className="unavailable-context">
            {notice.stage ? <span>{notice.stage}</span> : null}
            {notice.identity ? <span>{notice.identity}</span> : null}
          </span>
        ) : null}
        <span className="unavailable-detail">
          {notice.retryAdvice ? `${notice.consequence} ${notice.retryAdvice}` : notice.consequence}
        </span>
        {notice.lastVerified || notice.correlation ? (
          <span className="unavailable-meta">
            {notice.lastVerified ? <span>{notice.lastVerified}</span> : null}
            {/* Monospace and selectable, because its only job is to be read aloud
                down a phone or pasted into a ticket. */}
            {notice.correlation ? <span className="unavailable-correlation">{notice.correlation}</span> : null}
          </span>
        ) : null}
        {notice.retryable && onRetry ? <RefreshButton className="unavailable-retry" onRefresh={onRetry} /> : null}
      </AlertDescription>
    </Alert>
  );
}
