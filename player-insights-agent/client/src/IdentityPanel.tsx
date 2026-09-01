/** Compact signed-in user and app identity summary. */
import { Card } from './ui';
import { OAuthBadge } from './OAuthBadge';
import { CopyButton, StatusBadge } from './StatusBadge';
import { useDeploymentIdentity, type DeploymentIdentity } from './identity-panel-state';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { ROLE_WORD } from '../../shared/user-roster-contract';

/**
 * The `/api/identity` payload, as this card reads it.
 *
 * Extends `Identity` rather than restating a subset of it, because the OAuth
 * badge is handed this object whole and decides its state from `identitySource`
 * and `session`. A local shape that happened to omit either would draw a neutral
 * badge on a deployment whose sign-in had failed.
 */
/** One label-and-value line. Nothing renders when there is no value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="identity-fact">
      <p className="identity-fact-label">{label}</p>
      <div className="identity-fact-value">{children}</div>
    </div>
  );
}

function Identifier({ label, value }: { label: string; value: string }) {
  return (
    <>
      <StatusBadge value={value} tone="plain" title={value} />
      <CopyButton value={value} label={`Copy ${label}`} />
    </>
  );
}

function DatabricksMark() {
  return (
    <span
      className="identity-databricks-mark"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: DATABRICKS_SYMBOL }}
    />
  );
}

/**
 * A read the caller has already made. When it is absent this card makes its
 * own, so a caller that only wants the card keeps working unchanged.
 */
export function IdentityCard({ read }: { read?: DeploymentIdentity; remedyStatedElsewhere?: boolean } = {}) {
  const own = useDeploymentIdentity(!read);
  const { identity, failed } = read ?? own;
  const session = identity?.session;
  const metadata = identity?.identityMetadata;
  const role = identity?.role ? ROLE_WORD[identity.role] : '';
  const userVerified =
    identity?.identitySource === 'databricks-apps' && session?.signedIn === true
      ? metadata?.user.state === 'verified'
        ? 'Verified · workspace profile matched'
        : 'Verified by Databricks Apps'
      : 'Not verified';
  const authMode =
    identity?.identitySource === 'databricks-apps' ? 'Databricks Apps OAuth' : 'Local development fallback';
  const assignedPersona = identity?.spIdentity?.assigned?.displayName ?? '';
  const execution =
    identity?.analyticalExecution?.mode === 'app_service_principal'
      ? 'Astrolabe app'
      : identity?.spIdentity?.executingAs === 'service_principal' && assignedPersona
        ? `Assigned persona · ${assignedPersona}`
        : assignedPersona
          ? `Signed-in user · assigned persona ${assignedPersona}`
          : 'Signed-in user';

  return (
    <Card className="deployment-card deployment-card-identity" data-testid="identity-panel">
      <div className="deployment-card-head">
        <p className="deployment-card-title">
          <DatabricksMark />
          Identity
        </p>
      </div>
      <div className="deployment-card-body deployment-card-identity-body">
        {failed ? ( // One line, in the shape of every other value on the card: a chip that
          // says what state this is in. The four-sentence recovery instruction it
          // replaces told a reader to reload the page, which they can see for
          // themselves, and named the route, which they cannot act on.
          <Fact label="Identity">
            <StatusBadge value="could not be read" tone="blocked" />
          </Fact>
        ) : (
          <div className="identity-overview">
            <section className="identity-section" aria-labelledby="identity-user-heading">
              <h4 id="identity-user-heading">Signed-in user</h4>
              <div className="identity-section-grid">
                {metadata?.user.displayName ? (
                  <Fact label="Display name">
                    <span>{metadata.user.displayName}</span>
                  </Fact>
                ) : null}
                {identity?.signedInAs ? (
                  <Fact label="Email">
                    <span className="identity-full-value" title={identity.signedInAs}>
                      {identity.signedInAs}
                    </span>
                  </Fact>
                ) : null}
                {role ? (
                  <Fact label="Astrolabe role">
                    <span>{role}</span>
                  </Fact>
                ) : null}
                <Fact label="Authentication">
                  <OAuthBadge identity={identity} />
                  <span>{authMode}</span>
                </Fact>
                <Fact label="Verification">
                  <span>{userVerified}</span>
                </Fact>
                {metadata?.user.objectId ? (
                  <Fact label="Workspace user ID">
                    <Identifier label="workspace user ID" value={metadata.user.objectId} />
                  </Fact>
                ) : null}
              </div>
            </section>

            <section className="identity-section" aria-labelledby="identity-app-heading">
              <h4 id="identity-app-heading">App</h4>
              <div className="identity-section-grid">
                <Fact label="Display name">
                  <span>{metadata?.app.displayName || 'Astrolabe'}</span>
                </Fact>
                {metadata?.app.resourceName ? (
                  <Fact label="Resource name">
                    <Identifier label="Databricks app resource name" value={metadata.app.resourceName} />
                  </Fact>
                ) : null}
                {metadata?.app.workspaceHost ? (
                  <Fact label="Workspace host">
                    <span className="identity-full-value" title={metadata.app.workspaceHost}>
                      {metadata.app.workspaceHost}
                    </span>
                  </Fact>
                ) : null}
                {metadata?.app.workspaceId ? (
                  <Fact label="Workspace ID">
                    <Identifier label="workspace ID" value={metadata.app.workspaceId} />
                  </Fact>
                ) : null}
                <Fact label="Execution">
                  <span>{execution}</span>
                </Fact>
              </div>
            </section>
          </div>
        )}
      </div>
    </Card>
  );
}
