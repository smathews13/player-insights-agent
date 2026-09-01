/**
 * The route's page box and neutral placeholders exist immediately.
 *
 * The shell uses the same page geometry as the eventual route. Placeholders
 * carry no labels, values, charts or table rows, so nothing can be mistaken for
 * data. The status is available to assistive technology in the same frame.
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
  return <RouteSkeleton visible />;
}
