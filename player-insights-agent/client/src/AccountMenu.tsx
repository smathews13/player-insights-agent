import { useEffect, useId, useRef, useState } from 'react';
import { LogOut, ShieldPlus, UserRound } from 'lucide-react';
import type { Identity } from './app-types';
import { AstrolabeMark } from './AstrolabeMark';
import { BrandIcon } from './BrandIcon';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { signOutOfAstrolabe } from './first-open';
import { accountSlackHref } from './account-slack-links';
import { identityName } from './user-identity';

function DatabricksSymbol({ className }: { className?: string }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: DATABRICKS_SYMBOL }}
    />
  );
}

export function AccountMenuPanel({
  identity,
  onSignOut,
}: {
  identity: Identity;
  onSignOut: () => void;
}) {
  const name = identityName(identity.signedInAs);
  return (
    <div className="account-menu" role="menu" aria-label="Account menu">
      <div className="account-menu-identity">
        <strong>{name}</strong>
        <span>{identity.signedInAs}</span>
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
          <span>Sign out of</span>
          <AstrolabeMark size={13} className="account-menu-astrolabe" />
          <span>astrolabe</span>
        </button>
      </div>
    </div>
  );
}

export function AccountMenu({ identity }: { identity: Identity }) {
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
    signOutOfAstrolabe();
    window.location.reload();
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
            <AccountMenuPanel identity={identity} onSignOut={signOut} />
          </div>
        ) : null}
      </div>
    </>
  );
}
