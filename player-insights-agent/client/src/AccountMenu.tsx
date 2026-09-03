import { lazy, Suspense, useId, useState } from 'react';
import type { Identity } from './app-types';
import type { OrganizationMapping } from '../../shared/organization-contract';
import { OrganizationAvatar } from './OrganizationAvatar';
import type { RoleState } from './role';
import { Popover, PopoverTrigger } from './ui';
import { canonicalIdentityEmail, identityDisplayName } from './user-identity';

const AccountMenuContent = lazy(() =>
  import('./AccountMenuPanel').then(({ AccountMenuContent: content }) => ({ default: content }))
);

const EXTERNAL_ORGANIZATION: OrganizationMapping = {
  id: 'external',
  domain: '',
  domainSuffixes: [],
  name: 'External',
  monogram: '•',
  logoKey: 'fallback',
  ariaLabel: 'Organization: External',
  fallback: 'building',
};

export function AccountMenu({ identity, role }: { identity: Identity; role: RoleState }) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const canonicalEmail = canonicalIdentityEmail(identity);
  const name = identityDisplayName(identity);
  const organization = identity.organization ?? EXTERNAL_ORGANIZATION;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="account-menu-root">
        <PopoverTrigger asChild>
          <button
            className="identity-chip account-menu-trigger app-menu-trigger"
            data-testid="identity-chip"
            type="button"
            title={canonicalEmail}
            aria-label={`Signed in as ${canonicalEmail}`}
            aria-expanded={open}
            aria-controls={menuId}
          >
            <OrganizationAvatar organization={organization} />
            <span className="identity-chip-text">
              <span className="identity-chip-label">Signed in </span>
              <strong className="identity-chip-name">{name}</strong>
            </span>
          </button>
        </PopoverTrigger>
        {open ? (
          <Suspense fallback={null}>
            <AccountMenuContent menuId={menuId} identity={identity} role={role} onClose={() => setOpen(false)} />
          </Suspense>
        ) : null}
      </div>
    </Popover>
  );
}
