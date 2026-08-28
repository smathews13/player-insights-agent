/**
 * The roster row must not be able to offer a change the server would refuse.
 *
 * Every test here is a way the panel could disagree with the route. Each of the
 * disagreements looks tidier on screen than the truth, which is why they need a test
 * rather than a comment: a menu with all three roles in it always looks more
 * complete than one with two, and a Remove button on every row looks more consistent
 * than one that is sometimes absent.
 *
 * Rendered rather than asserted against the source, because this repository has
 * shipped screens that were wrong while every test passed by checking the source of
 * a component nobody rendered.
 *
 * Every address here is invented. The people this feature exists for are at a
 * customer domain, and a real address in a test file is a real address in the
 * published tree.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RosterRows } from './UserRoleEditor';
import { roleOptions } from './user-role-options';
import { canSubmit, originLabel, roleWord, rowLocked, setOn, stepsDownFrom } from './user-roster';
import { badgeAnnouncement, badgeLabel, badgeTitle, roleFrom, showsAdminSurfaces, showsUserRoster } from './role';
import type { Role, RosterEntry, RosterPayload } from '../../shared/user-roster-contract';
import { partial } from './styles/stylesheet';

const LEAD = 'lead@example.invalid';
const DEPUTY = 'deputy@example.invalid';
const ANALYST = 'analyst@example.invalid';

/** The text a reader sees, tags removed and entities put back. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function entry(over: Partial<RosterEntry> & { email: string; role: Role }): RosterEntry {
  return {
    seedFloor: 'consumer',
    setBy: LEAD,
    setAt: '2026-08-17T00:00:00.000Z',
    isYou: false,
    assignable: [],
    canRemove: false,
    ...over,
  };
}

function rows(over: Partial<RosterPayload> & { entries: RosterEntry[] }): string {
  const full: RosterPayload = {
    entries: over.entries,
    storedRosterReadable: over.storedRosterReadable ?? true,
    roleColumnPresent: over.roleColumnPresent ?? true,
    pendingSchemaStatement: over.pendingSchemaStatement ?? '',
    superAdminCount: over.superAdminCount ?? over.entries.filter((row) => row.role === 'super_admin').length,
    recoveryStatement: over.recoveryStatement ?? '',
  };
  return renderToStaticMarkup(<RosterRows payload={full} busy={false} onChange={() => {}} onRemove={() => {}} />);
}

describe('the row offers only what the server allows', () => {
  it('draws no role control at all when the server offers no role', () => {
    // A seeded row. The environment would restore the role on the next request, so a
    // control here would appear to work and would not.
    const markup = rows({ entries: [entry({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' })] });
    expect(markup).not.toContain('role="combobox"');
    expect(text(markup)).toContain('Super admin');
  });

  it('draws no Remove button when the server would refuse the removal', () => {
    const markup = rows({ entries: [entry({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' })] });
    expect(markup).not.toContain(`Remove ${LEAD}`);
  });

  it('offers exactly the roles the server named, and the one held', () => {
    const analyst = entry({ email: ANALYST, role: 'consumer', assignable: ['admin'] });
    const markup = rows({
      entries: [analyst],
    });
    expect(markup).toContain('role="combobox"');
    expect(text(markup)).toContain('Consumer');
    expect(text(markup)).not.toContain('Role ·');
    expect(roleOptions(analyst).map((option) => option.value)).toEqual(['consumer', 'admin']);
  });

  it('routes a permitted removal through the shared destructive control', () => {
    const markup = rows({
      entries: [entry({ email: ANALYST, role: 'consumer', assignable: ['admin'], canRemove: true })],
    });
    expect(markup).toContain('settings-destructive');
    expect(markup).toContain('roster-control');
  });

  it('names the row in the control, so a screen reader is not given a bare menu', () => {
    expect(rows({ entries: [entry({ email: ANALYST, role: 'consumer', assignable: ['admin'] })] })).toContain(
      `User role for ${ANALYST}`
    );
  });
});

describe('the #24a roster row', () => {
  it('marks the reader, seed origin, super role, and immutable row explicitly', () => {
    const markup = rows({
      entries: [
        entry({
          email: LEAD,
          role: 'super_admin',
          seedFloor: 'super_admin',
          isYou: true,
          assignable: [],
          canRemove: false,
        }),
      ],
    });
    expect(text(markup)).toContain(`${LEAD} you Deployment Super admin`);
    expect(markup).toContain('title="Set at deployment. Edit the bundle variable to change it."');
    expect(markup).toContain('roster-role-status');
    expect(markup).toContain('ast-pill--neutral-outline');
    expect(markup).toContain('roster-row-lock');
  });

  /**
   * SAM'S REPORT, AS A TEST. Every administrator's row used to carry a block naming
   * the app's telemetry schema and the two `system.billing` tables, with a state
   * word each. Granting on `system` needs a metastore admin, so the usual state was
   * "Not granted" and PERMISSION_DENIED under the name of somebody who had in fact
   * been appointed. This panel is people and roles.
   */
  it('names no Unity Catalog object and shows no grant state, at any role', () => {
    const markup = rows({
      entries: [
        entry({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' }),
        entry({ email: DEPUTY, role: 'admin', assignable: ['consumer'] }),
        entry({ email: ANALYST, role: 'consumer', assignable: ['admin'] }),
      ],
    });
    const rendered = text(markup);

    expect(rendered).not.toContain('Telemetry schema');
    expect(rendered).not.toContain('Billing tables');
    expect(rendered).not.toContain('system.billing');
    expect(rendered).not.toContain('Already held');
    expect(rendered).not.toContain('Not granted');
    expect(rendered).not.toContain('PERMISSION_DENIED');
    expect(rendered).not.toContain('GRANT');
    expect(markup).not.toContain('admin-row-access');
    expect(markup).not.toContain('admin-access');
  });
});

describe('the #24a Roles geometry', () => {
  const css = partial('settings.css');

  it('uses the 820px settings column and the pane-wide table treatment', () => {
    expect(css).toMatch(/\.settings-page \{[^}]*max-width:\s*820px/);
    expect(css).toMatch(/\.settings-page \{[^}]*padding:\s*24px 32px/);
    expect(css).toMatch(/\.settings-page \[data-slot='card'\] \{[^}]*border-radius:\s*8px/);
    expect(css).toMatch(/\.settings-data-table th,\s*\.settings-data-table td \{[^}]*padding:\s*8px 10px/);
    expect(css).toMatch(
      /\.settings-data-table th,\s*\.settings-data-table td \{[^}]*border-bottom:\s*1px solid var\(--border\)/
    );
    expect(css).toMatch(/\.admin-row-email \{[^}]*font-family:\s*var\(--font-mono\)/);
  });

  it('carries no grant anatomy at all, because no row draws one', () => {
    expect(css).not.toContain('.admin-row-access');
    expect(css).not.toContain('.admin-access');
  });

  it('keeps the add controls compact', () => {
    expect(css).toMatch(/\.roster-add-row \[data-slot='input'\] \{[^}]*height:\s*30px/);
    expect(css).toMatch(/\.roster-add-row \[data-slot='button'\] \{[^}]*height:\s*30px/);
  });

  /**
   * SAM'S REPORT, AS A TEST. The add email field was wider than the addresses
   * above it, so Role and Add did not line up with the row controls, and a
   * leftover flex gap sat between the name and the actions. One three-column
   * grid for every row and the Add line is the whole of the geometry.
   */
  it('puts email, setter, role and actions in a real table', () => {
    const markup = rows({
      entries: [entry({ email: ANALYST, role: 'consumer', assignable: ['admin'], canRemove: true })],
    });
    for (const heading of ['Email', 'Set by', 'User role', 'Actions']) {
      expect(markup).toContain(`<th scope="col">${heading}</th>`);
    }

    const editor = readFileSync(new URL('./UserRoleEditor.tsx', import.meta.url), 'utf8');
    expect(editor).toContain('<tfoot>{footer}</tfoot>');
    expect(editor).toContain('className="roster-add-row"');
    expect(editor).toContain('roster-frame');
  });

  it('keeps role and action controls compact within their columns', () => {
    expect(css).toMatch(/\.roster-role-select,\s*\.roster-persona-select \{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.roster-role-select \{[^}]*max-width:\s*9rem/);
    expect(css).toMatch(/\.roster-persona-select \{[^}]*max-width:\s*13rem/);
    expect(css).toMatch(/\.admin-add \[data-slot='button'\] \{[^}]*flex:\s*none/);
    expect(css).toMatch(/\.admin-add > \[data-slot='input'\] \{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.roles-table--editable th:last-child \{[^}]*text-align:\s*right/);
    expect(css).toMatch(/\.roster-action \{[^}]*text-align:\s*right/);
  });

  it('shows only the selected user role while keeping a descriptive accessible name', () => {
    const markup = rows({ entries: [entry({ email: ANALYST, role: 'admin', assignable: ['consumer'] })] });
    expect(text(markup)).toContain('Admin');
    expect(text(markup)).not.toContain('Role · Admin');
    expect(markup).toContain(`aria-label="User role for ${ANALYST}: Admin"`);
    const editor = readFileSync(new URL('./UserRoleEditor.tsx', import.meta.url), 'utf8');
    expect(editor).toContain('ariaLabel="User role to give them"');
    expect(
      editor.match(/className="roster-control roster-role-select"[\s\S]*?showLabel=\{false\}/g) ?? []
    ).toHaveLength(2);
  });
});

describe('why a row is locked', () => {
  const locked = (over: Partial<RosterEntry> & { email: string; role: Role }, payload: Partial<RosterPayload>) =>
    rowLocked(entry(over), {
      entries: [],
      storedRosterReadable: true,
      roleColumnPresent: true,
      pendingSchemaStatement: '',
      superAdminCount: 1,
      recoveryStatement: '',
      ...payload,
    });

  it('points at the deployment configuration for a seeded row', () => {
    expect(locked({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' }, {})).toBe(
      'Change this in the deployment configuration.'
    );
  });

  it('says the roster cannot record other roles yet when the column is absent', () => {
    expect(locked({ email: ANALYST, role: 'admin' }, { roleColumnPresent: false })).toBe(
      'This roster cannot record other roles yet.'
    );
  });

  it('says which row is the only super admin', () => {
    expect(locked({ email: LEAD, role: 'super_admin' }, { superAdminCount: 1 })).toBe('The only super admin.');
  });

  it('says nothing when the row has controls', () => {
    expect(locked({ email: ANALYST, role: 'consumer', assignable: ['admin'] }, {})).toBe('');
  });
});

describe('the way back into a deployment nobody can administer', () => {
  it('prints the statement when the server sent one', () => {
    const statement =
      "INSERT INTO player_insights.admin_emails (email, role, added_by) VALUES ('<address>', 'super_admin', '<who>')";
    const markup = rows({ entries: [], recoveryStatement: statement });
    expect(text(markup)).toContain('super_admin');
    expect(markup).toContain('Appoint a super admin');
  });

  it('prints nothing when the server withheld it', () => {
    expect(rows({ entries: [entry({ email: LEAD, role: 'super_admin' })] })).not.toContain('Appoint a super admin');
  });

  it('prints the pending schema statement when the roster cannot record a role', () => {
    const markup = rows({
      entries: [],
      roleColumnPresent: false,
      pendingSchemaStatement: 'ALTER TABLE player_insights.admin_emails ADD COLUMN IF NOT EXISTS role TEXT',
    });
    expect(markup).toContain('Add the role column');
  });
});

describe('the statements this panel still prints', () => {
  /**
   * Two, and both are about the panel itself rather than about anybody's data
   * access: appointing a super admin when nobody can, and adding the roster's role
   * column. The third one, a GRANT on the telemetry schema or the billing tables for
   * a person who had just been promoted, is gone with the grants.
   */
  it('prints no GRANT for a person, at any role', () => {
    const rendered = text(
      rows({
        entries: [
          entry({ email: DEPUTY, role: 'admin', assignable: ['consumer'] }),
          entry({ email: ANALYST, role: 'super_admin', assignable: ['admin'] }),
        ],
      })
    );

    expect(rendered).not.toContain('GRANT SELECT');
    expect(rendered).not.toContain('metastore');
  });
});

describe('a super admin stepping down is told before the panel goes', () => {
  const me = entry({ email: LEAD, role: 'super_admin', isYou: true, assignable: ['admin', 'consumer'] });

  it('names what is lost on the way to consumer', () => {
    expect(stepsDownFrom(me, 'consumer')).toContain('Monitoring, Ops');
  });

  it('names what is lost on the way to admin', () => {
    expect(stepsDownFrom(me, 'admin')).toContain('change roles');
  });

  it('says nothing about somebody else', () => {
    expect(stepsDownFrom(entry({ email: DEPUTY, role: 'super_admin' }), 'admin')).toBe('');
  });

  it('says nothing about a rise', () => {
    expect(stepsDownFrom(me, 'super_admin')).toBe('');
  });
});

describe('the row says where a role came from', () => {
  it('calls a seeded row deployment configuration', () => {
    expect(originLabel(entry({ email: LEAD, role: 'super_admin', seedFloor: 'admin' }))).toBe('Set at deployment');
  });

  it('names who set a stored role', () => {
    expect(originLabel(entry({ email: ANALYST, role: 'admin' }))).toBe(`Set by ${LEAD}`);
  });

  it('never guesses a date it was not given', () => {
    expect(setOn(entry({ email: ANALYST, role: 'admin', setAt: '' }))).toBe('');
    expect(setOn(entry({ email: ANALYST, role: 'admin', setAt: 'not a date' }))).toBe('');
  });
});

describe('the badge and the layout', () => {
  it('calls the rank Super admin, never an initial', () => {
    expect(badgeLabel('super_admin')).toBe('Super admin');
  });

  it('gives both administrator ranks the admin layout', () => {
    expect(showsAdminSurfaces('super_admin')).toBe(true);
    expect(showsAdminSurfaces('admin')).toBe(true);
    expect(showsAdminSurfaces('consumer')).toBe(false);
  });

  it('draws the roster for the super admin only', () => {
    expect(showsUserRoster('super_admin')).toBe(true);
    expect(showsUserRoster('admin')).toBe(false);
    expect(showsUserRoster('failed')).toBe(false);
  });

  it('reads the rank off the identity payload', () => {
    expect(roleFrom({ signedInAs: LEAD, role: 'super_admin' }).state).toBe('super_admin');
  });

  it('still resolves a role it does not know as unknown rather than guessing', () => {
    expect(roleFrom({ signedInAs: LEAD, role: 'owner' }).state).toBe('failed');
  });

  it('names the one thing the rank adds, rather than repeating the Admin line', () => {
    expect(badgeTitle('super_admin')).not.toBe(badgeTitle('admin'));
    expect(badgeTitle('super_admin')).toContain('who else');
  });

  it('speaks the loss of the rank, because a control has just left the page', () => {
    expect(badgeAnnouncement('super_admin', 'admin')).toContain('now an admin');
  });

  it('stays silent on gaining it', () => {
    expect(badgeAnnouncement('admin', 'super_admin')).toBe('');
  });

  it('stays silent on the first resolve', () => {
    expect(badgeAnnouncement('resolving', 'super_admin')).toBe('');
  });
});

describe("the controls are the app's own", () => {
  const css = partial('settings.css');

  it('uses the shared app dropdown recipe for roles', () => {
    const base = partial('base.css');
    expect(base).toMatch(/\.app-select-trigger \{[^}]*border-radius: var\(--radius-sm\)/);
    expect(base).toMatch(/\.app-select-trigger \{[^}]*border: 1px solid var\(--ast-border-input\)/);
  });

  it('puts the immutable-row lock in Actions', () => {
    const markup = rows({ entries: [entry({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' })] });
    const role = markup.indexOf('roster-role-status');
    const lock = markup.indexOf('roster-row-lock');
    expect(lock).toBeGreaterThan(role);
  });

  /**
   * SAM'S REPORT, AS A TEST. Four unrelated control recipes sat in one list:
   * a Super-admin plaque, a Role dropdown, a solid red Remove, and a blue Add.
   * One quiet field language covers the dropdown, the lock, Add and Remove;
   * Remove stays destructive by ink, not by a filled slab.
   */
  it('shares one quiet control language across the roster, with Remove as an outline', () => {
    expect(css).toMatch(/\.roster-control \{[^}]*height:\s*30px/);
    expect(css).toMatch(/\.roster-control \{[^}]*border:\s*1px solid var\(--ast-border-input\)/);
    expect(css).toMatch(/\.roster-control \{[^}]*background:\s*var\(--card\)/);
    expect(css).toMatch(
      /\.settings-page \[data-slot='button'\]\.settings-destructive \{[^}]*background:\s*transparent/
    );
    expect(css).toMatch(
      /html\[data-theme='dark'\] \.settings-page \[data-slot='button'\]\.settings-destructive \{[^}]*background:\s*transparent/
    );
    expect(css).toMatch(
      /html\[data-theme='dark'\] \.settings-page \[data-slot='button'\]\.settings-destructive \{[^}]*color:\s*var\(--ast-destructive-control\)/
    );

    const markup = rows({
      entries: [entry({ email: ANALYST, role: 'consumer', assignable: ['admin'], canRemove: true })],
    });
    expect(markup).toContain('roster-control roster-role-select');
    expect(markup).toContain('roster-control settings-destructive');
  });
});

describe('the Add button', () => {
  it('does nothing until there is something to add', () => {
    expect(canSubmit('', false)).toBe(false);
    expect(canSubmit('  ', false)).toBe(false);
    expect(canSubmit(ANALYST, true)).toBe(false);
    expect(canSubmit(ANALYST, false)).toBe(true);
  });
});

describe('the word for each role', () => {
  it.each<[Role, string]>([
    ['super_admin', 'Super admin'],
    ['admin', 'Admin'],
    ['consumer', 'Consumer'],
  ])('%s reads as "%s"', (role, word) => {
    expect(roleWord(role)).toBe(word);
  });
});
