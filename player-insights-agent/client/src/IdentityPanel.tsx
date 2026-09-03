/** Compact signed-in user and app identity summary. */
import { KeyRound } from 'lucide-react';
import { Card } from './ui';
import { OAuthBadge } from './OAuthBadge';
import { CopyButton, StatusBadge } from './StatusBadge';
import { useDeploymentIdentity, type DeploymentIdentity } from './identity-panel-state';
import { DATABRICKS_SYMBOL } from './brand-icons';
import type { AppAttachedResourceMetadata } from '../../shared/identity-metadata';
import { UserDrilldownLink } from './UserDrilldownLink';
import { RoleBadgePill } from './RoleBadge';
import { organizationForEmail } from '../../shared/organization-mapping';
import { OrganizationAvatar } from './OrganizationAvatar';

/**
 * The `/api/identity` payload, as this card reads it.
 *
 * Extends `Identity` rather than restating a subset of it, because the OAuth
 * badge is handed this object whole and decides its state from `identitySource`
 * and `session`. A local shape that happened to omit either would draw a neutral
 * badge on a deployment whose sign-in had failed.
 */
/** One label-and-value line. Nothing renders when there is no value. */
function Fact({ label, children, wrap = false }: { label: string; children: React.ReactNode; wrap?: boolean }) {
  return (
    <div className="identity-fact" data-wrap={wrap || undefined}>
      <p className="identity-fact-label">{label}</p>
      <div className="identity-fact-value">{children}</div>
    </div>
  );
}

function Identifier({ label, value }: { label: string; value: string }) {
  return (
    <span className="identity-identifier">
      <StatusBadge value={value} tone="plain" title={value} />
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <StatusBadge value={value} tone="plain" title={value} />
      <CopyButton value={value} label={`Copy ${label}`} />
    </>
  );
}

function ServicePrincipalAuthentication() {
  return (
    <span className="service-principal-auth" aria-label="Service principal authentication">
      <span
        className="ast-pill ast-pill--pos service-principal-auth-badge"
        aria-label="Service principal OAuth authentication"
        title="Service principal OAuth authentication"
      >
        OAuth
      </span>
      <span
        className="ast-pill ast-pill--pos service-principal-auth-badge"
        aria-label="Machine-to-machine OAuth authentication"
        title="Machine-to-machine OAuth authentication"
      >
        <KeyRound size={11} strokeWidth={2.5} aria-hidden="true" />
        M2M
      </span>
    </span>
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

function resourceTypeLabel(resourceType: string): string {
  if (resourceType === 'postgres') return 'Lakebase';
  if (resourceType === 'serving_endpoint') return 'Serving';
  if (resourceType === 'sql_warehouse') return 'SQL warehouse';
  const words = resourceType.replace(/[_-]+/g, ' ').trim();
  return words && words !== 'unknown' ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : 'Resource';
}

function visibleResourceIdentifier(resource: AppAttachedResourceMetadata): string {
  if (resource.resourceType !== 'sql_warehouse' || resource.displayIdentifier.length <= 9) {
    return resource.displayIdentifier;
  }
  return `${resource.displayIdentifier.slice(0, 8)}…`;
}

function AttachedResource({ resource }: { resource: AppAttachedResourceMetadata }) {
  const typeLabel = resourceTypeLabel(resource.resourceType);
  const fullTitle = resource.title || resource.displayIdentifier;
  const accessibleName = [
    `${typeLabel} attached resource`,
    fullTitle,
    `binding ${resource.resourceKey}`,
    resource.permission ? `permission ${resource.permission}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="identity-attached-resource" role="listitem">
      <StatusBadge
        value={`${typeLabel} · ${visibleResourceIdentifier(resource)}`}
        tone="reachable"
        title={accessibleName}
        ariaLabel={accessibleName}
      />
      <CopyButton value={resource.displayIdentifier} label={`Copy ${typeLabel} resource identifier`} />
    </span>
  );
}

function ExecutionValue({
  identity,
  assignedPersona,
}: {
  identity: NonNullable<DeploymentIdentity['identity']>;
  assignedPersona: string;
}) {
  const mode = identity.analyticalExecution?.mode;
  if (mode === 'signed_in_user') {
    return (
      <>
        <OAuthBadge identity={identity} />
        <UserDrilldownLink identity={identity.signedInAs} compact role={identity.role ?? 'failed'} />
      </>
    );
  }
  if (mode === 'app_service_principal') {
    return <span>{identity.identityMetadata?.app.displayName || 'Astrolabe'} app</span>;
  }
  if (mode === 'assigned_service_principal') {
    return <span>{assignedPersona ? `Assigned persona · ${assignedPersona}` : 'Assigned persona'}</span>;
  }
  if (identity.spIdentity?.executingAs === 'service_principal') {
    return <span>{assignedPersona ? `Assigned persona · ${assignedPersona}` : 'Service principal'}</span>;
  }
  return <span>{mode ? mode.replaceAll('_', ' ') : 'Not reported'}</span>;
}

/**
 * A read the caller has already made. When it is absent this card makes its
 * own, so a caller that only wants the card keeps working unchanged.
 */
export function IdentityCard({ read }: { read?: DeploymentIdentity; remedyStatedElsewhere?: boolean } = {}) {
  const own = useDeploymentIdentity(!read);
  const { identity, failed } = read ?? own;
  const metadata = identity?.identityMetadata;
  const organization = identity?.signedInAs
    ? organizationForEmail(identity.signedInAs, identity.organizations ?? [])
    : null;
  const assignedPersona = identity?.spIdentity?.assigned?.displayName ?? '';
  const servicePrincipal = metadata?.servicePrincipal;

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
                {identity?.role ? (
                  <Fact label="Astrolabe role">
                    <RoleBadgePill state={identity.role} />
                  </Fact>
                ) : null}
                {organization ? (
                  <Fact label="Organization">
                    <span className="identity-organization">
                      <OrganizationAvatar organization={organization} />
                      <span>{organization.name}</span>
                    </span>
                  </Fact>
                ) : null}
                <Fact label="Authentication">
                  <OAuthBadge identity={identity} />
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
                    <CopyableValue label="Databricks app resource name" value={metadata.app.resourceName} />
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
                  {identity ? <ExecutionValue identity={identity} assignedPersona={assignedPersona} /> : null}
                </Fact>
              </div>
            </section>

            <section className="identity-section" aria-labelledby="identity-sp-heading">
              <h4 id="identity-sp-heading">Service principal</h4>
              <div className="identity-section-grid">
                {servicePrincipal?.state === 'verified' ? (
                  <>
                    {servicePrincipal.displayName ? (
                      <Fact label="Display name">
                        <span className="identity-full-value" title={servicePrincipal.displayName}>
                          {servicePrincipal.displayName}
                        </span>
                      </Fact>
                    ) : null}
                    {servicePrincipal.applicationId ? (
                      <Fact label="Application ID">
                        <Identifier label="application ID" value={servicePrincipal.applicationId} />
                      </Fact>
                    ) : null}
                    {servicePrincipal.objectId ? (
                      <Fact label="Service principal ID">
                        <Identifier label="service principal ID" value={servicePrincipal.objectId} />
                      </Fact>
                    ) : null}
                    {servicePrincipal.authenticationType ? (
                      <Fact label="Authentication">
                        {servicePrincipal.authenticationType === 'OAuth machine-to-machine' ? (
                          <ServicePrincipalAuthentication />
                        ) : (
                          <span>{servicePrincipal.authenticationType}</span>
                        )}
                      </Fact>
                    ) : null}
                    {servicePrincipal.attachedResources?.length ? (
                      <Fact label="Attached resources" wrap>
                        <span className="identity-attached-resources" role="list" aria-label="Attached app resources">
                          {servicePrincipal.attachedResources.map((resource) => (
                            <AttachedResource
                              key={`${resource.resourceType}:${resource.resourceKey}:${resource.displayIdentifier}`}
                              resource={resource}
                            />
                          ))}
                        </span>
                      </Fact>
                    ) : null}
                  </>
                ) : (
                  <Fact label="Status">
                    <StatusBadge value="Unavailable" tone="plain" />
                  </Fact>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </Card>
  );
}
