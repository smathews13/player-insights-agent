import { LogOut, ShieldPlus } from 'lucide-react';
import type { Identity } from './app-types';
import { organizationForEmail } from '../../shared/organization-mapping';
import { BrandIcon } from './BrandIcon';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { OrganizationAvatar } from './OrganizationAvatar';
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
  const organization = organizationForEmail(identity.signedInAs, identity.organizations ?? []);
  return (
    <div className="account-menu" aria-label="Account controls">
      <div className="account-menu-identity">
        <OrganizationAvatar organization={organization} />
        <span className="account-menu-identity-copy">
          {/*
            `RoleBadgePill` and not `RoleBadge` -- the second live region would
            announce a lost role twice. See the note on the pill.
          */}
          <span className="account-menu-who">
            <strong>{name}</strong>
            <RoleBadgePill state={role} />
          </span>
          <span className="account-menu-address">{identity.signedInAs}</span>
        </span>
      </div>
      <div className="account-menu-group">
        <a href={accountSlackHref('feedback')} target="_blank" rel="noopener noreferrer">
          <span>Report feedback</span>
          <DatabricksSymbol className="account-menu-databricks" />
        </a>
        <a href={accountSlackHref('escalation')} target="_blank" rel="noopener noreferrer">
          <span>Escalate to Super Admin</span>
          <ShieldPlus aria-hidden="true" />
        </a>
      </div>
      <div className="account-menu-group account-menu-leave">
        <a href="/api/account/apps">
          <BrandIcon product="apps" size={14} />
          <span>Back to Databricks Apps</span>
        </a>
        <button type="button" onClick={onSignOut}>
          <LogOut aria-hidden="true" />
          <span className="account-menu-signout-label">Sign out of Astrolabe</span>
        </button>
      </div>
    </div>
  );
}
