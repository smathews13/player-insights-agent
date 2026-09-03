import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
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
      displayName: 'Astrolabe application',
      applicationId: 'abcdefab-0000-4000-8000-000000000000',
      objectId: '9988776655443322',
      authenticationType: 'OAuth machine-to-machine',
      attachedResources: [
        {
          resourceKey: 'postgres',
          resourceType: 'postgres',
          displayIdentifier: 'databricks-postgres',
          permission: 'CAN_CONNECT_AND_CREATE',
          title: 'databricks-postgres · branch projects/player-insights/branches/production',
        },
        {
          resourceKey: 'serving-endpoint',
          resourceType: 'serving_endpoint',
          displayIdentifier: 'player-insights-agent',
          permission: 'CAN_QUERY',
        },
        {
          resourceKey: 'sql-warehouse',
          resourceType: 'sql_warehouse',
          displayIdentifier: '9cd123456789abcd',
          permission: 'CAN_USE',
        },
      ],
      state: 'verified',
    },
  },
};

const SIGNED_IN: DeploymentIdentity = { identity: IDENTITY, failed: false };
const CONNECTIONS_CSS = readFileSync(new URL('./styles/connections.css', import.meta.url), 'utf8');
const RESPONSIVE_CSS = readFileSync(new URL('./styles/responsive-connections.css', import.meta.url), 'utf8');
const TOKENS_CSS = readFileSync(new URL('./styles/astrolabe-tokens.css', import.meta.url), 'utf8');

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

  it('renders the three live identity groups in one overview', () => {
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
      'OAuth',
      'Verified · workspace profile matched',
      'Astrolabe',
      'player-insights-agent',
      'https://dbc-example.cloud.databricks.com',
      '<workspace-id>',
      'Execution',
      'Astrolabe application',
      'abcdefab-0000-4000-8000-000000000000',
      '9988776655443322',
      'OAuth machine-to-machine',
      'Attached resources',
      'Lakebase · databricks-postgres',
      'Serving · player-insights-agent',
      'SQL warehouse · 9cd12345…',
    ]) {
      expect(text).toContain(value);
    }
    expect(text).not.toMatch(/metadata read|responsibility|not reported/i);
    expect(markup).toContain('id="identity-sp-heading"');
    expect(markup).toContain('aria-label="Copy application ID"');
    expect(markup).toContain('aria-label="Copy service principal ID"');
    expect(markup.match(/data-tone="reachable"/g)).toHaveLength(3);
    expect(markup).toContain(
      'aria-label="Lakebase attached resource · databricks-postgres · branch projects/player-insights/branches/production · binding postgres · permission CAN_CONNECT_AND_CREATE"'
    );
    expect(markup).toContain(
      'aria-label="Serving attached resource · player-insights-agent · binding serving-endpoint · permission CAN_QUERY"'
    );
    expect(markup).toContain(
      'aria-label="SQL warehouse attached resource · 9cd123456789abcd · binding sql-warehouse · permission CAN_USE"'
    );
    expect(markup).toContain('aria-label="Copy Lakebase resource identifier"');
    expect(markup).toContain('aria-label="Copy Serving resource identifier"');
    expect(markup).toContain('aria-label="Copy SQL warehouse resource identifier"');
    expect(text).not.toMatch(/Attached resources\s+3(?:\s|$)/);
    expect(markup).toContain(DATABRICKS_SYMBOL);
  });

  it('uses a responsive three, two, and one-column layout without fixed heights', () => {
    expect(CONNECTIONS_CSS).toMatch(
      /\.identity-overview \{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(RESPONSIVE_CSS).toMatch(
      /@media \(max-width:\s*1180px\)[\s\S]*?\.identity-overview \{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(RESPONSIVE_CSS).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*?\.identity-overview \{[^}]*minmax\(0,\s*1fr\)/s
    );
    expect(CONNECTIONS_CSS).not.toMatch(/\.identity-section \{[^}]*(?:height|max-height):/s);
    expect(CONNECTIONS_CSS).toMatch(/\.identity-section \{[^}]*background:\s*var\(--background\)/s);
    expect(CONNECTIONS_CSS).toMatch(/\.identity-attached-resources \{[^}]*flex-wrap:\s*wrap/s);
    expect(CONNECTIONS_CSS).toMatch(
      /\.identity-fact\[data-wrap='true'\] \.identity-fact-value \{[^}]*overflow:\s*visible/s
    );
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    expect(markup.match(/class="ast-pill ast-pill--pos ast-num status-badge"/g)).toHaveLength(3);
    expect(TOKENS_CSS).toMatch(
      /\.ast-pill--pos \{[^}]*color:\s*var\(--ast-pos-text\)[^}]*background:\s*var\(--ast-pos-fill\)[^}]*border-color:\s*var\(--ast-pos-border\)/s
    );
    expect(TOKENS_CSS.match(/--ast-pos-fill:/g)).toHaveLength(2);
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
        servicePrincipal: {
          ...IDENTITY.identityMetadata!.servicePrincipal,
          applicationId: 'abcdefab-0000-4000-8000-000000000000-extra-long-application-id',
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
      ['application ID', 'abcdefab-0000-4000-8000-000000000000-extra-long-application-id'],
      ['service principal ID', '9988776655443322'],
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
          servicePrincipal: {
            displayName: 'Partial principal',
            applicationId: 'abcdefab-0000-4000-8000-000000000000',
            objectId: '',
            authenticationType: 'OAuth machine-to-machine',
            attachedResources: [],
            state: 'verified',
          },
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
    expect(markup).toContain('Partial principal');
    expect(markup).not.toContain('Service principal ID');
    expect(markup).not.toContain('Attached resources');
  });

  it('renders a future resource kind by its concrete binding name', () => {
    const identity: PanelIdentity = {
      ...IDENTITY,
      identityMetadata: {
        ...IDENTITY.identityMetadata!,
        servicePrincipal: {
          ...IDENTITY.identityMetadata!.servicePrincipal,
          attachedResources: [
            {
              resourceKey: 'player-vector-index',
              resourceType: 'vector_search',
              displayIdentifier: 'player-vector-index',
              permission: 'CAN_QUERY',
            },
          ],
        },
      },
    };
    const markup = renderToStaticMarkup(<IdentityCard read={{ identity, failed: false }} />);

    expect(markup).toContain('Vector search · player-vector-index');
    expect(markup).toContain(
      'aria-label="Vector search attached resource · player-vector-index · binding player-vector-index · permission CAN_QUERY"'
    );
    expect(markup).toContain('data-tone="reachable"');
  });

  it('shows one concise value when the live service principal is unavailable', () => {
    const metadata = {
      ...IDENTITY.identityMetadata!,
      servicePrincipal: {
        displayName: '',
        applicationId: '',
        objectId: '',
        authenticationType: '',
        attachedResources: [],
        state: 'not_reported' as const,
      },
    };
    const text = textOf({ identity: { ...IDENTITY, identityMetadata: metadata }, failed: false });
    expect(text).toContain('Service principal Status Unavailable');
    expect(text).not.toMatch(/not reported|metadata|responsibility/i);
  });

  it('names an effective assigned persona without adding execution prose', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        role: 'super_admin',
        analyticalExecution: { mode: 'assigned_service_principal', verified: true },
        spIdentity: {
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
          displayName: '<img src=x onerror=alert(1)>',
          applicationId: 'abcdefab-0000-4000-8000-000000000000',
          objectId: '9988776655443322',
          authenticationType: 'OAuth machine-to-machine',
          attachedResources: [],
          state: 'verified' as const,
        },
        rawError: '403 with token-must-not-render',
      },
    };
    const markup = renderToStaticMarkup(<IdentityCard read={{ identity, failed: false }} />);
    expect(markup).not.toMatch(
      /client-secret-must-not-render|bearer-must-not-render|database-password-must-not-render|token-must-not-render/
    );
    expect(markup).not.toContain('<img src=x');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('prints none of the sentences the card was rebuilt to stop printing', () => {
    const text = textOf(SIGNED_IN);
    expect(text).not.toMatch(/questions run as the signed-in user/i);
    expect(text).not.toMatch(/identity and permissions/i);
    expect(text).not.toMatch(/which service principals this deployment is connected as/i);
    expect(text).not.toMatch(/dependency checks and your own access are separate/i);
  });

  it('keeps OAuth execution on the signed-in user when an assigned persona cannot execute', () => {
    const text = textOf({
      identity: {
        ...IDENTITY,
        spIdentity: {
          minting: { available: false, detail: 'minting unavailable' },
          assigned: { displayName: 'Finance analyst' },
          executingAs: 'oauth',
          fallbackReason: 'This app cannot mint a token for another service principal. Questions stay on OAuth.',
        },
      },
      failed: false,
    });
    expect(text).not.toContain('Execution Signed-in user · assigned persona Finance analyst');
    expect(text).not.toContain('Execution Assigned persona · Finance analyst');
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

  it('renders OAuth alone for Authentication and OAuth plus the user drilldown for signed-in execution', () => {
    const markup = renderToStaticMarkup(<IdentityCard read={SIGNED_IN} />);
    const authentication = markup.split('>Authentication</p>')[1]?.split('>Verification</p>')[0] ?? '';
    const execution = markup.split('>Execution</p>')[1]?.split('</section>')[0] ?? '';

    expect(markup.match(/data-testid="oauth-badge"/g)).toHaveLength(2);
    expect(authentication.match(/data-testid="oauth-badge"/g)).toHaveLength(1);
    expect(execution.match(/data-testid="oauth-badge"/g)).toHaveLength(1);
    expect(execution).toContain('aria-label="Open user overview for someone"');
    expect(execution).toContain('class="identity-chip identity-chip--compact"');
    expect(markup).not.toContain('Databricks Apps OAuth');
    expect(markup).not.toContain('Local development fallback');
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
  it('names app execution while keeping the live application identity separate', () => {
    const read: DeploymentIdentity = {
      identity: { ...IDENTITY, analyticalExecution: { mode: 'app_service_principal', verified: true } },
      failed: false,
    };
    const text = textOf(read);
    const markup = renderToStaticMarkup(<IdentityCard read={read} />);
    expect(text).toContain('Execution Astrolabe app');
    expect(text).toContain('Service principal');
    expect(text).not.toMatch(/client secret|bearer|token/i);
    expect(markup.match(/data-testid="oauth-badge"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Open user overview for someone"');
  });

  it('names an assigned persona without returning its internal ids', () => {
    const read: DeploymentIdentity = {
      identity: {
        ...IDENTITY,
        analyticalExecution: { mode: 'assigned_service_principal', verified: true },
        spIdentity: {
          minting: { available: true, detail: 'ok' },
          assigned: { displayName: 'Finance analyst' },
          executingAs: 'service_principal',
          fallbackReason: null,
        },
      },
      failed: false,
    };
    const text = textOf(read);
    const markup = renderToStaticMarkup(<IdentityCard read={read} />);
    expect(text).toContain('Execution Assigned persona · Finance analyst');
    expect(text).not.toMatch(/persona-1|client secret|secret scope|secret key/i);
    expect(markup.match(/data-testid="oauth-badge"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Open user overview for someone"');
  });
});
