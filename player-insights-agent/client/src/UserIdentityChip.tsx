/**
 * The app-wide presentation for a person: a UserRound mark and the identity's
 * local part inside the same bordered chip used in the header.
 *
 * Full addresses stay in `title`; the visible local part is enough to recognise
 * a colleague without repeating an identical domain across every list.
 */
import { UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { identityName } from './user-identity';

export function UserIdentityChip({
  identity,
  label,
  compact = false,
  className,
  testId,
  suffix,
  icon,
  showFullIdentity = false,
  title,
  ariaLabel,
}: {
  identity: string | null | undefined;
  label?: string;
  compact?: boolean;
  className?: string;
  testId?: string;
  suffix?: ReactNode;
  /** Replace the generic person glyph when the caller has a stronger identity mark. */
  icon?: ReactNode;
  /** Profile headers may show the full address; dense lists keep the local part. */
  showFullIdentity?: boolean;
  /** Accessible hover detail when a surface combines person and organization. */
  title?: string;
  /** Complete accessible name when the visible compact label omits detail. */
  ariaLabel?: string;
}) {
  const value = identity?.trim() ?? '';
  const name = identityName(value);
  return (
    <span
      className={`identity-chip${compact ? ' identity-chip--compact' : ''}${className ? ` ${className}` : ''}`}
      data-testid={testId}
      title={title ?? (value || 'User identity not recorded')}
      aria-label={ariaLabel}
    >
      {icon ?? <UserRound className={compact ? 'size-3' : 'size-3.5'} aria-hidden="true" />}
      <span className="identity-chip-text">
        {label ? <span className="identity-chip-label">{label} </span> : null}
        <span className="identity-chip-name">{showFullIdentity && value ? value : name}</span>
      </span>
      {suffix}
    </span>
  );
}
