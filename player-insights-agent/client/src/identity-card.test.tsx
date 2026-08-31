import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IdentityCard, identityTableScopes } from './IdentityPanel';
import { questionsRunAs, type DeploymentIdentity, type PanelIdentity } from './identity-panel-state';
import { PLATFORM_DEFAULT_USER_API_SCOPES, userApiScopeDetail } from '../../shared/user-api-scope-details';
import { DATABRICKS_SYMBOL } from './brand-icons';

/**
 * The Identity card as it is composed, rather than as its source reads.
 *
 * This file exists for one reviewer comment. The card was read on a live
 * deployment as `Connected as  not reported · questions run as the signed-in
 * user`, over a title reading "Identity and permissions" and a sentence
 * beginning "Which service principals this deployment is connected as". The
 * verdict was that it was garbage text: somebody who opens this card is
 * checking their own permissions, and every one of those strings spent their
 * attention telling them something they already knew.
 *
 * So the assertions below are mostly NEGATIVE, and they name the exact strings
 * that were on screen. A card that reads well today is not the thing being
 * protected -- what is being protected is that these particular sentences
 * cannot come back without failing here rather than on a deployment.
 *
 * `renderToStaticMarkup` runs no effects, which is why the card takes its read
 * as a parameter. That is also the arrangement the page uses, so what is
 * asserted here is what the page draws.
 */
const IDENTITY: PanelIdentity = {
  signedInAs: 'someone@example.com',
  identitySource: 'databricks-apps',
  executionIdentity: 'abcdefab-0000-4000-8000-000000000000',
  executionMode: 'signed_in_user',
  role: 'admin',
  session: {
    state: 'current',
    signedIn: true,
    tokenScopes: ['sql'],
    declaredScopes: ['sql'],
    missingScopes: [],
    cause: 'session-current',
    evidence: 'The presented token lists sql, which is what this deployment declares.',
    explanation: 'A user access token reached the app.',
    remedy: null,
  },
  analyticalExecution: { mode: 'signed_in_user', verified: true },
  spIdentity: {
    enabled: false,
    minting: { available: true, detail: '' },
    assigned: null,
    executingAs: 'oauth',
    fallbackReason: null,
  },
  identityMetadata: {
    user: {
      displayName: 'Someone Example',
      objectId: '1122334455667788',
      state: 'verified',
      readAt: '2026-08-31T17:00:00.000Z',
    },
    app: {
      displayName: 'Astrolabe',
      resourceName: 'player-insights-agent',
      workspaceHost: 'https://dbc-example.cloud.databricks.com',
      workspaceId: '<workspace-id>',
    },
    servicePrincipal: {
      displayName: 'Astrolabe application service principal',
      applicationId: 'abcdefab-0000-4000-8000-000000000000',
      objectId: '9988776655443322',
      state: 'verified',
      readAt: '2026-08-31T17:00:00.000Z',
    },
  },
};

const SIGNED_IN: DeploymentIdentity = { identity: IDENTITY, failed: false };

/** The markup with its tags removed, which is roughly what a reader is handed. */
function textOf(read: DeploymentIdentity, remedyStatedElsewhere = false): string {
  return renderToStaticMarkup(<IdentityCard read={read} remedyStatedElsewhere={remedyStatedElsewhere} />)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A sign-in short of a required ask-path permission. */
const SHORT_OF_A_PERMISSION: DeploymentIdentity = {
  identity: {
    ...IDENTITY,
    session: {
      ...IDENTITY.session!,
      state: 'stale',
      tokenScopes: ['sql'],
      declaredScopes: ['sql', 'dashboards.genie'],
      missingScopes: ['dashboards.genie'],
    },
  },
  failed: false,
};

describe('IdentityCard', () => {
  it('names the account the app is holding, rather than describing it', () => {
    expect(textOf(SIGNED_IN)).toContain('someone');
  });

  it('renders the complete structured user, app, SP, and execution-boundary summary', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    const text = textOf(SIGNED_IN);

    for (const section of ['Signed-in user', 'App', 'Service principal', 'Execution boundary']) {
      expect(text).toContain(section);
    }
    for (const value of [
      'Someone Example',
      'someone@example.com',
      'Admin',
      'Databricks Apps OAuth',
      'Verified · workspace profile matched',
      'Astrolabe',
      'player-insights-agent',
      'https://dbc-example.cloud.databricks.com',
      '<workspace-id>',
      'Astrolabe application service principal',
      'abcdefab-0000-4000-8000-000000000000',
      '9988776655443322',
      'Lakebase and app state · control-plane metadata',
    ]) {
      expect(text).toContain(value);
    }
    expect(markup).toContain(DATABRICKS_SYMBOL);
  });

  it('keeps user and app-SP identities separate, with full titles and explicit ID copy controls', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    expect(markup).toContain('title="someone@example.com">someone@example.com</span>');
    for (const [label, value] of [
      ['workspace user ID', '1122334455667788'],
      ['Databricks app resource name', 'player-insights-agent'],
      ['workspace ID', '<workspace-id>'],
      ['application ID', 'abcdefab-0000-4000-8000-000000000000'],
      ['service principal object ID', '9988776655443322'],
    ]) {
      expect(markup).toContain(`title="${value}"`);
      expect(markup).toContain(`aria-label="Copy ${label}"`);
    }
    expect(IDENTITY.signedInAs).not.toBe(IDENTITY.identityMetadata?.servicePrincipal.applicationId);
    expect(IDENTITY.identityMetadata?.user.objectId).not.toBe(IDENTITY.identityMetadata?.servicePrincipal.objectId);
  });

  it('shows Not reported, never a derived SP name, when the authoritative lookup was unavailable', () => {
    const read: DeploymentIdentity = {
      identity: {
        ...IDENTITY,
        identityMetadata: {
          ...IDENTITY.identityMetadata!,
          servicePrincipal: {
            displayName: '',
            applicationId: 'abcdefab-0000-4000-8000-000000000000',
            objectId: '',
            state: 'not_reported',
            readAt: '2026-08-31T17:01:00.000Z',
          },
        },
      },
      failed: false,
    };
    const text = textOf(read);
    expect(text).toContain('Service principal Display name Not reported');
    expect(text).toContain('Object ID Not reported');
    expect(text).toContain('Verification Not reported');
    expect(text).not.toContain('abcdefab service principal');
  });

  it('names an effective assigned persona without implying the app SP widened data access', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        role: 'super_admin',
        analyticalExecution: { mode: 'assigned_service_principal', verified: true },
        spIdentity: {
          enabled: true,
          minting: { available: true, detail: '' },
          assigned: { id: 'p1', displayName: 'Finance analyst', clientId: 'persona-client-id' },
          executingAs: 'service_principal',
          fallbackReason: null,
        },
      },
      failed: false,
    });
    expect(text).toContain('Astrolabe role Super admin');
    expect(text).toContain('Assigned persona Finance analyst');
    expect(text).toContain('reads run as the assigned persona Finance analyst');
    expect(text).toContain('app service principal does not widen Unity Catalog data access');
  });

  it('never renders credential-shaped or raw-error fields accidentally present on the payload', () => {
    const identity = {
      ...IDENTITY,
      clientSecret: 'client-secret-must-not-render',
      authorization: 'Bearer bearer-must-not-render',
      databasePassword: 'database-password-must-not-render',
      identityMetadata: {
        ...IDENTITY.identityMetadata!,
        rawError: '403 with token-must-not-render',
      },
    };
    const markup = renderToStaticMarkup(<IdentityCard read={{ identity, failed: false }} />);
    expect(markup).not.toMatch(
      /client-secret-must-not-render|bearer-must-not-render|database-password-must-not-render|token-must-not-render/
    );
  });

  it('prints none of the sentences the card was rebuilt to stop printing', () => {
    const text = textOf(SIGNED_IN);
    expect(text).not.toMatch(/questions run as the signed-in user/i);
    expect(text).not.toMatch(/identity and permissions/i);
    expect(text).not.toMatch(/which service principals this deployment is connected as/i);
    expect(text).not.toMatch(/dependency checks and your own access are separate/i);
  });

  it('shows an assigned persona while keeping the actual OAuth execution boundary honest', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        spIdentity: {
          enabled: true,
          minting: { available: false, detail: 'minting unavailable' },
          assigned: { id: 'p1', displayName: 'Finance analyst', clientId: 'aaaaaaaa-0000-4000-8000-000000000001' },
          executingAs: 'oauth',
          fallbackReason: 'This app cannot mint a token for another service principal. Questions stay on OAuth.',
        },
      },
      failed: false,
    });
    expect(text).toContain('Assigned persona Finance analyst');
    expect(text).toContain('reads run as the signed-in user');
    expect(text).not.toContain('reads run as the assigned persona');
  });

  /**
   * THE REMEDY IN `scope-refusal.ts` NAMES THIS CARD. Three of its branches end
   * "The Connected as section of the Connections page lists what your sign-in
   * carries and what this app asks for", so a reader following a 403 arrives here
   * looking for the shortfall. It must be findable.
   *
   * It is now the DIFFERENCE and not the two lists. Both in full was twenty-six
   * monospace chips on a card about two identifiers, and it asked the reader to
   * do by eye a subtraction the server publishes: `missingScopes`. So the carried
   * permission the app does not ask for is gone from the screen, and the declared
   * permission the sign-in lacks -- the only one that explains a 403 -- is on it.
   */
  it('names every permission in a Scope and Details table, without printing both lists', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'stale',
          tokenScopes: ['sql'],
          declaredScopes: ['sql', 'dashboards.genie'],
          missingScopes: ['dashboards.genie'],
        },
      },
      failed: false,
    });
    expect(text).toContain('Scope');
    expect(text).toContain('Details');
    expect(text).toContain('dashboards.genie');
    expect(text).not.toContain('Sign-in carries');
    expect(text).not.toContain('App asks for');
    expect(text).not.toContain('Missing permissions');
  });

  it('always lists optional catalog permissions, even when undeclared', () => {
    const text = textOf(SIGNED_IN);
    expect(text).toContain('Scope');
    expect(text).toContain('catalog.tables:read');
    expect(text).toContain('catalog.schemas:read');
    expect(text).toContain('catalog.catalogs:read');
  });

  it('states declared and effective scope state and gives every displayed scope a real explanation', () => {
    const markup = renderToStaticMarkup(
      <IdentityCard
        read={{
          identity: {
            ...IDENTITY,
            session: {
              ...IDENTITY.session!,
              state: 'stale',
              declaredScopes: ['sql', 'dashboards.genie'],
              missingScopes: ['dashboards.genie'],
            },
          },
          failed: false,
        }}
      />
    );
    expect(markup.match(/<th scope="col">/g)).toHaveLength(4);
    expect(markup).toContain('<th scope="col">Scope</th>');
    expect(markup).toContain('<th scope="col">Declared</th>');
    expect(markup).toContain('<th scope="col">Effective</th>');
    expect(markup).toContain('<th scope="col">Details</th>');
    expect(markup).toMatch(/data-scope="sql"[\s\S]*?<td>Yes<\/td><td>Yes<\/td>/);
    expect(markup).toMatch(/data-scope="dashboards\.genie"[\s\S]*?<td>Yes<\/td><td>No<\/td>/);
    expect(markup).toMatch(/data-scope="catalog\.tables:read"[\s\S]*?<td>No<\/td><td>No<\/td>/);

    for (const scope of identityTableScopes(['sql', 'dashboards.genie'])) {
      const detail = userApiScopeDetail(scope);
      expect(detail.trim(), `${scope} has no detail`).not.toBe('');
      expect(detail.trim(), `${scope} repeats its own name as detail`).not.toBe(scope);
      expect(markup).toContain(`data-scope="${scope}"`);
      expect(markup).toContain(detail);
    }
  });

  it('draws each scope as plain monospace text without a duplicate status chip', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    const rows = [...markup.matchAll(/data-scope="/g)].length;
    expect(rows).toBeGreaterThan(2);
    expect([...markup.matchAll(/identity-scope-code/g)]).toHaveLength(rows);
    const table = markup.slice(markup.indexOf('identity-scope-table'), markup.indexOf('</table>'));
    expect(table).not.toContain('identity-scope-pill');
    expect(table).not.toContain('lucide-check');
  });

  it('marks both Databricks-provided IAM scopes as platform defaults and effective', () => {
    const text = textOf(SIGNED_IN);
    for (const scope of PLATFORM_DEFAULT_USER_API_SCOPES) {
      expect(text).toMatch(new RegExp(`${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Platform default Yes`));
    }
  });

  it('includes postgres only when this app declares it', () => {
    expect(identityTableScopes(['sql'])).not.toContain('postgres');
    expect(identityTableScopes(['sql', 'postgres'])).toContain('postgres');
  });

  it('tells a reader whose sign-in is short of a declared permission to sign in again', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'stale',
          tokenScopes: ['sql'],
          declaredScopes: ['sql', 'dashboards.genie'],
          missingScopes: ['dashboards.genie'],
        },
      },
      failed: false,
    });
    expect(text).toContain('Open this app again in a private browsing window, and sign in there.');
    expect(text).not.toContain('does not carry a permission the app asks for');
    expect(text).not.toContain('Signing out of Databricks does not clear');
  });

  it('leaves the sign-in line to What to fix when that panel is on screen', () => {
    const withPanel = textOf(SHORT_OF_A_PERMISSION, true);
    expect(withPanel).not.toMatch(/private browsing window/i);
    expect(withPanel).toContain('dashboards.genie');
  });

  it('says the sign-in line itself when nothing is blocked, so no panel renders', () => {
    const alone = textOf(SHORT_OF_A_PERMISSION, false);
    expect(alone).toContain('Open this app again in a private browsing window, and sign in there.');
    expect(alone).toContain('dashboards.genie');
  });

  it('does not push a private window for optional catalog shortfalls alone', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'stale',
          tokenScopes: ['sql'],
          declaredScopes: ['sql', 'catalog.tables:read'],
          missingScopes: ['catalog.tables:read'],
        },
      },
      failed: false,
    });
    expect(text).not.toMatch(/private browsing window/i);
    expect(text).not.toContain('Missing permissions');
    expect(text).toContain('Scope');
    expect(text).toContain('catalog.tables:read');
  });

  /**
   * THE FAILURE MODE THIS WHOLE FEATURE IS DESIGNED AGAINST. This reader carries
   * every permission the app declares; the workspace refused the OBJECT, which
   * is a grant an admin adds. A private window would hand them the same
   * permissions and the same 403, so offering one sends them round the loop the
   * sign-in prompt exists to end. The row that reported the refusal says what is
   * actually needed; this card must stay quiet.
   */
  it('offers no sign-in to a reader who lacks a grant rather than a permission', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'current',
          tokenScopes: ['sql', 'unity-catalog'],
          declaredScopes: ['sql', 'catalog.tables:read'],
          missingScopes: [],
        },
      },
      failed: false,
    });
    expect(text).not.toMatch(/private browsing window/i);
    expect(text).not.toMatch(/sign in there/i);
  });

  it('offers no sign-in when nothing about the sign-in could be established', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        session: {
          ...IDENTITY.session!,
          state: 'undetermined',
          tokenScopes: null,
          declaredScopes: null,
          missingScopes: [],
        },
      },
      failed: false,
    });
    expect(text).not.toMatch(/private browsing window/i);
  });

  it('says nothing about permissions when the sign-in stated none', () => {
    // A null list is a sign-in that enumerated nothing, which the badge already
    // reports. An empty row here would read as a sign-in carrying nothing.
    const text = textOf({
      identity: { ...IDENTITY, session: { ...IDENTITY.session!, tokenScopes: null } },
      failed: false,
    });
    expect(text).not.toContain('Sign-in carries');
  });

  it('carries the app OAuth badge, and only the one badge', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    // The shared badge from `oauth-badge.ts`. A badge invented for this card
    // would be a second opinion about a question one module already answers,
    // which is how a green chip and a red chip came to sit on one screen making
    // opposite claims about one sign-in.
    expect(markup).toContain('data-testid="oauth-badge"');
    expect(markup.match(/data-testid="oauth-badge"/g)).toHaveLength(1);
  });

  it('says the client id is not reported rather than leaving the row blank', () => {
    // The absence is the finding: an app with no client id in its environment
    // cannot authenticate its own writes. A gap beside the label would read as
    // a rendering bug instead.
    const identity = {
      ...IDENTITY,
      executionIdentity: '',
      identityMetadata: {
        ...IDENTITY.identityMetadata!,
        servicePrincipal: {
          ...IDENTITY.identityMetadata!.servicePrincipal,
          applicationId: '',
          state: 'not_reported' as const,
        },
      },
    };
    expect(textOf({ identity, failed: false })).toContain('Application ID Not reported');
  });

  it('reports a failed read as unreadable, not as nothing being connected', () => {
    const text = textOf({ identity: null, failed: true });
    expect(text).toContain('could not be read');
    // And says it in a chip rather than the four-sentence recovery instruction
    // it replaced, which told a reader to reload the page.
    expect(text).not.toMatch(/reload|try again|refresh the page/i);
    expect(text).not.toContain('someone@example.com');
  });

  it('draws no row for a principal it was not given, rather than an empty one', () => {
    const text = textOf({ identity: { ...IDENTITY, signedInAs: '' }, failed: false });
    expect(text).not.toContain('Questions run as');
  });
});

/**
 * Whose grants the next question would be computed with.
 *
 * The mode string itself is an internal identifier and is never printed: this
 * row is read by somebody deciding whether an answer could have been computed
 * with grants they do not hold, and `app_service_principal` is not an answer to
 * that question.
 */
describe('questionsRunAs', () => {
  it("names the app's own client id where the app is what executes", () => {
    expect(
      questionsRunAs({ ...IDENTITY, analyticalExecution: { mode: 'app_service_principal', verified: true } })
    ).toBe('abcdefab-0000-4000-8000-000000000000');
  });

  it('names the reader where on-behalf-of execution is what that mode means', () => {
    expect(questionsRunAs(IDENTITY)).toBe('someone@example.com');
  });

  it('never prints the internal mode string at a reader', () => {
    for (const mode of [
      'signed_in_user',
      'app_service_principal',
      'on_behalf_of_group',
      'assigned_service_principal',
    ]) {
      expect(questionsRunAs({ ...IDENTITY, analyticalExecution: { mode, verified: true } })).not.toContain('_');
    }
  });

  it('names the assigned persona when that is who questions run as', () => {
    expect(
      questionsRunAs({
        ...IDENTITY,
        analyticalExecution: { mode: 'assigned_service_principal', verified: true },
        spIdentity: {
          enabled: true,
          minting: { available: true, detail: 'ok' },
          assigned: { id: 'p1', displayName: 'Finance analyst', clientId: 'aaaaaaaa-0000-4000-8000-000000000001' },
          executingAs: 'service_principal',
          fallbackReason: null,
        },
      })
    ).toBe('Finance analyst');
  });

  it('names the reader when the pivot is on but this person has no persona', () => {
    expect(
      questionsRunAs({
        ...IDENTITY,
        spIdentity: {
          enabled: true,
          minting: { available: true, detail: 'ok' },
          assigned: null,
          executingAs: 'oauth',
          fallbackReason: null,
        },
      })
    ).toBe('someone@example.com');
  });

  it('returns nothing at all when there is no identity, so no row is drawn', () => {
    expect(questionsRunAs(null)).toBe('');
  });
});
