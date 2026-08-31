import { useEffect, useState } from 'react';
import { scheduleRouteSkeleton } from './route-fallback-delay';

/**
 * The route's page box exists immediately; only its neutral placeholders wait.
 *
 * The shell uses the same page geometry as the eventual route. Placeholders
 * carry no labels, values, charts or table rows, so nothing can be mistaken for
 * data. The status stays available to assistive technology during the delay.
 */
export function RouteSkeleton({ visible }: { visible: boolean }) {
  return (
    <div
      className={`page-shell route-skeleton-shell${visible ? ' is-visible' : ''}`}
      data-testid="route-loading"
      aria-busy="true"
      aria-label="Loading view"
    >
      <p className="sr-only" role="status" aria-live="polite">
        Loading view
      </p>
      {visible ? (
        <div className="route-skeleton" aria-hidden="true">
          <div className="route-skeleton-heading" />
          <div className="route-skeleton-panel" />
          <div className="route-skeleton-panel route-skeleton-panel--short" />
        </div>
      ) : null}
    </div>
  );
}

export function RouteFallback() {
  const [visible, setVisible] = useState(false);

  useEffect(() => scheduleRouteSkeleton(() => setVisible(true)), []);

  return <RouteSkeleton visible={visible} />;
}
