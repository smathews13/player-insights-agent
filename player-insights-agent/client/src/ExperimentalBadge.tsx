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

/** Feature name plus the small pill. Status lives in its own table cell. */
export function ExperimentalFeatureName({ children }: { children: ReactNode }) {
  return (
    <span className="exp-feature-name">
      <span className="exp-feature-title">{children}</span>
      <ExperimentalBadge />
    </span>
  );
}

export function ExperimentalStatus({
  on,
  onLabel,
  offLabel,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <span className={`ast-pill ${on ? 'ast-pill--pos' : 'ast-pill--neutral'}`}>
      {on ? onLabel : offLabel}
    </span>
  );
}
