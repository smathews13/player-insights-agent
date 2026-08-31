/** Complete user, app, and application-service-principal identity summary. */
import { Card } from './ui';
import { OAuthBadge } from './OAuthBadge';
import { CopyButton, StatusBadge } from './StatusBadge';
import { useDeploymentIdentity, type DeploymentIdentity } from './identity-panel-state';
import { DATABRICKS_SYMBOL } from './brand-icons';
// WHETHER to say it, decided away from this file. The condition is the part
// that must not vary between the surfaces that state it, and a card that
// decided for itself would eventually offer a fresh sign-in to somebody whose
// sign-in is fine -- which sends them round the loop this exists to end.
import { staleSignInNotice } from '../../shared/stale-sign-in';
import { OPTIONAL_USER_API_SCOPES } from '../../shared/optional-user-api-scopes';
import {
  PLATFORM_DEFAULT_USER_API_SCOPES,
  isPlatformDefaultUserApiScope,
  userApiScopeDetail,
} from '../../shared/user-api-scope-details';
import { ROLE_WORD } from '../../shared/user-roster-contract';
import { tokenCarriesScope } from '../../shared/token-scopes';
import type { SessionReport } from '../../shared/session-contract';

/**
 * The `/api/identity` payload, as this card reads it.
 *
 * Extends `Identity` rather than restating a subset of it, because the OAuth
 * badge is handed this object whole and decides its state from `identitySource`
 * and `session`. A local shape that happened to omit either would draw a neutral
 * badge on a deployment whose sign-in had failed.
 */
const NOT_REPORTED = 'Not reported';

/** A stamp as a reader's own local time, or '' when there is nothing to show. */
function when(iso: string | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
}

/** One label-and-value line. Nothing renders when there is no value. */
function Fact({ label, wrap, children }: { label: string; wrap?: boolean; children: React.ReactNode }) {
  return (
    <div className="identity-fact" data-wrap={wrap ? 'true' : undefined}>
      <p className="identity-fact-label">{label}</p>
      <div className="identity-fact-value">{children}</div>
    </div>
  );
}

function Identifier({ label, value }: { label: string; value: string | undefined }) {
  const reported = value?.trim() ?? '';
  if (!reported) return <span className="identity-not-reported">{NOT_REPORTED}</span>;
  return (
    <>
      <StatusBadge value={reported} tone="plain" title={reported} />
      <CopyButton value={reported} label={`Copy ${label}`} />
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

/** Scopes shown in Identity: declared asks, browse capabilities, and platform defaults. */
export function identityTableScopes(declared: readonly string[] | null | undefined): string[] {
  const declaredSet = new Set(declared ?? []);
  const optional = OPTIONAL_USER_API_SCOPES.filter((scope) => scope !== 'postgres' || declaredSet.has(scope));
  return [...new Set([...declaredSet, ...optional, ...PLATFORM_DEFAULT_USER_API_SCOPES])].sort((left, right) =>
    left.localeCompare(right)
  );
}

/**
 * The scope contract with declared and effective state kept separate.
 *
 * Postgres is conditional because some deployments do not request Lakebase
 * browsing; the two IAM scopes are always shown as Databricks platform defaults.
 */
function effectiveScope(session: SessionReport | null | undefined, scope: string): string {
  if (!session?.signedIn) return NOT_REPORTED;
  if (isPlatformDefaultUserApiScope(scope)) return 'Yes';
  if (!session.tokenScopes) return NOT_REPORTED;
  return tokenCarriesScope(session.tokenScopes, scope) ? 'Yes' : 'No';
}

function declaredScope(session: SessionReport | null | undefined, scope: string): string {
  if (isPlatformDefaultUserApiScope(scope)) return 'Platform default';
  if (!session?.declaredScopes) return NOT_REPORTED;
  return session.declaredScopes.includes(scope) ? 'Yes' : 'No';
}

function ScopeTable({ session }: { session: SessionReport | null | undefined }) {
  const scopes = identityTableScopes(session?.declaredScopes);
  return (
    <div className="identity-scope-table-wrap">
      <p className="identity-scope-title">Effective user API scopes</p>
      <table className="identity-scope-table" aria-label="Effective user API scopes">
        <thead>
          <tr>
            <th scope="col">Scope</th>
            <th scope="col">Declared</th>
            <th scope="col">Effective</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {scopes.map((scope) => (
            <tr key={scope} data-scope={scope}>
              <td>
                <code className="identity-scope-code">{scope}</code>
              </td>
              <td>{declaredScope(session, scope)}</td>
              <td>{effectiveScope(session, scope)}</td>
              <td>{userApiScopeDetail(scope)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * @param read A read the caller has already made. When it
 *   is absent this card makes its own, so a caller that only wants the card
 *   keeps working unchanged.
 * @param remedyStatedElsewhere Whether something else on the page already tells
 *   this reader to sign in again -- in practice, whether What to fix rendered.
 *
 *   THIS IS THE GATE ON SAYING IT TWICE, and it is a parameter rather than a read
 *   because the caller already holds the answer. What to fix draws when any check
 *   is not `ok`, and a reader whose sign-in is short of a declared permission
 *   normally has several: the panel then states the action once, over all of
 *   them, a few inches above this card. Repeating it here is the redundancy the
 *   last pass removed.
 *
 *   But the two conditions are not the same condition. A permission can be
 *   missing while nothing is blocked -- nothing this app probes happens to need
 *   the missing scope -- and then What to fix does not render at all and the
 *   action is on no surface. That is the hole this closes.
 *
 *   DEFAULTS TO FALSE, which is to say "nobody else is saying it". A card
 *   composed on its own has no panel beside it, so silence would be the wrong
 *   assumption: the failure this whole block exists to prevent is a reader who
 *   can see the shortfall and cannot see that ten seconds of their own would
 *   clear it.
 */
export function IdentityCard({
  read,
  remedyStatedElsewhere = false,
}: { read?: DeploymentIdentity; remedyStatedElsewhere?: boolean } = {}) {
  const own = useDeploymentIdentity(!read);
  const { identity, failed } = read ?? own;
  const session = identity?.session;
  const metadata = identity?.identityMetadata;
  const role = identity?.role ? ROLE_WORD[identity.role] : NOT_REPORTED;
  const userVerified =
    identity?.identitySource === 'databricks-apps' && session?.signedIn === true
      ? metadata?.user.state === 'verified'
        ? 'Verified · workspace profile matched'
        : 'Verified by Databricks Apps'
      : 'Not verified';
  const authMode =
    identity?.identitySource === 'databricks-apps' ? 'Databricks Apps OAuth' : 'Local development fallback';
  const assignedPersona = identity?.spIdentity?.assigned?.displayName ?? '';
  const appSp = metadata?.servicePrincipal;
  const clientId =
    appSp?.applicationId?.trim() ||
    (identity?.executionIdentity && identity.executionIdentity !== 'Astrolabe service principal'
      ? identity.executionIdentity.trim()
      : '');
  const governedIdentity =
    identity?.spIdentity?.executingAs === 'service_principal' && assignedPersona
      ? `the assigned persona ${assignedPersona}`
      : 'the signed-in user';
  /**
   * Whether this reader is being told to sign in again, and null wherever the
   * evidence does not support telling them.
   *
   * Kept separate from `missingScopes` above, which gates the shortfall ROW. The
   * row is evidence and is safe to show whenever there is a shortfall; this is an
   * instruction, and an instruction needs the narrower gate.
   *
   * And suppressed outright where the page already carries it, which is the
   * common case. Two gates, because they answer two questions: whether telling
   * this reader to sign in again is TRUE, and whether it has already been said.
   */
  const stale = remedyStatedElsewhere ? null : staleSignInNotice(session);

  return (
    <Card className="deployment-card deployment-card-identity" data-testid="identity-panel">
      <div className="deployment-card-head">
        <p className="deployment-card-title">
          <DatabricksMark />
          Identity
        </p>
      </div>
      <div className="deployment-card-body">
        {failed ? ( // One line, in the shape of every other value on the card: a chip that
          // says what state this is in. The four-sentence recovery instruction it
          // replaces told a reader to reload the page, which they can see for
          // themselves, and named the route, which they cannot act on.
          <Fact label="Identity">
            <StatusBadge value="could not be read" tone="blocked" />
          </Fact>
        ) : (
          <>
            <section className="identity-section" aria-labelledby="identity-user-heading">
              <h4 id="identity-user-heading">Signed-in user</h4>
              <div className="identity-section-grid">
                <Fact label="Display name">
                  <span>{metadata?.user.displayName || NOT_REPORTED}</span>
                </Fact>
                <Fact label="Email">
                  <span className="identity-full-value" title={identity?.signedInAs || NOT_REPORTED}>
                    {identity?.signedInAs || NOT_REPORTED}
                  </span>
                </Fact>
                <Fact label="Astrolabe role">
                  <span>{role}</span>
                </Fact>
                {assignedPersona ? (
                  <Fact label="Assigned persona">
                    <span>{assignedPersona}</span>
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
                <Fact label="Resource name">
                  <Identifier label="Databricks app resource name" value={metadata?.app.resourceName} />
                </Fact>
                <Fact label="Workspace host">
                  <span className="identity-full-value" title={metadata?.app.workspaceHost || NOT_REPORTED}>
                    {metadata?.app.workspaceHost || NOT_REPORTED}
                  </span>
                </Fact>
                {metadata?.app.workspaceId ? (
                  <Fact label="Workspace ID">
                    <Identifier label="workspace ID" value={metadata.app.workspaceId} />
                  </Fact>
                ) : null}
              </div>
            </section>

            <section className="identity-section" aria-labelledby="identity-sp-heading">
              <h4 id="identity-sp-heading">Service principal</h4>
              <div className="identity-section-grid">
                <Fact label="Display name">
                  <span>{appSp?.displayName || NOT_REPORTED}</span>
                </Fact>
                <Fact label="Application ID">
                  <Identifier label="application ID" value={clientId} />
                </Fact>
                <Fact label="Object ID">
                  <Identifier label="service principal object ID" value={appSp?.objectId} />
                </Fact>
                <Fact label="Verification">
                  <span>{appSp?.state === 'verified' ? 'Verified by Databricks SCIM' : NOT_REPORTED}</span>
                </Fact>
                <Fact label="Metadata read">
                  <span>{when(appSp?.readAt) || NOT_REPORTED}</span>
                </Fact>
                <Fact label="Responsibility" wrap>
                  <span>Lakebase and app state · control-plane metadata</span>
                </Fact>
              </div>
            </section>

            <section className="identity-section identity-boundary" aria-labelledby="identity-boundary-heading">
              <h4 id="identity-boundary-heading">Execution boundary</h4>
              <ul>
                <li>Governed SQL, Genie, and Vector Search reads run as {governedIdentity}.</li>
                <li>The app service principal does not widen Unity Catalog data access.</li>
              </ul>
            </section>

            <ScopeTable session={session} />
            {/* THE ONE THING A READER CAN DO, in one line, and only where nothing
                else on the page is saying it.

                It used to be three lines in a washed box: what happened, what to
                do, and what not to try instead. All three are stated by What to
                fix, once, over every refusal they explain, a few inches above
                this card -- so on the common path this block is silent and the
                panel does the talking.

                It is not deleted, because the two conditions differ. What to fix
                renders off BLOCKED CHECKS and this renders off a MISSING
                PERMISSION, and a deployment can have the second without the
                first: nothing this app probes needs the scope that is short. On
                that deployment the panel is not on screen and the action would be
                on no surface at all, which is how a reader ends up looking for a
                grant for something ten seconds of their own would fix.

                Two gates, then. `staleSignInNotice` decides whether telling them
                is TRUE -- a reader who holds every declared permission and is
                refused a GRANT is told nothing, because a private window hands
                them the same permissions and the same refusal -- and
                `remedyStatedElsewhere` decides whether it has already been
                said. */}
            {stale ? (
              <Fact label="To fix">
                <span className="identity-stale-do" data-testid="identity-stale">
                  {stale.action}
                </span>
              </Fact>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
