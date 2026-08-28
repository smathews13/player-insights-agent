import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SpIdentityAdminPayload } from '../../shared/sp-identity';
import type { RosterPayload } from '../../shared/user-roster-contract';
import { SettingsPage } from './SettingsPage';
import { SpIdentityEditor } from './SpIdentityPanel';
import { RosterRows } from './UserRoleEditor';

const FEATURES = { benchmarkLab: true, egressControls: true, costEstimates: false };
const SECTIONS = ['runtime', 'appearance', 'experimental', 'identity', 'environment', 'egress'] as const;
const CSS = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
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
          spIdentityEnabled={true}
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
    expect(PAGE).toContain("active === 'experimental' && showsBenchmarkLab(features)");
    expect(PAGE).toContain('form={form}');
    expect(PAGE).toContain('disabled={saveDisabled}');
    expect(PAGE).toContain('onClick={close}');
    expect(RUNTIME).toContain('adoptRuntimeEntityStyles(savedSettings.current)');
    expect(EGRESS).toContain("onSaveState({ kind: 'saved' })");
  });

  it('labels dark mode as On or Off', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage initialSection="appearance" features={FEATURES} spIdentityEnabled={true} />
    );
    expect(markup).toContain('>On</span>');
    expect(markup).not.toContain('>Dark</span>');
    expect(markup).not.toContain('>Light</span>');
    expect(RUNTIME).toContain('onLabel="On"');
    expect(RUNTIME).toContain('offLabel="Off"');
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
    enabled: true,
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
        <SpIdentityEditor enabled={true} payload={spRoles} busy={false} error={null} onRename={() => {}} />
      </div>
    );
    expect(markup.match(/<table/g) ?? []).toHaveLength(2);
    for (const label of ['Human roles and admins', 'SP Personas', 'Email', 'Human role', 'Persona']) {
      expect(markup).toContain(label);
    }
    expect(markup.indexOf('Human roles and admins')).toBeLessThan(markup.indexOf('SP Personas'));
    expect(markup).not.toContain('SP user roles');
    expect(markup.match(/<th scope="col">Email<\/th>/g) ?? []).toHaveLength(1);
    expect(markup).toContain('settings-table-frame');
  });

  it('shows role names and assignments without credential fields or values', () => {
    const markup = renderToStaticMarkup(
      <SpIdentityEditor enabled={true} payload={spRoles} busy={false} error={null} onRename={() => {}} />
    );
    expect(markup).toContain('Persona name for Finance reader');
    expect(markup).toContain('>Rename</button>');
    expect(markup).not.toMatch(/application \/? client id|secret scope|secret key|secret reference/i);
    expect(markup).not.toContain(spRoles.personas[0].clientId);
    expect(markup).not.toContain(spRoles.personas[0].secretScope);
    expect(markup).not.toContain(spRoles.personas[0].secretKey);
  });

  it('prevents email and setter cells from wrapping character-by-character', () => {
    expect(CSS).toMatch(/\.admin-row-address \{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
    expect(CSS).toMatch(/\.roster-set-by > \* \{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
    expect(CSS).toMatch(/\.settings-data-table \{[^}]*table-layout:\s*fixed/s);
  });

  it('pins every row control to the same 30px geometry', () => {
    expect(CSS).toMatch(/\.roster-control \{[^}]*height:\s*30px[^}]*align-items:\s*center/s);
    expect(CSS).toMatch(/\.roles-table td \{[^}]*height:\s*47px/s);
    expect(CSS).toMatch(/\.roster-role-status \{[^}]*min-height:\s*30px[^}]*align-items:\s*center/s);
    expect(CSS).toMatch(/\.sp-personas-table td \{[^}]*height:\s*47px/s);
    expect(CSS).toMatch(/\.sp-personas-table \[data-slot='input'\] \{[^}]*height:\s*30px/s);
  });
});
