/**
 * The one control in this app that re-reads something, and the line that says
 * when it last did.
 *
 * There were four of these, written four times: the Connections header, the
 * Architecture header, the retry inside the Connections error alert, and the
 * retry on the unavailable panel. Because each was its own markup, each could be
 * corrected on its own -- and three of them were, at which point one header said
 * "Re-check" while the sentence beneath the other named "Run the checks" and a
 * button doing exactly the same work said "Try again". The drift was not a
 * mistake anybody made; it was the shape of the code.
 *
 * So the word, the icon, the pending state and the freshness line are decided
 * here and nowhere else. A page supplies the two things only it knows: whether a
 * read is in flight, and when the last one finished.
 */
import { RefreshCw } from 'lucide-react';
import { PiaLoaderMark } from './PiaLoader';
import { Button } from './ui';
import { REFRESH_BUSY_LABEL, REFRESH_LABEL, readAgo } from './refresh-state';

export interface RefreshButtonProps {
  /** Whether a read is in flight. Disables the button and spins the icon. */
  busy?: boolean;
  onRefresh: () => void;
  className?: string;
}

/**
 * The button, for the places that have no room for the freshness line -- inside
 * an error alert, or on the unavailable panel, where the line above it has
 * already said what could not be read and when.
 *
 * Its accessible name is its own text, so it reads as "Refreshing…" while it is
 * working rather than as a name that has stopped being true. The icon is hidden
 * from the accessibility tree for the same reason: it would otherwise be a
 * second, wordless copy of the button.
 */
export function RefreshButton({ busy = false, onRefresh, className }: RefreshButtonProps) {
  return (
    <Button
      /*
       * FILLED BLUE, EVERYWHERE IT APPEARS. It was `outline`, which put the one
       * control on these pages that does anything in the quietest treatment the
       * app has, on headings whose only other content is a timestamp. The Ops
       * health block had already been specified as primary blue, so five surfaces
       * disagreed with the sixth and the sixth was the one that was right.
       *
       * This is the reason the control is a component: the change is made once
       * here and Connections, Architecture, Monitoring, Ops, the unavailable
       * panel and the access gate all follow. Do not restyle it per page.
       */
      variant="default"
      size="sm"
      className={className ? `refresh-button ${className}` : 'refresh-button'}
      onClick={onRefresh}
      // A second press cannot race the first. Both reads land on the same
      // state, and the later answer used to be able to arrive first.
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={REFRESH_LABEL}
    >
      <span className="pia-button-state" data-busy={busy ? 'true' : 'false'} aria-hidden="true">
        <span className="pia-button-state__idle">
          <RefreshCw className="size-3.5" />
          {REFRESH_LABEL}
        </span>
        <span className="pia-button-state__busy">
          <PiaLoaderMark variant="button" tone="dark" />
          <span>{REFRESH_BUSY_LABEL}</span>
        </span>
      </span>
      <span className="sr-only">{REFRESH_LABEL}</span>
    </Button>
  );
}

export interface RefreshControlProps extends RefreshButtonProps {
  /** ISO stamp of the last read, or empty where nothing has been read. */
  checkedAt: string;
  /** Injectable so a test can assert a rounding rather than the clock. */
  now?: number;
}

/**
 * The pair: when it was last read, then the button.
 *
 * The freshness line is what makes an unchanged answer visibly a fresh one. On a
 * healthy deployment every verdict comes back identical, so without it the only
 * evidence a press did anything is that nothing changed -- which is
 * indistinguishable from a control wired to nothing, and is what this one was
 * taken for.
 *
 * The visible line is hidden from the accessibility tree and repeated in a live
 * region, rather than being one element that is both. A live region is announced
 * when it CHANGES, which is how the wait and its end get spoken; leaving the
 * visible copy in the tree as well would make a reader hear the same sentence
 * twice on the way past.
 */
export function RefreshControl({ busy = false, checkedAt, now, onRefresh, className }: RefreshControlProps) {
  const line = readAgo(checkedAt, now);
  return (
    <div className={className ? `refresh-control ${className}` : 'refresh-control'}>
      <p className="refresh-control-when" aria-hidden="true">
        {line}
      </p>
      <RefreshButton busy={busy} onRefresh={onRefresh} />
      <p className="sr-only" role="status" aria-live="polite">
        {busy ? REFRESH_BUSY_LABEL : line}
      </p>
    </div>
  );
}
