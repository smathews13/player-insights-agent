import { FlaskConical, Network, NotebookTabs, Tags, TrendingUp, type LucideIcon } from 'lucide-react';
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

export type ExperimentalFeatureKind =
  | 'egress-controls'
  | 'notebook-agent-sync'
  | 'resource-tags'
  | 'forecasting'
  | 'benchmarking';

const EXPERIMENTAL_FEATURE_ICONS: Readonly<Record<ExperimentalFeatureKind, LucideIcon>> = {
  'egress-controls': Network,
  'notebook-agent-sync': NotebookTabs,
  'resource-tags': Tags,
  forecasting: TrendingUp,
  benchmarking: FlaskConical,
};

/** Decorative icon, accessible feature name, then the small pill -- in one shared order. */
export function ExperimentalFeatureName({ kind, children }: { kind: ExperimentalFeatureKind; children: ReactNode }) {
  const Icon = EXPERIMENTAL_FEATURE_ICONS[kind];
  return (
    <span className="exp-feature-name">
      <Icon className={`exp-feature-icon exp-feature-icon--${kind}`} aria-hidden="true" />
      <span className="exp-feature-label">
        <span className="exp-feature-title">{children}</span>
        <ExperimentalBadge />
      </span>
    </span>
  );
}

/** The one visible vocabulary for a binary switch state. */
export function StateStatus({ on }: { on: boolean }) {
  return <span className={`ast-pill ${on ? 'ast-pill--pos' : 'ast-pill--neutral'}`}>{on ? 'On' : 'Off'}</span>;
}

/** Backwards-compatible name for the Experimental feature table. */
export const ExperimentalStatus = StateStatus;
