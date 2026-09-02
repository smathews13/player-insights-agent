import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ExampleProfiles, ResourceBrowser, SpIdentityEditor } from './SpIdentityPanel';
import {
  confirmDeletePermissionsDraft,
  DELETE_PERMISSIONS_CONFIRMATION,
  isSpPersonaDefinitionComplete,
} from './sp-persona-definition';
import { EMPTY_SP_IDENTITY, UNASSIGNED_PERSONA } from './identity-settings-api';
import { SP_IDENTITY_MINTING_UNAVAILABLE, type SpIdentityAdminPayload } from '../../shared/sp-identity';
import { DEFAULT_SP_PERSONA_TEMPLATES } from '../../shared/default-sp-persona-templates';
import { failSpIdentityRead, finishSpIdentityRead, INITIAL_SP_IDENTITY_READ_STATE } from './sp-identity-read-state';
import { AppSelect } from './AppSelect';

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
  grantResourceDiscovery: {
    status: 'ready',
    detail: '',
    resources: [
      { type: 'TABLE', id: 'main.games.players', label: 'Players', source: 'declared' },
      { type: 'SQL_WAREHOUSE', id: 'abc123', label: 'SQL warehouse', source: 'configured' },
    ],
  },
};

const TABLE_GRANT = {
  resourceType: 'TABLE' as const,
  resource: 'main.games.players',
  action: 'READ' as const,
  privilege: 'SELECT',
};

const DEFINITION = {
  id: 'definition-1',
  displayName: 'Finance reporting',
  description: 'Read-only reporting',
  capabilities: ['Table or view main.games.players — SELECT'],
  grants: [TABLE_GRANT],
  legacyCapabilities: [],
  updatedAt: '2026-08-28T00:00:00.000Z',
  updatedBy: 'owner@example.invalid',
};

function render(enabled: boolean, payload: SpIdentityAdminPayload = PAYLOAD): string {
  void enabled;
  return renderToStaticMarkup(
    <SpIdentityEditor payload={payload} busy={false} readError={null} onRename={() => {}} />
  );
}

describe('Settings → Identity', () => {
  it('keeps mappings available for both legacy true and false states', () => {
    for (const legacy of [false, true]) {
      const markup = render(legacy);
      expect(markup).toContain('data-testid="sp-identity-pane"');
      expect(markup).toContain('SP Personas');
      expect(markup).not.toContain('Turn SP identities on under Experimental');
      expect(markup).not.toMatch(/<fieldset[^>]*disabled/);
    }
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

  it('renders the persona silhouette without an empty table header', () => {
    const empty = render(true, {
      ...EMPTY_SP_IDENTITY,
      minting: { available: false, detail: SP_IDENTITY_MINTING_UNAVAILABLE },
      roster: PAYLOAD.roster,
    });
    expect(empty).not.toContain(SP_IDENTITY_MINTING_UNAVAILABLE);
    expect(empty).toContain('No SP persona configurations yet.');
    expect(empty).toContain('lucide-user-round');
    expect(empty).not.toContain('<th scope="col">Persona</th>');
    expect(empty).not.toContain('<th scope="col">Actions</th>');
    expect(empty).not.toContain('Who runs as which persona');
    expect(empty).not.toContain('Administrators assign this');
    expect(empty).not.toContain('People using the app do not pick a persona on Ask');
    expect(empty).not.toContain('never the secret itself');
    expect(empty).not.toContain('sp-personas-table');
  });

  it('renders a clean permissions builder and a truthful external SP link', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        payload={{ ...PAYLOAD, personaDefinitions: [] }}
        busy={false}
        readError={null}
        onRename={() => {}}
        onCreateDefinition={() => true}
        onUpdateDefinition={() => true}
        onDeleteDefinition={() => {}}
      />
    );
    expect(markup).toContain('Define a persona');
    expect(markup).toContain('aria-label="Persona name"');
    expect(markup).toContain('aria-label="Persona purpose"');
    expect(markup).not.toContain('Resource type for permission 1');
    expect(markup).not.toContain('Operator-ready grant plan');
    expect(markup).not.toContain('catalog.schema.table');
    expect(markup).not.toContain('choose a resource');
    expect(markup).not.toContain('Databricks object — permission');
    expect(markup).toContain('>Save permissions</button>');
    expect(markup).not.toMatch(/Suggest permissions|Suggesting|Try again|permission suggestions/i);
    expect(markup).toContain('Open Account Console');
    expect(markup).not.toContain('Generate SP');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('data-account-console-link="true"');
    expect(markup).toContain('lucide-external-link');
    expect(markup).not.toMatch(/service principal (created|provisioned)/i);
    expect(markup).not.toMatch(/client id|secret scope|secret key/i);
  });

  it('renders review-only example profile cards with capabilities, counts, and an explicit staging action', () => {
    const template = {
      id: 'fictional-analyst',
      displayName: 'Fictional Analyst',
      roleSummary: 'Read-only governed reporting.',
      purpose: 'Analyze approved data.',
      duties: ['Run approved reports.'],
      dataBoundaries: ['Configured resources only.'],
      exclusions: ['No writes or management.'],
      keyCapabilities: ['Governed SQL', 'Approved Genie'],
      variants: [
        {
          id: 'least-privilege',
          label: 'least privilege',
          description: 'Read only.',
          leastPrivilege: true,
          grants: [
            {
              resourceType: 'SQL_WAREHOUSE' as const,
              action: 'USE' as const,
              privilege: 'CAN USE',
              selector: { match: 'single' as const, choiceLabel: 'Reporting warehouse' },
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <ExampleProfiles
        templates={[template]}
        warning={null}
        resources={PAYLOAD.grantResourceDiscovery?.resources ?? []}
        busy={false}
        onUse={() => {}}
      />
    );
    expect(markup).toContain('Example profiles');
    expect(markup).toContain('Fictional Analyst');
    expect(markup).toContain('Governed SQL');
    expect(markup).toContain('1 grant intents');
    expect(markup).toContain('Use profile');
    expect(markup).toContain('Nothing is saved, created, or granted');
    expect(markup).toContain('Review duties, boundaries, and exclusions');
  });

  it('keeps applied examples editable, incomplete when unresolved, and cancellable before save', () => {
    const source = readFileSync(new URL('SpIdentityPanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain('resolveSpPersonaTemplateVariant');
    expect(source).toContain('setDraft({');
    expect(source).toContain('Delete permissions');
    expect(source).toContain('Choose {activeUnresolved.length} required resource(s) before saving');
    expect(source).toContain('Open Browse in this row to choose or enter an identifier.');
    expect(source).toContain('templateOverflow.length === 0');
    expect(source).toContain('duplicateSpPersonaGrantRow');
    expect(source).not.toMatch(/function useTemplate[\s\S]{0,800}setEditingId\(null\)/);
    expect(source).not.toMatch(/useTemplate[\s\S]{0,1200}(?:onCreate|createSpPersonaDefinition)\(/);
  });

  it('disables profile replacement with an explicit explanation while a draft is active', () => {
    const template = {
      id: 'fictional-analyst',
      displayName: 'Fictional Analyst',
      roleSummary: 'Read-only governed reporting.',
      purpose: 'Analyze approved data.',
      duties: ['Run approved reports.'],
      dataBoundaries: ['Configured resources only.'],
      exclusions: ['No writes or management.'],
      keyCapabilities: ['Governed SQL'],
      variants: [
        {
          id: 'least-privilege',
          label: 'least privilege',
          description: 'Read only.',
          leastPrivilege: true,
          grants: [
            {
              resourceType: 'SQL_WAREHOUSE' as const,
              action: 'USE' as const,
              privilege: 'CAN USE',
              selector: { match: 'single' as const, choiceLabel: 'Reporting warehouse' },
            },
          ],
        },
      ],
    };
    const existingEdit = renderToStaticMarkup(
      <ExampleProfiles
        templates={[template]}
        warning={null}
        resources={PAYLOAD.grantResourceDiscovery?.resources ?? []}
        busy={false}
        useBlockedReason="Finish or cancel the current edit first."
        onUse={() => {}}
      />
    );
    expect(existingEdit).toContain('Finish or cancel the current edit first.');
    expect(existingEdit).toContain('disabled=""');

    const dirtyCreate = renderToStaticMarkup(
      <ExampleProfiles
        templates={[template]}
        warning={null}
        resources={PAYLOAD.grantResourceDiscovery?.resources ?? []}
        busy={false}
        useBlockedReason="Delete the current permissions draft before using an example profile."
        onUse={() => {}}
      />
    );
    expect(dirtyCreate).toContain('Delete the current permissions draft before using an example profile.');

    const cleanCreate = renderToStaticMarkup(
      <ExampleProfiles
        templates={[template]}
        warning={null}
        resources={PAYLOAD.grantResourceDiscovery?.resources ?? []}
        busy={false}
        onUse={() => {}}
      />
    );
    expect(cleanCreate).not.toContain('disabled=""');
  });

  it('browses only resources valid for the selected row and keeps manual entry secondary', () => {
    const markup = renderToStaticMarkup(
      <ResourceBrowser
        grant={{ resourceType: 'TABLE', resource: '', action: 'READ', privilege: 'SELECT' }}
        resources={PAYLOAD.grantResourceDiscovery?.resources ?? []}
        discovery={PAYLOAD.grantResourceDiscovery}
        loading={false}
        busy={false}
        index={0}
        onPick={() => {}}
        onManual={() => {}}
        onRefresh={() => {}}
      />
    );
    expect(markup).toContain('Browse configured resources for permission 1');
    expect(markup).toContain('Table');
    expect(markup).not.toContain('SQL warehouse');
    expect(markup).toContain('main.games.players');
    expect(markup).toContain('Enter identifier');
    expect(markup).not.toContain('Resource identifier for permission 1');
  });

  it('explains optional metadata search in plain language on every default profile', () => {
    const markup = renderToStaticMarkup(
      <ExampleProfiles
        templates={[...DEFAULT_SP_PERSONA_TEMPLATES]}
        warning={null}
        resources={PAYLOAD.grantResourceDiscovery?.resources ?? []}
        busy={false}
        onUse={() => {}}
      />
    );
    expect(markup.match(/does not grant access to table rows/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(markup.match(/>Add metadata search<\/button>/g) ?? []).toHaveLength(2);
    expect(markup).not.toContain('Use semantic discovery');
  });

  it('confirms destructive draft deletion and never treats it as persisted-persona deletion', () => {
    const declined = vi.fn(() => false);
    const accepted = vi.fn(() => true);
    expect(confirmDeletePermissionsDraft(declined)).toBe(false);
    expect(confirmDeletePermissionsDraft(accepted)).toBe(true);
    expect(declined).toHaveBeenCalledWith(DELETE_PERMISSIONS_CONFIRMATION);
    expect(DELETE_PERMISSIONS_CONFIRMATION).toContain('unsaved permissions draft');
    expect(DELETE_PERMISSIONS_CONFIRMATION).toContain('will be cleared');
  });

  it('renders canonical privileges as code in closed and open select values', () => {
    const markup = renderToStaticMarkup(
      <AppSelect
        label="Permission"
        ariaLabel="Permission"
        value="READ"
        options={[{ value: 'READ', label: 'Read', code: 'SELECT' }]}
        onValueChange={() => {}}
      />
    );
    expect(markup).toContain('<code>SELECT</code>');
    expect(markup).toContain('aria-label="Permission: Read — SELECT"');
    expect(readFileSync(new URL('AppSelect.tsx', import.meta.url), 'utf8')).toContain('<code>{option.code}</code>');
  });

  it('reports a completed definition write without implying that an account SP was provisioned', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        payload={{ ...PAYLOAD, personaDefinitions: [] }}
        busy={false}
        readError={null}
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
        capabilities: ['Table or view main.games.players — SELECT'],
        grants: [TABLE_GRANT],
        legacyCapabilities: [],
      })
    ).toBe(true);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: '',
        description: '',
        capabilities: [],
        grants: [TABLE_GRANT],
        legacyCapabilities: [],
      })
    ).toBe(false);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Finance',
        description: '',
        capabilities: [],
        grants: [],
        legacyCapabilities: [],
      })
    ).toBe(false);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Finance',
        description: '',
        capabilities: [],
        grants: [TABLE_GRANT, { ...TABLE_GRANT }],
        legacyCapabilities: [],
      })
    ).toBe(false);
    expect(
      isSpPersonaDefinitionComplete({
        displayName: 'Finance',
        description: '',
        capabilities: [],
        grants: [{ ...TABLE_GRANT, resource: 'main.games.players; drop table x' }],
        legacyCapabilities: [],
      })
    ).toBe(false);
  });

  it('lists generated configurations as operator-required and editable', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        payload={{
          ...PAYLOAD,
          personaDefinitions: [DEFINITION],
        }}
        busy={false}
        readError={null}
        onRename={() => {}}
        onCreateDefinition={() => true}
        onUpdateDefinition={() => true}
        onDeleteDefinition={() => {}}
      />
    );
    expect(markup).toContain('Finance reporting');
    expect(markup).toContain('Read-only reporting');
    expect(markup).toContain('1 selected');
    expect(markup).toContain('Configuration only');
    expect(markup).toContain('aria-label="Edit Finance reporting"');
    expect(markup).toContain('aria-label="Remove Finance reporting"');
    expect(markup).toContain('<th scope="col">Persona</th>');
    expect(markup).toContain('<th scope="col">Actions</th>');
  });

  it('labels old strings as legacy and keeps them editable for conversion', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        payload={{
          ...PAYLOAD,
          personaDefinitions: [
            {
              id: 'legacy-1',
              displayName: 'Legacy',
              description: '',
              capabilities: ['SQL warehouse — CAN USE'],
              updatedAt: '',
              updatedBy: '',
            },
          ],
        }}
        busy={false}
        readError={null}
        onRename={() => {}}
        onUpdateDefinition={() => true}
      />
    );
    expect(markup).toContain('1 legacy permission');
    expect(markup).toContain('aria-label="Edit Legacy"');
    const source = readFileSync(new URL('SpIdentityPanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Legacy permission — needs conversion');
    expect(source).toContain('Convert');
  });

  it('keeps resource discovery loading, empty, and error states distinct', () => {
    const renderDiscovery = (discovery: SpIdentityAdminPayload['grantResourceDiscovery'], loading = false) =>
      renderToStaticMarkup(
        <ResourceBrowser
          grant={{ resourceType: 'TABLE', resource: '', action: 'READ', privilege: 'SELECT' }}
          resources={discovery?.resources ?? []}
          discovery={discovery}
          loading={loading}
          busy={false}
          index={0}
          onPick={() => {}}
          onManual={() => {}}
          onRefresh={() => {}}
        />
      );
    expect(renderDiscovery(undefined, true)).toContain('Loading configured resources');
    expect(renderDiscovery({ status: 'ready', resources: [], detail: '' })).toContain('No configured resources found');
    const error = renderDiscovery({ status: 'error', resources: [], detail: 'Discovery was refused.' });
    expect(error).toContain('Discovery was refused.');
    expect(error).toContain('Refresh');
  });

  it('keeps last-good definitions visible and actionable after a refresh failure', () => {
    const loaded = finishSpIdentityRead(INITIAL_SP_IDENTITY_READ_STATE, {
      ...PAYLOAD,
      personaDefinitions: [DEFINITION],
    });
    const failed = failSpIdentityRead(loaded, 'The refresh answered 503.');
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        payload={failed.payload}
        busy={false}
        readError={failed.error}
        hasLastGoodPayload={failed.hasLastGoodPayload}
        onRetryRead={() => {}}
        onRename={() => {}}
        onUpdateDefinition={() => true}
        onDeleteDefinition={() => {}}
      />
    );

    expect(failed.payload).toBe(loaded.payload);
    expect(markup).toContain('Finance reporting');
    expect(markup).toContain('shown from the last successful refresh');
    expect(markup).toContain('Retry refresh');
    expect(markup).toMatch(/<button[^>]*aria-label="Edit Finance reporting"[^>]*>/);
    expect(markup).not.toMatch(/<button[^>]*aria-label="Edit Finance reporting"[^>]*disabled/);
    expect(markup).not.toContain('Retry SP personas');
  });

  it('scopes mutation failures beside their action without hiding persisted plans', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        payload={{ ...PAYLOAD, personaDefinitions: [DEFINITION] }}
        busy={false}
        mutationError={{ operation: 'definition-delete', message: 'Delete was refused.' }}
        onRename={() => {}}
        onUpdateDefinition={() => true}
        onDeleteDefinition={() => {}}
      />
    );

    expect(markup).toContain('Finance reporting');
    expect(markup).toContain('Delete was refused.');
    expect(markup).toContain('aria-label="Remove Finance reporting"');
    expect(markup).not.toMatch(/<fieldset class="sp-identity-cluster" disabled/);
  });

  it('shows a full retry state only when the initial read produced no usable payload', () => {
    const failed = failSpIdentityRead(INITIAL_SP_IDENTITY_READ_STATE, 'SP personas could not be read.');
    const markup = renderToStaticMarkup(
      <SpIdentityEditor
        payload={failed.payload}
        busy={false}
        readError={failed.error}
        hasLastGoodPayload={failed.hasLastGoodPayload}
        onRetryRead={() => {}}
        onRename={() => {}}
      />
    );

    expect(markup).toContain('SP personas could not be read.');
    expect(markup).toContain('Retry SP personas');
    expect(markup).not.toContain('Define a persona');
    expect(markup).not.toContain('sp-definitions-table');
  });

  it('clears the read failure and adopts fresh definitions after recovery', () => {
    const failed = failSpIdentityRead(INITIAL_SP_IDENTITY_READ_STATE, 'SP personas could not be read.');
    const recovered = finishSpIdentityRead(failed, { ...PAYLOAD, personaDefinitions: [DEFINITION] });

    expect(recovered.error).toBeNull();
    expect(recovered.loading).toBe(false);
    expect(recovered.hasLastGoodPayload).toBe(true);
    expect(recovered.payload.personaDefinitions).toEqual([DEFINITION]);
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
