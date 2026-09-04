import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RosterPayload } from '../../shared/user-roster-contract';
import { RosterAddRow, RosterRows } from './UserRoleEditor';

const DIALOG = readFileSync(new URL('Dialog.tsx', import.meta.url), 'utf8');
const SELECT = readFileSync(new URL('AppSelect.tsx', import.meta.url), 'utf8');
const EDITOR = readFileSync(new URL('UserRoleEditor.tsx', import.meta.url), 'utf8');
const BASE = readFileSync(new URL('styles/base.css', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('styles/responsive-settings.css', import.meta.url), 'utf8');
const DENSITY = readFileSync(new URL('styles/density-settings.css', import.meta.url), 'utf8');

function bodyFor(css: string, selector: string): string {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return [...declarations.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((candidate) => candidate.trim() === selector))
    .map((match) => match[2])
    .join('\n');
}

function roster(entries: RosterPayload['entries']): RosterPayload {
  return {
    entries,
    storedRosterReadable: true,
    roleColumnPresent: true,
    pendingSchemaStatement: '',
    superAdminCount: entries.filter((entry) => entry.role === 'super_admin').length,
    recoveryStatement: '',
  };
}

describe('Settings Identity controls', () => {
  it('keeps select portals inside the non-inert dialog branch above the modal', () => {
    expect(DIALOG).toContain('<PortalContainerProvider container={portalContainer}>');
    expect(DIALOG).toContain('if (isDialogFloatingPortal(event.target)) return');
    expect(DIALOG).toContain('[data-radix-popper-content-wrapper]');
    expect(SELECT).toContain('<PopoverContent');
    expect(SELECT).toContain('onValueChange(option.value)');
    expect(BASE).toMatch(/\[data-radix-popper-content-wrapper\]\s*\{[^}]*z-index:\s*var\(--ast-layer-menu\)/s);
    expect(BASE).toMatch(/\.app-menu-content\s*\{[^}]*background:\s*var\(--background\)/s);
  });

  it('renders editable role/persona selects for other roster users and locks only the canonical owner row', () => {
    const payload = roster([
      {
        email: 'owner@example.com',
        isDeploymentOwner: true,
        role: 'super_admin',
        seedFloor: 'super_admin',
        setBy: '',
        setAt: '',
        isYou: true,
        assignable: [],
        canRemove: false,
      },
      {
        email: 'admin@example.com',
        isDeploymentOwner: false,
        role: 'admin',
        seedFloor: 'consumer',
        setBy: 'owner@example.com',
        setAt: '',
        isYou: false,
        assignable: ['super_admin', 'consumer'],
        canRemove: true,
      },
    ]);
    const markup = renderToStaticMarkup(
      <RosterRows
        payload={payload}
        busy={false}
        personas={[
          {
            id: 'persona-1',
            displayName: 'Finance',
            clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
            secretScope: 'scope',
            secretKey: 'key',
            updatedAt: '',
            updatedBy: '',
          },
        ]}
        personaByEmail={new Map()}
        personaDisabled={false}
        showPersona
        onPersonaChange={() => {}}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );
    expect(markup).toContain('aria-label="User role for admin@example.com: Admin"');
    expect(markup).toContain('data-role-state="super_admin"');
    expect(markup).not.toContain('aria-live=');
    expect(markup).toContain('aria-label="Persona for admin@example.com: No persona"');
    expect(markup).toContain('>Owner</span>');
    expect(markup).not.toContain('aria-label="Persona for owner@example.com');
  });

  it('renders every locked role cell with the canonical non-live badge', () => {
    const payload = roster(
      (['super_admin', 'admin', 'consumer'] as const).map((role) => ({
        email: `${role}@example.com`,
        isDeploymentOwner: false,
        role,
        seedFloor: role,
        setBy: '',
        setAt: '',
        isYou: false,
        assignable: [],
        canRemove: false,
      }))
    );
    const markup = renderToStaticMarkup(
      <RosterRows payload={payload} busy={false} manageHumanRoles={false} onChange={() => {}} onRemove={() => {}} />
    );
    for (const role of ['super_admin', 'admin', 'consumer']) {
      expect(markup).toContain(`data-role-state="${role}"`);
    }
    expect(markup).not.toContain('roster-role-status');
    expect(markup).not.toContain('aria-live=');
  });

  it('removes the empty add-user helper while preserving the field label and placeholder', () => {
    const markup = renderToStaticMarkup(
      <table>
        <tfoot>
          <RosterAddRow
            draft=""
            role="admin"
            busy={false}
            onDraftChange={() => {}}
            onRoleChange={() => {}}
            onAdd={() => {}}
          />
        </tfoot>
      </table>
    );
    expect(markup).toContain('placeholder="name@example.com"');
    expect(markup).toContain('aria-label="Email address to put on the roster"');
    expect(markup).toMatch(/class="roster-add-feedback"><\/span>/);
    expect(markup).not.toMatch(/class="roster-add-feedback"[^>]*>Enter a work email address\./);
  });

  it('right-aligns equal-size persona definition actions under a fixed Actions column', () => {
    expect(SETTINGS).toMatch(/\.sp-definition-state-column\s*\{[^}]*width:\s*288px/s);
    expect(SETTINGS).toMatch(/\.sp-definition-actions-column\s*\{[^}]*width:\s*76px/s);
    expect(SETTINGS).toMatch(/\.sp-definition-actions\s*\{[^}]*justify-content:\s*flex-end/s);
    expect(SETTINGS).toMatch(
      /\.sp-definition-actions > \[data-slot='button'\]\s*\{[^}]*flex:\s*0 0 30px[^}]*width:\s*30px/s
    );
  });

  it('lets the upper persona actions wrap without shrinking or clipping either control', () => {
    expect(bodyFor(SETTINGS, '.sp-persona-builder-foot')).toMatch(/flex-wrap:\s*wrap/);
    expect(bodyFor(SETTINGS, ".sp-persona-builder-foot [data-slot='button']")).toMatch(
      /min-height:\s*32px[\s\S]*flex:\s*0 0 auto[\s\S]*white-space:\s*nowrap/
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*480px\)[\s\S]*?\.sp-persona-builder-foot \[data-slot='button'\][\s\S]*?width:\s*100%/s
    );
  });

  it('keeps summary state, actions, and setup content in separate normal-flow geometry', () => {
    const status = bodyFor(SETTINGS, '.sp-definition-status');
    const statusActions = bodyFor(SETTINGS, '.sp-definition-status-actions');
    const actions = bodyFor(SETTINGS, '.sp-definition-actions');
    const setupCell = bodyFor(SETTINGS, '.sp-definitions-table .sp-definition-setup-row > td');
    const setupPanel = bodyFor(SETTINGS, '.sp-connection-setup');

    expect(bodyFor(SETTINGS, '.sp-definitions-frame')).toMatch(/overflow:\s*visible/);
    expect(bodyFor(SETTINGS, '.sp-definition-summary-row > td')).toMatch(/height:\s*auto/);
    expect(status).toMatch(/display:\s*grid/);
    expect(bodyFor(SETTINGS, '.sp-definition-status-badges')).toMatch(/flex-wrap:\s*wrap/);
    expect(statusActions).toMatch(/flex-wrap:\s*wrap/);
    expect(statusActions).not.toMatch(/position\s*:|transform\s*:|margin-(?:top|bottom)\s*:\s*-/);
    expect(actions).toMatch(/position:\s*static/);
    expect(actions).not.toMatch(/absolute|transform\s*:|margin-(?:top|bottom)\s*:\s*-/);
    expect(setupCell).toMatch(/height:\s*auto/);
    expect(setupCell).toMatch(/padding:\s*12px 16px 16px/);
    expect(setupCell).toMatch(/overflow:\s*visible/);
    expect(setupPanel).toMatch(/position:\s*static/);
    expect(setupPanel).toMatch(/overflow:\s*visible/);
    expect(setupPanel).not.toMatch(/max-height|absolute|translate|margin-(?:top|bottom)\s*:\s*-/);
  });

  it('switches persona definitions to labeled grid cards before controls can overlap', () => {
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*960px\)[\s\S]*?\.sp-definition-summary-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*960px\)[\s\S]*?\.sp-definition-summary-row > td::before\s*\{[^}]*content:\s*attr\(data-label\)/s
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*960px\)[\s\S]*?\.sp-definition-setup-row\s*\{[^}]*margin:\s*12px 0 16px/s
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width:\s*640px\)[\s\S]*?\.sp-definition-summary-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
    );
  });

  it('keeps compact rows content-sized and high-contrast boundaries visible', () => {
    expect(DENSITY).toMatch(/html\[data-density='compact'\] \.sp-definition-summary-row > td,[\s\S]*?height:\s*auto/s);
    expect(DENSITY).toMatch(
      /html\[data-density='compact'\] \.sp-definition-status-actions \[data-slot='button'\],[\s\S]*?min-height:\s*30px/s
    );
    expect(SETTINGS).toMatch(
      /@media \(forced-colors:\s*active\)[\s\S]*?\.sp-connection-setup,[\s\S]*?border-color:\s*CanvasText/s
    );
  });

  it('keeps credential references aligned without forcing horizontal overflow', () => {
    expect(SETTINGS).toMatch(/\.sp-definitions-table\s*\{[^}]*min-width:\s*0[^}]*table-layout:\s*fixed/s);
    expect(SETTINGS).toMatch(
      /\.sp-connection-fields\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(SETTINGS).toMatch(
      /\.sp-connection-fields \.runtime-field\s*\{[^}]*grid-template-rows:\s*auto minmax\(34px,\s*auto\) auto/s
    );
    expect(SETTINGS).toMatch(/\.sp-connection-form \[data-slot='input'\]\s*\{[^}]*min-height:\s*34px/s);
    expect(SETTINGS).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.sp-connection-fields\s*\{[^}]*minmax\(0, 1fr\)/s);
  });

  it('optimistically selects, applies canonical replies, and rolls back into an alert on failure', () => {
    expect(EDITOR).toContain('row.email === entry.email ? { ...row, role } : row');
    expect(EDITOR).toContain('row.email === email ? { ...row, personaId } : row');
    expect(EDITOR).toContain('apply: setPayload');
    expect(EDITOR).toContain('apply: setSpPayload');
    expect(EDITOR).toContain('setPayload(before)');
    expect(EDITOR).toContain('setSpPayload(before)');
    expect(EDITOR).toContain('setWriteError(message)');
    expect(EDITOR).toContain('aria-live="polite"');
  });
});
