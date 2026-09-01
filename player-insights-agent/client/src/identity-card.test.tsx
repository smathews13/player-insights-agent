import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IdentityCard } from './IdentityPanel';
import type { DeploymentIdentity, PanelIdentity } from './identity-panel-state';
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

  it('renders the two retained identity groups in one overview', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    const text = textOf(SIGNED_IN);

    for (const section of ['Signed-in user', 'App']) {
      expect(text).toContain(section);
    }
    expect(markup.match(/class="identity-section"/g)).toHaveLength(2);
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
      'Execution',
      'Signed-in user',
    ]) {
      expect(text).toContain(value);
    }
    expect(text).not.toMatch(/service principal|application id|object id|metadata read|responsibility/i);
    expect(markup).not.toMatch(/identity-sp-heading|Copy application ID|Copy service principal object ID/i);
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
    ]) {
      expect(markup).toContain(`title="${value}"`);
      expect(markup).toContain(`aria-label="Copy ${label}"`);
    }
  });

  it('omits unavailable optional metadata without placeholders or empty rows', () => {
    const read: DeploymentIdentity = {
      identity: {
        ...IDENTITY,
        identityMetadata: {
          user: { displayName: '', objectId: '', state: 'not_reported', readAt: '' },
          app: { displayName: 'Astrolabe', resourceName: '', workspaceHost: '', workspaceId: '' },
        },
      },
      failed: false,
    };
    const markup = renderToStaticMarkup(<IdentityCard read={read} />);
    expect(markup).not.toContain('Not reported');
    expect(markup).not.toContain('identity-not-reported');
    expect(markup).not.toContain('Resource name');
    expect(markup).not.toContain('Workspace host');
    expect(markup).not.toContain('Workspace ID');
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
          assigned: { displayName: 'Finance analyst' },
          executingAs: 'service_principal',
          fallbackReason: null,
        },
      },
      failed: false,
    });
    expect(text).toContain('Astrolabe role Super admin');
    expect(text).toContain('Execution Assigned persona · Finance analyst');
    expect(text).not.toContain('Execution boundary');
    expect(text).not.toContain('reads run as');
  });

  it('never renders credential-shaped or raw-error fields accidentally present on the payload', () => {
    const identity = {
      ...IDENTITY,
      executionIdentity: 'abcdefab-0000-4000-8000-000000000000',
      clientSecret: 'client-secret-must-not-render',
      authorization: 'Bearer bearer-must-not-render',
      databasePassword: 'database-password-must-not-render',
      identityMetadata: {
        ...IDENTITY.identityMetadata!,
        servicePrincipal: {
          displayName: 'Legacy app principal',
          applicationId: 'abcdefab-0000-4000-8000-000000000000',
          objectId: '9988776655443322',
          state: 'verified',
          readAt: '2026-08-31T17:00:00.000Z',
        },
        rawError: '403 with token-must-not-render',
      },
    };
    const markup = renderToStaticMarkup(<IdentityCard read={{ identity, failed: false }} />);
    expect(markup).not.toMatch(
      /client-secret-must-not-render|bearer-must-not-render|database-password-must-not-render|token-must-not-render|Legacy app principal|abcdefab|9988776655443322/
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
          assigned: { displayName: 'Finance analyst' },
          executingAs: 'oauth',
          fallbackReason: 'This app cannot mint a token for another service principal. Questions stay on OAuth.',
        },
      },
      failed: false,
    });
    expect(text).toContain('Execution Signed-in user · assigned persona Finance analyst');
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

describe('execution responsibility', () => {
  it('names app execution without exposing an application identity', () => {
    const text = textOf({
      identity: { ...IDENTITY, analyticalExecution: { mode: 'app_service_principal', verified: true } },
      failed: false,
    });
    expect(text).toContain('Execution Astrolabe app');
    expect(text).not.toMatch(/service principal|abcdefab/i);
  });

  it('names an assigned persona without returning its internal ids', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        analyticalExecution: { mode: 'assigned_service_principal', verified: true },
        spIdentity: {
          enabled: true,
          minting: { available: true, detail: 'ok' },
          assigned: { displayName: 'Finance analyst' },
          executingAs: 'service_principal',
          fallbackReason: null,
        },
      },
      failed: false,
    });
    expect(text).toContain('Execution Assigned persona · Finance analyst');
    expect(text).not.toMatch(/client id|application id|object id/i);
  });
});
