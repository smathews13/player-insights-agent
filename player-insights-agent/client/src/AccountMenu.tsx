import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { Identity } from './app-types';
import { organizationForEmail } from '../../shared/organization-mapping';
import { OrganizationAvatar } from './OrganizationAvatar';
import { signOutAndEndAppSession } from './app-session';
import type { RoleState } from './role';
import { identityName } from './user-identity';

const AccountMenuPanel = lazy(() =>
  import('./AccountMenuPanel').then(({ AccountMenuPanel: panel }) => ({ default: panel }))
);

export function AccountMenu({ identity, role }: { identity: Identity; role: RoleState }) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const name = identityName(identity.signedInAs);
  const organization = organizationForEmail(identity.signedInAs, identity.organizations ?? []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const signOut = () => {
    setOpen(false);
    void signOutAndEndAppSession();
  };

  return (
    <>
      <div ref={root} className="account-menu-root">
        <button
          ref={trigger}
          className="identity-chip account-menu-trigger"
          data-testid="identity-chip"
          type="button"
          title={identity.signedInAs}
          aria-label={`Signed in as ${identity.signedInAs}`}
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <OrganizationAvatar organization={organization} />
          <span className="identity-chip-text">
            <span className="identity-chip-label">Signed in </span>
            <strong className="identity-chip-name">{name}</strong>
          </span>
        </button>
        {open ? (
          <div id={menuId}>
            <Suspense fallback={null}>
              <AccountMenuPanel identity={identity} role={role} onSignOut={signOut} />
            </Suspense>
          </div>
        ) : null}
      </div>
    </>
  );
}
