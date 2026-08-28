import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SpIdentityEditor } from './SpIdentityPanel';
import { isSpPersonaDefinitionComplete } from './sp-persona-definition';
import { EMPTY_SP_IDENTITY, UNASSIGNED_PERSONA } from './identity-settings-api';
import { SP_IDENTITY_MINTING_UNAVAILABLE, type SpIdentityAdminPayload } from '../../shared/sp-identity';

const PAYLOAD: SpIdentityAdminPayload = {
  ...EMPTY_SP_IDENTITY,
  minting: {
    available: true,
    detail: 'This app can read a named secret and exchange it for a token.',
  },
  personas: [
    {
      id: 'persona-1',
      displayName: 'Finance analyst',
      clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
      secretScope: 'astrolabe',
      secretKey: 'finance-sp',
      updatedAt: '2026-08-26T00:00:00.000Z',
      updatedBy: 'admin@example.com',
    },
  ],
  roster: [
    { email: 'ada@example.com', role: 'admin', personaId: 'persona-1' },
    { email: 'ben@example.com', role: 'consumer', personaId: null },
  ],
};

function render(enabled: boolean, payload: SpIdentityAdminPayload = PAYLOAD): string {
  return renderToStaticMarkup(
    <SpIdentityEditor enabled={enabled} payload={payload} busy={false} error={null} onRename={() => {}} />
  );
}

describe('Settings → Identity', () => {
  it('grays the pane until the experimental switch is on', () => {
    const off = render(false);
    expect(off).toContain('data-testid="sp-identity-pane"');
    expect(off).toContain('disabled=""');
    expect(off).toContain('Turn SP identities on under Experimental');
  });

  it('lets an administrator name an existing SP role without exposing credentials', () => {
    const markup = render(true);
    expect(markup).toContain('SP Personas');
    expect(markup).toContain('aria-label="Persona name for Finance analyst"');
    expect(markup).toContain('>Rename</button>');
    expect(markup).not.toMatch(/application \/? client id/i);
    expect(markup).not.toMatch(/secret scope|secret key|secret reference/i);
    expect(markup).not.toContain(PAYLOAD.personas[0].clientId);
    expect(markup).not.toContain(PAYLOAD.personas[0].secretScope);
    expect(markup).not.toContain(PAYLOAD.personas[0].secretKey);
  });

  it('creates only credential-free configurations and keeps connected-identity changes separate', () => {
    const source = readFileSync(new URL('identity-settings-api.ts', import.meta.url), 'utf8');
    expect(source).toContain("method: 'PATCH'");
    expect(source).toContain('body: JSON.stringify({ displayName })');
    expect(source).toContain("'/api/admin/sp-identity/persona-definitions'");
    expect(source).toContain("method: 'POST'");
    expect(source).toContain("method: 'DELETE'");
    expect(source).toContain('never deletes the stored identity');
    expect(source).not.toMatch(/clientSecret|client_secret|secretValue/);
  });

  it('renders a proper persona rename table and no duplicate person-assignment table', () => {
    const markup = render(true);
    expect(markup.match(/<table/g) ?? []).toHaveLength(1);
    expect(markup).toContain('<th scope="col">Persona</th>');
    expect(markup).toContain('<th scope="col">Actions</th>');
    expect(markup).not.toContain('<th scope="col">Email</th>');
    expect(markup).not.toContain('ada@example.com');
    expect(markup).not.toContain('SP user roles');
    expect(UNASSIGNED_PERSONA).toBe('oauth');
    expect(UNASSIGNED_PERSONA).not.toBe('');
  });

  it('says so when this app cannot mint a token for another service principal', () => {
    const markup = render(true, {
      ...PAYLOAD,
      minting: {
        available: false,
        detail: 'This app has no service-principal credentials of its own.',
      },
    });
    expect(markup).toContain('This app has no service-principal credentials of its own.');
  });

  it('does not lecture about minting, empty personas, or who assigns', () => {
    const empty = render(true, {
      ...EMPTY_SP_IDENTITY,
      minting: { available: false, detail: SP_IDENTITY_MINTING_UNAVAILABLE },
      roster: PAYLOAD.roster,
    });
    expect(empty).not.toContain(SP_IDENTITY_MINTING_UNAVAILABLE);
    expect(empty).toContain('No SP persona configurations yet.');
    expect(empty).not.toContain('Who runs as which persona');
    expect(empty).not.toContain('Administrators assign this');
    expect(empty).not.toContain('People using the app do not pick a persona on Ask');
    expect(empty).not.toContain('never the secret itself');
    expect(empty).toContain('sp-personas-table');
  });

  it('renders a truthful credential-free generator with editable Databricks permissions', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        enabled={true}
        payload={{ ...PAYLOAD, personaDefinitions: [] }}
        busy={false}
        error={null}
        onRename={() => {}}
        onCreateDefinition={() => true}
        onUpdateDefinition={() => true}
        onDeleteDefinition={() => {}}
      />
    );
    expect(markup).toContain('Define a persona');
    expect(markup).toContain('aria-label="Persona name"');
    expect(markup).toContain('aria-label="Persona purpose"');
    expect(markup).toContain('Governed tables — USE CATALOG, USE SCHEMA, SELECT');
    expect(markup).toContain('SQL warehouse — CAN USE');
    expect(markup).toContain('Genie space — CAN RUN');
    expect(markup).toContain('Vector Search index — CAN SELECT');
    expect(markup).toContain('Model serving endpoint — CAN QUERY');
    expect(markup).toContain('>Generate SP</button>');
    expect(markup).toContain('cannot create an account service principal or apply these grants');
    expect(markup).not.toMatch(/client id|secret scope|secret key/i);
  });

  it('reports a completed definition write without implying that an account SP was provisioned', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        enabled={true}
        payload={{ ...PAYLOAD, personaDefinitions: [] }}
        busy={false}
        error={null}
        success="SP persona configuration saved."
        onRename={() => {}}
      />
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('SP persona configuration saved.');
    expect(markup).not.toMatch(/service principal (created|provisioned)/i);
  });

  it('enables generation only for a named persona with complete unique permissions', () => {
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Finance',
        description: '',
        capabilities: ['SQL warehouse — CAN USE'],
      })
    ).toBe(true);
    expect(isSpPersonaDefinitionComplete({ displayName: '', description: '', capabilities: ['CAN USE'] })).toBe(false);
    expect(isSpPersonaDefinitionComplete({ displayName: 'Finance', description: '', capabilities: [] })).toBe(false);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Finance',
        description: '',
        capabilities: ['CAN USE', 'can use'],
      })
    ).toBe(false);
  });

  it('lists generated configurations as operator-required and editable', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        enabled={true}
        payload={{
          ...PAYLOAD,
          personaDefinitions: [
            {
              id: 'definition-1',
              displayName: 'Finance reporting',
              description: 'Read-only reporting',
              capabilities: ['SQL warehouse — CAN USE', 'Governed tables — USE CATALOG, USE SCHEMA, SELECT'],
              updatedAt: '2026-08-28T00:00:00.000Z',
              updatedBy: 'owner@example.invalid',
            },
          ],
        }}
        busy={false}
        error={null}
        onRename={() => {}}
        onCreateDefinition={() => true}
        onUpdateDefinition={() => true}
        onDeleteDefinition={() => {}}
      />
    );
    expect(markup).toContain('Finance reporting');
    expect(markup).toContain('Read-only reporting');
    expect(markup).toContain('2 selected');
    expect(markup).toContain('Configuration only');
    expect(markup).toContain('aria-label="Edit Finance reporting"');
    expect(markup).toContain('aria-label="Remove Finance reporting"');
  });
});

describe('Ask has no persona picker', () => {
  it('does not import the identity pane or offer a persona control', () => {
    const home = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
    expect(home).not.toContain('SpIdentity');
    expect(home).not.toContain('sp-identity');
    expect(home).not.toContain('UNASSIGNED_PERSONA');
    expect(home).not.toMatch(/aria-label=\{?['"]Persona/);
  });
});
