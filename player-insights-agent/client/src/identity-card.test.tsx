import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IdentityCard } from './IdentityPanel';
import { questionsRunAs, type DeploymentIdentity, type PanelIdentity } from './identity-panel-state';
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
function textOf(read: DeploymentIdentity): string {
  return renderToStaticMarkup(<IdentityCard read={read} />)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A sign-in short of a required ask-path permission. */
describe('IdentityCard', () => {
  it('names the account the app is holding, rather than describing it', () => {
    expect(textOf(SIGNED_IN)).toContain('someone');
  });

  it('renders the three retained identity groups in one overview', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    const text = textOf(SIGNED_IN);

    for (const section of ['Signed-in user', 'App', 'Service principal']) {
      expect(text).toContain(section);
    }
    expect(markup.match(/class="identity-section"/g)).toHaveLength(3);
    expect(markup).toContain('class="identity-overview"');
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

  it('keeps full long values in titles and explicit copy controls', () => {
    const longIdentity: PanelIdentity = {
      ...IDENTITY,
      signedInAs: 'someone.with.a.long.identity@example.cloud.databricks.com',
      identityMetadata: {
        ...IDENTITY.identityMetadata!,
        app: {
          ...IDENTITY.identityMetadata!.app,
          workspaceHost: 'https://an-extraordinarily-long-workspace-host.cloud.databricks.com',
        },
      },
    };
    const markup = renderToStaticMarkup(<IdentityCard read={{ identity: longIdentity, failed: false }} />);
    expect(markup).toContain(
      'title="someone.with.a.long.identity@example.cloud.databricks.com">someone.with.a.long.identity@example.cloud.databricks.com</span>'
    );
    expect(markup).toContain('title="https://an-extraordinarily-long-workspace-host.cloud.databricks.com"');
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

  it('collapses unavailable SP metadata into one compact Not reported row', () => {
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
    const markup = renderToStaticMarkup(<IdentityCard read={read} />);
    const sp = markup.slice(markup.indexOf('identity-sp-heading'));
    expect(sp).toContain(
      'Metadata</p><div class="identity-fact-value"><span class="identity-not-reported">Not reported'
    );
    expect(sp.match(/Not reported/g)).toHaveLength(1);
    expect(sp).not.toContain('Display name');
    expect(sp).not.toContain('Object ID');
    expect(sp).not.toContain('Verification');
    expect(sp).not.toContain('abcdefab service principal');
  });

  it('names an effective assigned persona without adding execution prose', () => {
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
    expect(text).not.toContain('Execution boundary');
    expect(text).not.toContain('reads run as');
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

  it('shows an assigned persona without restoring the removed lower sections', () => {
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
    expect(text).not.toContain('Execution boundary');
    expect(text).not.toContain('Effective user API scopes');
  });

  it('removes the execution boundary, scope table, and every lower identity row', () => {
    const text = textOf({
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
    });
    expect(text).not.toContain('Execution boundary');
    expect(text).not.toContain('Effective user API scopes');
    expect(text).not.toContain('dashboards.genie');
    expect(text).not.toMatch(/private browsing window/i);
    expect(text).not.toContain('To fix');
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
