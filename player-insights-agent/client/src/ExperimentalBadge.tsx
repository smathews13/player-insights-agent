import type { ReactNode } from 'react';

export const EXPERIMENTAL_PANE_HINT =
  'Experimental: this pane may be unstable or may not work as expected.';

/** A shared warning for Connections controls that are not yet dependable. */
export function ExperimentalBadge() {
  return (
    <span
      className="ast-pill ast-pill--warn experimental-pane-badge"
      title={EXPERIMENTAL_PANE_HINT}
      aria-label={EXPERIMENTAL_PANE_HINT}
    >
      Experimental
    </span>
  );
}

/** Settings → Experimental row title plus the small pill. No “· Experimental” text. */
export function ExperimentalRowLabel({ children }: { children: ReactNode }) {
  return (
    <p className="settings-row-label">
      <span className="settings-row-label-text">{children}</span>
      <ExperimentalBadge />
    </p>
  );
}
