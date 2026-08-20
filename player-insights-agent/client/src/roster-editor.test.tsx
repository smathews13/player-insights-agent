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
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { roleOptions, RosterRows } from './UserRoleEditor';
import { canSubmit, originLabel, roleWord, rosterSummary, rowLocked, setOn, stepsDownFrom } from './user-roster';
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
    expect(text(markup)).toContain('Role · Consumer');
    expect(roleOptions(analyst).map((option) => option.value)).toEqual(['consumer', 'admin']);
  });

  it('names the row in the control, so a screen reader is not given a bare menu', () => {
    expect(rows({ entries: [entry({ email: ANALYST, role: 'consumer', assignable: ['admin'] })] })).toContain(
      `Role for ${ANALYST}`
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
    expect(text(markup)).toContain(`${LEAD} you Seed Super admin`);
    expect(markup).toContain('title="Set at deployment. Edit the bundle variable to change it."');
    expect(markup).toContain('roster-role-chip-super-admin');
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

  it('uses the 820px settings column and compact bordered roster rows', () => {
    expect(css).toMatch(/\.settings-page \{[^}]*max-width:\s*820px/);
    expect(css).toMatch(/\.settings-page \{[^}]*padding:\s*24px 32px/);
    expect(css).toMatch(/\.settings-page \[data-slot='card'\] \{[^}]*border-radius:\s*8px/);
    expect(css).toMatch(/\.admin-row \{[^}]*border:\s*1px solid #ebebeb/);
    expect(css).toMatch(/\.admin-row \{[^}]*border-radius:\s*var\(--radius-sm\)/);
    expect(css).toMatch(/\.admin-row-email \{[^}]*font-family:\s*var\(--font-mono\)/);
  });

  it('carries no grant anatomy at all, because no row draws one', () => {
    expect(css).not.toContain('.admin-row-access');
    expect(css).not.toContain('.admin-access');
  });

  it('keeps the add controls at 32px', () => {
    expect(css).toMatch(/\.admin-add > \[data-slot='input'\] \{[^}]*height:\s*32px/);
    expect(css).toMatch(/\.admin-add \[data-slot='button'\] \{[^}]*height:\s*32px/);
  });

  /**
   * SAM'S REPORT, AS A TEST. "Role · Admin" was clipped to "Role · A..." and Add sat
   * against the card's right edge nearly on top of the dropdown. The three controls
   * shared one flex line and the two fixed-width ones were shrinking, so the fix is
   * about which control gives way: the address field, which is the only one whose
   * content is not a fixed label.
   */
  it('shrinks the address field rather than the role dropdown or the Add button', () => {
    // The dropdown is never narrower than "Role · Super admin", in the add row or
    // in a row's own controls.
    expect(css).toMatch(/\.roster-role-select \{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.admin-add \[data-slot='button'\] \{[^}]*flex:\s*none/);
    // The one control with room to give, and it may give all of it.
    expect(css).toMatch(/\.admin-add > \[data-slot='input'\] \{[^}]*flex:\s*1 1 14rem/);
    expect(css).toMatch(/\.admin-add > \[data-slot='input'\] \{[^}]*min-width:\s*0/);
    // Too narrow for all three and the row wraps, rather than overlapping.
    expect(css).toMatch(/\.admin-add \{[^}]*flex-wrap:\s*wrap/);
    // Inside the card's own 16px, with the same gap between all three.
    expect(css).toMatch(/\.admin-add \{[^}]*gap:\s*8px/);
    expect(css).toMatch(/\.settings-page \[data-slot='card-content'\] \{[^}]*padding-inline:\s*16px/);
  });

  /** The value in the trigger, so the closed control reads "Role · Admin" whole. */
  it('keeps the gold-standard dropdown, label and value in one field', () => {
    expect(text(rows({ entries: [entry({ email: ANALYST, role: 'admin', assignable: ['consumer'] })] }))).toContain(
      'Role · Admin'
    );
    expect(partial('base.css')).toMatch(/\.app-select-label,\s*\.app-select-separator \{\s*flex: none/);
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

describe('the line above the roster', () => {
  const payload = (over: Partial<RosterPayload> & { entries: RosterEntry[] }): RosterPayload => ({
    storedRosterReadable: true,
    roleColumnPresent: true,
    pendingSchemaStatement: '',
    superAdminCount: over.entries.filter((row) => row.role === 'super_admin').length,
    recoveryStatement: '',
    ...over,
  });

  it('says the stored half could not be read rather than drawing it empty', () => {
    const summary = rosterSummary(
      payload({ entries: [entry({ email: LEAD, role: 'super_admin' })], storedRosterReadable: false })
    );
    expect(summary).toContain('could not be read');
    expect(summary).toContain('Nobody has lost a role.');
  });

  it('says a deployment with nobody on it has nobody, which is a different fact', () => {
    expect(rosterSummary(payload({ entries: [] }))).toContain('no administrators');
  });

  it('counts the administrators and how many of them are super', () => {
    const summary = rosterSummary(
      payload({
        entries: [
          entry({ email: LEAD, role: 'super_admin' }),
          entry({ email: DEPUTY, role: 'admin' }),
          entry({ email: ANALYST, role: 'consumer' }),
        ],
      })
    );
    expect(summary).toContain('2 administrators, 1 super');
    expect(summary).toContain('3 people');
  });

  it('uses the exact singular summary and suppresses zero counts', () => {
    const summary = rosterSummary(
      payload({ entries: [entry({ email: LEAD, role: 'super_admin', seedFloor: 'super_admin' })] })
    );
    expect(summary).toBe('1 administrator, 1 super. 1 person on the roster.');

    const consumerOnly = rosterSummary(payload({ entries: [entry({ email: ANALYST, role: 'consumer' })] }));
    expect(consumerOnly).toBe('1 person on the roster.');
    expect(consumerOnly).not.toContain('0');
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
  it('uses the shared app dropdown recipe for roles', () => {
    const base = partial('base.css');
    expect(base).toMatch(/\.app-select-trigger \{[^}]*border-radius: var\(--radius-sm\)/);
    expect(base).toMatch(/\.app-select-trigger \{[^}]*border: 1px solid var\(--ast-border-input\)/);
  });

  it('holds the locked line in the column the select would occupy', () => {
    expect(partial('settings.css')).toMatch(/\.roster-row-locked \{[^}]*text-align: right/);
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
