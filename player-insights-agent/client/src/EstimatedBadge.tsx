import { astPill } from './pia-pill';

/** Shared estimated-value badge matching the established Ops Cost treatment. */
export function EstimatedBadge({ className = '' }: { className?: string }) {
  return <span className={astPill('neutral-outline', `ast-estimated-badge ${className}`.trim())}>Estimated</span>;
}
