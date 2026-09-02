import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Link, useInRouterContext, useLocation } from 'react-router';
import { showsAdminSurfaces, useOptionalRole, type RoleState } from './role';
import { identityName } from './user-identity';
import { UserIdentityChip } from './UserIdentityChip';
import { normalizedHumanEmail, userOverviewHref } from './user-drilldown';

function activateSpace(event: KeyboardEvent<HTMLAnchorElement>) {
  if (event.key !== ' ') return;
  event.preventDefault();
  event.currentTarget.click();
}

export function UserDrilldownLink({
  identity,
  label,
  compact = false,
  className = '',
  title,
  role,
  canOpen,
  showArrow = false,
  variant = 'chip',
  children,
}: {
  identity: string | null | undefined;
  label?: string;
  compact?: boolean;
  className?: string;
  title?: string;
  role?: RoleState;
  canOpen?: boolean;
  /** Trailing visual cue, rendered only when this identity is actually a link. */
  showArrow?: boolean;
  variant?: 'chip' | 'text';
  children?: ReactNode;
}) {
  const outletRole = useOptionalRole()?.state;
  const email = normalizedHumanEmail(identity);
  const allowed = canOpen ?? showsAdminSurfaces(role ?? outletRole ?? 'failed');
  const content =
    variant === 'chip' ? (
      <UserIdentityChip
        identity={identity}
        label={label}
        compact={compact}
        className={className || undefined}
        suffix={
          showArrow && allowed && email ? (
            <ArrowUpRight className="identity-chip-link-arrow size-3" aria-hidden="true" />
          ) : null
        }
      />
    ) : (
      <span className={className || undefined} title={title}>
        {children ?? identityName(identity)}
      </span>
    );

  if (!allowed || !email) return content;
  return (
    <AuthorizedUserDrilldownLink email={email} variant={variant}>
      {content}
    </AuthorizedUserDrilldownLink>
  );
}

function AuthorizedUserDrilldownLink({
  email,
  variant,
  children,
}: {
  email: string;
  variant: 'chip' | 'text';
  children: ReactNode;
}) {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    const href = userOverviewHref(email) ?? '/monitoring';
    return (
      <a
        href={href}
        className={`user-drilldown-link user-drilldown-link--${variant}`}
        aria-label={`Open user overview for ${identityName(email)}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={activateSpace}
      >
        {children}
      </a>
    );
  }
  return (
    <RoutedUserDrilldownLink email={email} variant={variant}>
      {children}
    </RoutedUserDrilldownLink>
  );
}

function RoutedUserDrilldownLink({
  email,
  variant,
  children,
}: {
  email: string;
  variant: 'chip' | 'text';
  children: ReactNode;
}) {
  const location = useLocation();
  const href = userOverviewHref(email, location.pathname === '/monitoring' ? location.search : '') ?? '/monitoring';
  return (
    <Link
      to={href}
      className={`user-drilldown-link user-drilldown-link--${variant}`}
      aria-label={`Open user overview for ${identityName(email)}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={activateSpace}
    >
      {children}
    </Link>
  );
}
