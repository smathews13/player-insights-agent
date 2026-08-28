import type { ReactNode } from 'react';

export const EXPERIMENTAL_PANE_HINT = 'Experimental: this pane may be unstable or may not work as expected.';

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

/** Feature name plus the small pill. Status lives in its own table cell. */
export function ExperimentalFeatureName({ children }: { children: ReactNode }) {
  return (
    <span className="exp-feature-name">
      <ExperimentalBadge />
      <span className="exp-feature-title">{children}</span>
    </span>
  );
}

/** The one visible vocabulary for a binary switch state. */
export function StateStatus({ on }: { on: boolean }) {
  return <span className={`ast-pill ${on ? 'ast-pill--pos' : 'ast-pill--neutral'}`}>{on ? 'On' : 'Off'}</span>;
}

/** Backwards-compatible name for the Experimental feature table. */
export const ExperimentalStatus = StateStatus;
