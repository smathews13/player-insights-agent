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
    expect(markup).toContain('aria-label="Persona for admin@example.com: No persona"');
    expect(markup).toContain('>Owner</span>');
    expect(markup).not.toContain('aria-label="Persona for owner@example.com');
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
    expect(SETTINGS).toMatch(/\.sp-definitions-table th:nth-child\(5\)\s*\{[^}]*width:\s*80px/s);
    expect(SETTINGS).toMatch(/\.sp-definition-actions\s*\{[^}]*justify-content:\s*flex-end/s);
    expect(SETTINGS).toMatch(
      /\.sp-definition-actions > \[data-slot='button'\]\s*\{[^}]*flex:\s*0 0 30px[^}]*width:\s*30px/s
    );
  });

  it('keeps credential references aligned without forcing horizontal overflow', () => {
    expect(SETTINGS).toMatch(/\.sp-definitions-table\s*\{[^}]*min-width:\s*0[^}]*table-layout:\s*fixed/s);
    expect(SETTINGS).toMatch(
      /\.sp-connection-fields\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s
    );
    expect(SETTINGS).toMatch(/\.sp-connection-fields \.runtime-field\s*\{[^}]*grid-template-rows:\s*18px 34px 32px/s);
    expect(SETTINGS).toMatch(/\.sp-connection-form \[data-slot='input'\]\s*\{[^}]*height:\s*34px/s);
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
