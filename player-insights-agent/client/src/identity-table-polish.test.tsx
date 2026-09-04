import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RosterPayload } from '../../shared/user-roster-contract';
import { DATABRICKS_SYMBOL } from './brand-icons';
import { RosterAddRow, RosterRows } from './UserRoleEditor';

const CSS = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');
const TOKENS = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8');

function bodyFor(css: string, selector: string): string {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return [...declarations.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((candidate) => candidate.trim() === selector))
    .map((match) => match[2])
    .join('\n');
}

const payload: RosterPayload = {
  entries: [
    {
      email: 'fictional.deployer@example.com',
      isDeploymentOwner: true,
      role: 'super_admin',
      seedFloor: 'super_admin',
      setBy: 'fictional.deployer@example.com',
      setAt: '2026-08-19T00:00:00.000Z',
      isYou: true,
      assignable: [],
      canRemove: false,
    },
    {
      email: 'an.identity.with.a.deliberately.long.local.part@outside.example.invalid',
      isDeploymentOwner: false,
      role: 'admin',
      seedFloor: 'consumer',
      setBy: 'a.deliberately.long.setter.address@another.example.invalid',
      setAt: '2026-08-20T00:00:00.000Z',
      isYou: false,
      assignable: ['admin', 'consumer'],
      canRemove: true,
    },
  ],
  storedRosterReadable: true,
  roleColumnPresent: true,
  pendingSchemaStatement: '',
  superAdminCount: 1,
  recoveryStatement: '',
};

function roster(busy = false) {
  return renderToStaticMarkup(
    <RosterRows
      payload={payload}
      busy={busy}
      personas={[]}
      personaByEmail={new Map()}
      personaDisabled={false}
      showPersona={true}
      onPersonaChange={() => {}}
      onChange={() => {}}
      onRemove={() => {}}
    />
  );
}

describe('Identity table polish', () => {
  it('reserves control columns and owns overflow at the screenshot and narrower desktop widths', () => {
    // 1024px is the supplied capture. The wider modal leaves 812px before the
    // platform scrollbar; the table's 800px floor fits there. At 900px the table
    // scrolls inside its 688px frame instead of widening or escaping the modal.
    expect(1024 - 32 - 140 - 40).toBe(812);
    expect(900 - 32 - 140 - 40).toBe(688);
    expect(CSS).toMatch(/\.settings-page\.settings-modal \{[^}]*width:\s*min\(1080px,\s*calc\(100vw - 32px\)\)/s);
    expect(CSS).toMatch(
      /\.settings-table-frame \{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/s
    );
    expect(CSS).toMatch(/\.roles-table \{[^}]*min-width:\s*800px/s);
    expect(CSS).toMatch(/\.roles-table--editable \.roster-set-by-column \{[^}]*width:\s*140px/s);
    expect(CSS).toMatch(/\.roles-table--editable \.roster-role-column \{[^}]*width:\s*126px/s);
    expect(CSS).toMatch(/\.roles-table--editable \.roster-persona-column \{[^}]*width:\s*136px/s);
    expect(CSS).toMatch(/\.roles-table--editable \.roster-action-column \{[^}]*width:\s*112px/s);
    expect(CSS).toMatch(
      /\.settings-modal-content \{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/s
    );
    expect(RESPONSIVE).toMatch(/@media \(max-width:\s*800px\)[\s\S]*\.settings-modal-content \{[^}]*padding:\s*14px/s);
  });

  it('keeps the Actions column and its controls pinned inside the table frame', () => {
    const markup = roster();
    const stickyRule = CSS.match(
      /\.settings-actions-table th:last-child,\s*\.settings-actions-table td:last-child \{([^}]*)\}/s
    )?.[1];
    expect(markup).toContain('settings-actions-table');
    expect(markup).toContain('<th scope="col">Actions</th>');
    expect(markup).toContain(
      'aria-label="Remove an.identity.with.a.deliberately.long.local.part@outside.example.invalid"'
    );
    expect(markup).toContain('data-variant="destructive"');
    expect(markup).toMatch(/roster-action-icon[\s\S]*Remove<\/button>/);
    expect(CSS).toMatch(
      /\.settings-actions-table th:last-child,\s*\.settings-actions-table td:last-child \{[^}]*position:\s*sticky[^}]*right:\s*0/s
    );
    expect(CSS).toMatch(/\.settings-actions-table td:last-child \{[^}]*white-space:\s*nowrap/s);
    expect(stickyRule).not.toMatch(/background|box-shadow/);
  });

  it('uses semantic panel, header, row, hover, focus, and selected surfaces in both themes', () => {
    const frame = bodyFor(CSS, '.roster-frame');
    expect(frame).toMatch(/--roster-panel-surface:\s*var\(--background\)/);
    expect(frame).toMatch(/--roster-header-surface:\s*var\(--muted\)/);
    expect(frame).toMatch(/--roster-interaction-surface:\s*var\(--db-selected-tint\)/);
    expect(frame).toMatch(/border-color:\s*var\(--border\)/);
    expect(frame).toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(frame).toMatch(/background:\s*var\(--roster-panel-surface\)/);
    expect(frame).toMatch(/box-shadow:[^;]*var\(--db-ink-deep\)/);
    expect(bodyFor(CSS, '.roles-table tr')).toMatch(
      /--settings-table-cell-background:\s*var\(--roster-panel-surface\)/
    );
    expect(bodyFor(CSS, '.roles-table thead tr')).toMatch(
      /--settings-table-cell-background:\s*var\(--roster-header-surface\)/
    );
    expect(CSS).toMatch(/\.roles-table th \{[^}]*background:\s*var\(--settings-table-cell-background\)/s);
    expect(CSS).toMatch(/\.roles-table td \{[^}]*background:\s*var\(--settings-table-cell-background\)/s);
    expect(CSS).toMatch(
      /\.roles-table tbody tr:hover,\s*\.roles-table tbody tr:focus-within \{[^}]*--settings-table-cell-background:\s*var\(--roster-interaction-surface\)/s
    );
    expect(bodyFor(CSS, '.roles-table tbody tr:hover')).not.toMatch(/(?:^|;)\s*(?:color|opacity):/);
    expect(CSS).toMatch(
      /\.roles-table tbody tr\[aria-selected='true'\],\s*\.roles-table tbody tr\[data-selected='true'\] \{[^}]*--settings-table-cell-background:\s*var\(--roster-interaction-surface\)/s
    );
    expect(bodyFor(TOKENS, ':root')).toMatch(/--background:\s*#ffffff/);
    expect(bodyFor(TOKENS, "html[data-theme='dark']")).toMatch(/--background:\s*var\(--ast-navy\)/);
    expect(CSS).not.toMatch(/html\[data-theme='dark'\][^{]*\.settings-actions-table[^}]*background/s);
  });

  it('keeps controls integrated and contains no roster-specific flat gray paint', () => {
    const controls = bodyFor(CSS, '.roles-table .roster-control');
    const inputs = bodyFor(CSS, ".roles-table [data-slot='input']");
    for (const body of [controls, inputs]) {
      expect(body).toMatch(/border-color:\s*var\(--input\)/);
      expect(body).toMatch(/background:\s*var\(--roster-panel-surface\)/);
      expect(body).toMatch(/color:\s*var\(--foreground\)/);
    }

    const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rosterPaint = [...declarations.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(
        (match) =>
          (/\.roles-table|\.roster-frame/.test(match[1]) && !match[1].includes(':not(.roles-table)')) ||
          match[1].includes('.roster-frame')
      )
      .map((match) => match[2])
      .join('\n');
    expect(rosterPaint).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bgr[ae]y\b/i);
    expect(rosterPaint).not.toMatch(/background:\s*var\(--card\)/);
    expect(CSS).not.toMatch(/\.roles-table--(?:gray|grey)|\.roster-(?:gray|grey)/i);
  });

  it('keeps immutable Super admin and Owner badges complete and separated by columns', () => {
    const markup = roster();
    expect(markup).toContain('data-role-state="super_admin"');
    expect(markup).toContain('Super admin');
    expect(markup).toContain('roster-owner-badge">Owner</span>');
    expect(markup).not.toContain('aria-label="Remove fictional.deployer@example.com"');
    expect(CSS).toMatch(
      /\.roster-role > \.role-badge,\s*\.roster-owner-badge \{[^}]*max-width:\s*none[^}]*overflow:\s*visible[^}]*white-space:\s*nowrap/s
    );
  });

  it('renders the official Databricks mark and a derived domain mark without hiding either full email', () => {
    const markup = roster();
    expect(markup).toContain('aria-label="Organization: Databricks"');
    expect(markup).toContain('data-organization-domain="databricks.com"');
    expect(markup).toContain(DATABRICKS_SYMBOL);
    expect(markup).toContain('aria-label="Organization: outside.example.invalid"');
    expect(markup).toContain('>EX</span>');
    expect(markup).not.toContain('lucide-building-2');
    for (const entry of payload.entries) {
      expect(markup).toContain(`title="${entry.email}">${entry.email}</span>`);
      expect(markup).toContain(`aria-label="Copy email ${entry.email}"`);
    }
  });

  it('aligns the Add row to the same columns and preserves disabled and focusable control states', () => {
    const enabled = renderToStaticMarkup(
      <table>
        <tfoot>
          <RosterAddRow
            draft="person@example.com"
            role="admin"
            busy={false}
            onDraftChange={() => {}}
            onRoleChange={() => {}}
            onAdd={() => {}}
          />
        </tfoot>
      </table>
    );
    const disabled = renderToStaticMarkup(
      <table>
        <tfoot>
          <RosterAddRow
            draft=""
            role="admin"
            busy={true}
            onDraftChange={() => {}}
            onRoleChange={() => {}}
            onAdd={() => {}}
          />
        </tfoot>
      </table>
    );
    const loading = renderToStaticMarkup(
      <table>
        <tfoot>
          <RosterAddRow
            draft="person@example.com"
            role="admin"
            busy={true}
            adding={true}
            onDraftChange={() => {}}
            onRoleChange={() => {}}
            onAdd={() => {}}
          />
        </tfoot>
      </table>
    );

    expect(enabled).toContain('class="roster-add-row"');
    expect(enabled.match(/<td/g) ?? []).toHaveLength(5);
    expect(enabled).toContain('aria-label="Email address to put on the roster"');
    expect(enabled).toContain('aria-label="User role to give them: Admin"');
    expect(enabled).toContain('Add</button>');
    expect(enabled).toContain('roster-action-icon');
    expect(roster()).toContain('roster-control settings-destructive roster-action-button');
    expect(enabled).not.toMatch(/Add<\/button>.*disabled/);
    expect(enabled).toMatch(/focus-visible:[^"]+/);
    expect(disabled).toContain('disabled=""');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Adding…');
    expect(CSS).toMatch(
      /\.roles-table \.roster-action > \[data-slot='button'\]\.roster-action-button \{[^}]*width:\s*92px[^}]*min-width:\s*92px[^}]*max-width:\s*92px[^}]*height:\s*30px[^}]*padding:\s*0 9px[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*gap:\s*6px[^}]*text-align:\s*center/s
    );
    expect(CSS).toMatch(
      /\.roster-action-button \.roster-action-icon \{[^}]*width:\s*14px[^}]*height:\s*14px[^}]*flex:\s*none/s
    );
    expect(CSS).toMatch(/\.roles-table\.settings-actions-table th:last-child \{[^}]*text-align:\s*center/s);
    expect(CSS).toMatch(/\.roles-table \.roster-action \{[^}]*text-align:\s*center/s);
    expect(CSS).toMatch(
      /\.settings-page \[data-slot='button'\]\.settings-destructive \{[^}]*background:\s*var\(--db-red-700\)[^}]*color:\s*var\(--destructive-foreground\)/s
    );
  });

  it('disables destructive controls while a roster mutation is in progress', () => {
    const markup = roster(true);
    expect(markup).toMatch(
      /disabled=""[^>]*aria-label="Remove an\.identity\.with\.a\.deliberately\.long\.local\.part@outside\.example\.invalid"/
    );
  });
});
