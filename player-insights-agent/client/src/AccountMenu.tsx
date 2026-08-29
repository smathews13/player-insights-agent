import { useEffect, useId, useRef, useState } from 'react';
import { LogOut, ShieldPlus, UserRound } from 'lucide-react';
import type { Identity } from './app-types';
import { BrandIcon } from './BrandIcon';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { signOutAndEndAppSession } from './app-session';
import { accountSlackHref } from './account-slack-links';
import { RoleBadgePill } from './RoleBadge';
import type { RoleState } from './role';
import { identityName } from './user-identity';

function DatabricksSymbol({ className }: { className?: string }) {
  return <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: DATABRICKS_SYMBOL }} />;
}

export function AccountMenuPanel({
  identity,
  role,
  onSignOut,
}: {
  identity: Identity;
  role: RoleState;
  onSignOut: () => void;
}) {
  const name = identityName(identity.signedInAs);
  return (
    <div className="account-menu" role="menu" aria-label="Account menu">
      <div className="account-menu-identity">
        {/*
          THE SAME THREE THINGS THE TRIGGER CARRIES, in the same order: the mark,
          the name, then the rank. The panel used to open on a bare name and an
          address, so pressing the chip replaced the reader's own icon and badge
          with two lines of text and the dropdown read as somebody else's account.

          It matters most at narrow widths, which is where it is not merely a
          repetition: responsive.css hides the header cluster's informational
          members below 800px, so this is the only place the rank appears at all.

          `RoleBadgePill` and not `RoleBadge` -- the second live region would
          announce a lost role twice. See the note on the pill.
        */}
        <span className="account-menu-who">
          <UserRound aria-hidden="true" />
          <strong>{name}</strong>
          <RoleBadgePill state={role} />
        </span>
        <span className="account-menu-address">{identity.signedInAs}</span>
      </div>
      <div className="account-menu-group">
        <a href={accountSlackHref('feedback')} target="_blank" rel="noopener noreferrer" role="menuitem">
          <span>Report feedback</span>
          <DatabricksSymbol className="account-menu-databricks" />
        </a>
        <a href={accountSlackHref('escalation')} target="_blank" rel="noopener noreferrer" role="menuitem">
          <span>Escalate to Super Admin</span>
          <ShieldPlus aria-hidden="true" />
        </a>
      </div>
      <div className="account-menu-group account-menu-leave">
        <a href="/api/account/apps" role="menuitem">
          <BrandIcon product="apps" size={14} />
          <span>Back to Databricks Apps</span>
        </a>
        <button type="button" role="menuitem" onClick={onSignOut}>
          <LogOut aria-hidden="true" />
          <span className="account-menu-signout-label">Sign out of Astrolabe</span>
        </button>
        <p className="account-menu-session-note">App and workspace sessions are separate.</p>
        <details className="account-menu-session-details">
          <summary>What sign-out does</summary>
          <p>
            Astrolabe clears its app session and native app cookie. If the upstream workspace or identity-provider
            session is still active, Databricks may authenticate you again without prompting. Federated logout is not
            supported.
          </p>
        </details>
      </div>
    </div>
  );
}

export function AccountMenu({ identity, role }: { identity: Identity; role: RoleState }) {
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const name = identityName(identity.signedInAs);

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
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((current) => !current)}
        >
          <UserRound aria-hidden="true" />
          <span className="identity-chip-text">
            <span className="identity-chip-label">Signed in </span>
            <strong className="identity-chip-name">{name}</strong>
          </span>
        </button>
        {open ? (
          <div id={menuId}>
            <AccountMenuPanel identity={identity} role={role} onSignOut={signOut} />
          </div>
        ) : null}
      </div>
    </>
  );
}
