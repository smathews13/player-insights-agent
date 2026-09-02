import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpIdentityAdminPayload } from '../../shared/sp-identity';
import type { RosterPayload } from '../../shared/user-roster-contract';
import { SettingsPage } from './SettingsPage';
import { SpIdentityEditor } from './SpIdentityPanel';
import { RosterRows } from './UserRoleEditor';

const FEATURES = { benchmarkLab: true, egressControls: true, forecasting: false, notebookAgentSync: false };
const SECTIONS = ['runtime', 'appearance', 'experimental', 'identity', 'environment', 'egress'] as const;
const CSS = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8');
const RUNTIME = readFileSync(new URL('./RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const EGRESS = readFileSync(new URL('./EgressPanel.tsx', import.meta.url), 'utf8');

describe('the demo workspace Settings shell feedback', () => {
  it('shows the exact consolidated navigation and one persistent Cancel + Save footer on every tab', () => {
    for (const active of SECTIONS) {
      const markup = renderToStaticMarkup(
        <SettingsPage
          initialSection={active}
          features={FEATURES}
          role={{ state: 'super_admin', addedAdminsReadable: true }}
        />
      );
      for (const label of ['Identity', 'Runtime', 'Environment', 'Appearance', 'Egress controls', 'Experimental']) {
        expect(markup).toContain(`>${label}</button>`);
      }
      expect(markup).not.toContain('>Roles</button>');
      expect(markup.match(/>Cancel<\/button>/g) ?? []).toHaveLength(1);
      expect(markup.match(/>Save<\/button>/g) ?? []).toHaveLength(1);
      expect(markup.indexOf('settings-modal-footer')).toBeGreaterThan(markup.indexOf('settings-modal-content'));
    }
  });

  it('pins the footer while only the content pane scrolls', () => {
    expect(CSS).toMatch(
      /\.settings-page\.settings-modal \{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto[^}]*overflow:\s*hidden/s
    );
    expect(CSS).toMatch(/\.settings-modal-content \{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    expect(CSS).toMatch(/\.settings-modal-footer \{[^}]*border-top:\s*1px solid var\(--border\)/s);
  });

  it('keeps Save connected to the active form and Cancel connected to modal dismissal', () => {
    expect(PAGE).toContain("active === 'runtime' || active === 'appearance'");
    expect(PAGE).toContain("active === 'egress'");
    expect(PAGE).toContain("active === 'experimental'");
    expect(PAGE).toContain('form={form}');
    expect(PAGE).toContain('disabled={saveDisabled}');
    expect(PAGE).toContain('onClick={requestClose}');
    expect(RUNTIME).toContain('adoptRuntimeEntityStyles(saved.settings)');
    expect(EGRESS).toContain("onSaveState({ kind: 'saved', count: changedCount })");
  });

  it('labels dark mode as On or Off', () => {
    const markup = renderToStaticMarkup(<SettingsPage initialSection="appearance" features={FEATURES} />);
    expect(markup).toContain('>On</span>');
    expect(markup).not.toContain('>Dark</span>');
    expect(markup).not.toContain('>Light</span>');
    expect(RUNTIME).not.toContain('onLabel=');
    expect(RUNTIME).not.toContain('offLabel=');
  });
});

describe('the demo workspace Identity feedback', () => {
  const humanRoles: RosterPayload = {
    entries: [
      {
        email: 'long.identity.owner@example.invalid',
        role: 'super_admin',
        seedFloor: 'super_admin',
        setBy: '',
        setAt: '',
        isYou: true,
        assignable: [],
        canRemove: false,
      },
    ],
    storedRosterReadable: true,
    roleColumnPresent: true,
    pendingSchemaStatement: '',
    superAdminCount: 1,
    recoveryStatement: '',
  };
  const spRoles: SpIdentityAdminPayload = {
    minting: { available: true, detail: '' },
    personas: [
      {
        id: 'existing-backend-identity',
        displayName: 'Finance reader',
        clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
        secretScope: 'internal-scope',
        secretKey: 'internal-key',
        updatedAt: '2026-08-28T00:00:00.000Z',
        updatedBy: 'owner@example.invalid',
      },
    ],
    assignments: [],
    roster: [{ email: 'long.identity.owner@example.invalid', role: 'super_admin', personaId: null }],
  };

  it('renders exactly two proper role tables with shared structure', () => {
    const markup = renderToStaticMarkup(
      <div>
        <h4>Human roles and admins</h4>
        <RosterRows
          payload={humanRoles}
          busy={false}
          onChange={() => {}}
          onRemove={() => {}}
          personas={spRoles.personas}
          personaByEmail={new Map([['long.identity.owner@example.invalid', 'existing-backend-identity']])}
          personaDisabled={false}
          showPersona={true}
          onPersonaChange={() => {}}
        />
        <SpIdentityEditor payload={spRoles} busy={false} readError={null} onRename={() => {}} />
      </div>
    );
    expect(markup.match(/<table/g) ?? []).toHaveLength(2);
    for (const label of ['Human roles and admins', 'SP Personas', 'Email', 'User role', 'Persona']) {
      expect(markup).toContain(label);
    }
    expect(markup.indexOf('Human roles and admins')).toBeLessThan(markup.indexOf('SP Personas'));
    expect(markup).not.toContain('SP user roles');
    expect(markup.match(/<th scope="col">Email<\/th>/g) ?? []).toHaveLength(1);
    expect(markup).toContain('settings-table-frame');
  });

  it('shows role names and assignments without credential fields or values', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor payload={spRoles} busy={false} readError={null} onRename={() => {}} />
    );
    expect(markup).toContain('Persona name for Finance reader');
    expect(markup).toContain('>Rename</button>');
    expect(markup).not.toMatch(/application \/? client id|secret scope|secret key|secret reference/i);
    expect(markup).not.toContain(spRoles.personas[0].clientId);
    expect(markup).not.toContain(spRoles.personas[0].secretScope);
    expect(markup).not.toContain(spRoles.personas[0].secretKey);
  });

  it('keeps full emails on one readable line with tooltip and copy support', () => {
    expect(CSS).toMatch(/\.admin-row-address \{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
    expect(CSS).toMatch(/\.admin-row-email \{[^}]*font-size:\s*11px/s);
    expect(CSS).toMatch(/\.roster-email-copy \{[^}]*width:\s*26px[^}]*height:\s*26px/s);
    expect(CSS).toMatch(/\.roster-set-by > \* \{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
    expect(CSS).toMatch(/\.settings-data-table \{[^}]*table-layout:\s*fixed/s);
  });

  it('fits the editable identity table in the full modal and moves navigation above narrow panes', () => {
    expect(CSS).toMatch(
      /\.settings-page\.settings-modal \{[^}]*width:\s*min\(1080px,\s*calc\(100vw - 32px\)\)[^}]*max-width:\s*1080px/s
    );
    expect(CSS).toMatch(/\.roles-table \{[^}]*min-width:\s*800px/s);
    expect(CSS).toMatch(/\.roles-table--editable \.roster-action-column \{[^}]*width:\s*112px/s);
    expect(CSS).toMatch(/\.roster-role-select \{[^}]*max-width:\s*7rem/s);
    expect(CSS).toMatch(/\.roster-persona-select \{[^}]*max-width:\s*9rem/s);
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*\.settings-modal-body \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
    );
  });

  it('shows Owner for the immutable super admin with no persona or action control', () => {
    const markup = renderToStaticMarkup(
      <RosterRows
        payload={humanRoles}
        busy={false}
        onChange={() => {}}
        onRemove={() => {}}
        personas={spRoles.personas}
        personaByEmail={new Map([['long.identity.owner@example.invalid', null]])}
        personaDisabled={false}
        showPersona={true}
        onPersonaChange={() => {}}
      />
    );
    expect(markup).toContain('roster-owner-badge">Owner</span>');
    expect(markup).toContain('data-role-state="super_admin"');
    expect(markup).not.toContain('Persona for long.identity.owner@example.invalid');
    expect(markup).not.toContain('lucide-lock');
    expect(markup).not.toContain('roster-row-lock');
  });

  it('keeps an ordinary admin role and persona editable', () => {
    const admin = {
      ...humanRoles,
      entries: [
        {
          ...humanRoles.entries[0],
          role: 'admin' as const,
          seedFloor: 'consumer' as const,
          assignable: ['consumer' as const],
          canRemove: true,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <RosterRows
        payload={admin}
        busy={false}
        onChange={() => {}}
        onRemove={() => {}}
        personas={spRoles.personas}
        personaByEmail={new Map([['long.identity.owner@example.invalid', null]])}
        personaDisabled={false}
        showPersona={true}
        onPersonaChange={() => {}}
      />
    );
    expect(markup).toContain('User role for long.identity.owner@example.invalid');
    expect(markup).toContain('Persona for long.identity.owner@example.invalid: No persona');
    expect(markup).toContain('data-variant="destructive"');
  });

  it('renders a configured organization icon before the full email address', () => {
    const email = 'avery.long.address@studio.example.org';
    const markup = renderToStaticMarkup(
      <RosterRows
        payload={{
          ...humanRoles,
          entries: [{ ...humanRoles.entries[0], email }],
          organizations: [{ domain: 'example.org', name: 'Example Studio', monogram: 'ES' }],
        }}
        busy={false}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );
    expect(markup).toContain('aria-label="Organization: Example Studio"');
    expect(markup).toContain('roster-organization-mark');
    expect(markup).toContain(`<td class="roster-email" title="${email}">`);
    expect(markup).toContain(`>${email}</span>`);
    expect(markup).toContain(`aria-label="Copy email ${email}"`);
    expect(markup.indexOf('roster-organization-mark')).toBeLessThan(markup.indexOf('admin-row-address'));
  });

  it('keeps persona name and purpose controls compact and exactly equal height', () => {
    expect(CSS).toMatch(/\.sp-persona-fields \.runtime-field \{[^}]*grid-template-rows:\s*auto 44px/s);
    expect(CSS).toMatch(/\.sp-persona-fields \[data-slot='input'\] \{[^}]*height:\s*44px/s);
    expect(CSS).toMatch(
      /\.sp-persona-fields \[data-slot='textarea'\] \{[^}]*height:\s*44px[^}]*max-height:\s*44px[^}]*resize:\s*none/s
    );
  });

  it('pins every row control to the same 30px geometry', () => {
    expect(CSS).toMatch(/\.roster-control \{[^}]*height:\s*30px[^}]*align-items:\s*center/s);
    expect(CSS).toMatch(/\.roles-table td \{[^}]*height:\s*47px/s);
    expect(CSS).toMatch(/\.roster-role-status \{[^}]*min-height:\s*30px[^}]*align-items:\s*center/s);
    expect(CSS).toMatch(/\.sp-personas-table td \{[^}]*height:\s*47px/s);
    expect(CSS).toMatch(/\.sp-personas-table \[data-slot='input'\] \{[^}]*height:\s*30px/s);
  });

  it('removes the roster count narrative and prefixes from user-role selectors', () => {
    const markup = renderToStaticMarkup(
      <RosterRows
        payload={humanRoles}
        busy={false}
        onChange={() => {}}
        onRemove={() => {}}
        personas={spRoles.personas}
        showPersona={true}
      />
    );
    expect(markup).not.toContain('people on the roster');
    expect(markup).not.toContain('administrator, 1 super');
    expect(markup).toContain('<th scope="col">User role</th>');
    expect(markup).not.toContain('Human role');
  });
});
