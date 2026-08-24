import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdminRows } from './AdminListEditor';
import { addedOn, canSubmit, listSummary, originLabel } from './admin-list';
import type { AdminListEntry } from './admin-list';
import type { AdminListPayload } from '../../shared/admin-contract';
import { partial } from './styles/stylesheet';

/**
 * The card says who administers this deployment, and nothing about Unity Catalog.
 *
 * WHAT THESE TESTS USED TO HOLD, AND WHY THAT WENT. Adding an administrator did two
 * things: it wrote a name to a list, and it asked Unity Catalog for read on the app's
 * telemetry schema and the two `system.billing` tables. Every row therefore carried
 * a state word per object, and a refusal carried a copyable GRANT. Granting on
 * `system` needs an account admin who is also a metastore admin, so on the ordinary
 * deployment the card's loudest element was "Not granted" and PERMISSION_DENIED
 * beside a colleague who had been appointed successfully. Sam reported it as a
 * blocked workflow, and it was: nothing was blocked, the screen just said so.
 *
 * So the assertions below are the other way round. The row is an identity, an
 * origin and a Remove button, and no Unity Catalog object, state or statement may
 * appear on it. Asserted against RENDERED markup, in the pattern
 * connections-render.test.tsx set: this repository has shipped screens that were
 * wrong while every assertion about their source was true.
 */

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

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

function seed(email: string): AdminListEntry {
  return { email, origin: 'seed', addedBy: '', addedAt: '', isYou: false, removable: false };
}

function added(email: string, by: string): AdminListEntry {
  return {
    email,
    origin: 'added',
    addedBy: by,
    addedAt: '2026-08-15T18:00:00Z',
    isYou: false,
    removable: true,
  };
}

function rows(payload: Partial<AdminListPayload> & { entries: AdminListEntry[] }): string {
  const full: AdminListPayload = {
    entries: payload.entries,
    addedAdminsReadable: payload.addedAdminsReadable ?? true,
    seedAdminCount: payload.seedAdminCount ?? payload.entries.filter((entry) => entry.origin === 'seed').length,
  };
  return renderToStaticMarkup(<AdminRows payload={full} busy={false} onRemove={() => {}} />);
}

describe('the row is about a person, not about a catalog', () => {
  /**
   * SAM'S REPORT, AS A TEST. The words below are the ones that were on screen under
   * every administrator, and every one of them was about an object nobody had asked
   * this screen for.
   */
  it('names no Unity Catalog object and shows no grant state', () => {
    const markup = rows({ entries: [seed('sam@example.com'), added('pat@example.com', 'sam@example.com')] });
    const rendered = text(markup);

    expect(rendered).not.toContain('Telemetry schema');
    expect(rendered).not.toContain('Billing tables');
    expect(rendered).not.toContain('system.billing');
    expect(rendered).not.toContain('Already held');
    expect(rendered).not.toContain('Not granted');
    expect(rendered).not.toContain('Not checked');
    expect(rendered).not.toContain('PERMISSION_DENIED');
    expect(rendered).not.toContain('GRANT');
    // Nor the containers they were drawn in, so a reinstatement is a visible
    // change rather than a class quietly coming back to life.
    expect(markup).not.toContain('admin-row-access');
    expect(markup).not.toContain('admin-access');
    expect(markup).not.toContain('brand-icon');
  });

  it('says only what the row is: who, where from, and whether it may go', () => {
    const rendered = text(rows({ entries: [added('pat@example.com', 'sam@example.com')] }));

    expect(rendered).toContain('pat@example.com');
    expect(rendered).toContain('Added by sam@example.com');
    expect(rendered).toContain('Remove');
  });

  /** The card is a card about people. Its stylesheet should not describe grants. */
  it('keeps the grant styling out of the stylesheet as well as out of the markup', () => {
    expect(partial('settings.css')).not.toContain('.admin-access');
  });
});

describe('where a row came from decides what may be done to it', () => {
  it('offers Remove on an added row and no button at all on a seed row', () => {
    const markup = rows({ entries: [seed('sam@example.com'), added('pat@example.com', 'sam@example.com')] });

    expect(markup).toContain('aria-label="Remove pat@example.com"');
    expect(markup).toContain('settings-destructive');
    // Absent rather than disabled: a greyed control a reader can never enable is
    // a permanent invitation to ask why it is greyed.
    expect(markup).not.toContain('aria-label="Remove sam@example.com"');
  });

  it('says where each row came from without inventing a date for a seed row', () => {
    const rendered = text(rows({ entries: [seed('sam@example.com'), added('pat@example.com', 'sam@example.com')] }));

    expect(originLabel(seed('sam@example.com'))).toBe('Set at deployment');
    expect(addedOn(seed('sam@example.com'))).toBe('');
    expect(rendered).toContain('Set at deployment');
    expect(rendered).toContain('Added by sam@example.com');
  });

  it('marks the reader\u2019s own row, so removing yourself is deliberate', () => {
    const you = { ...added('pat@example.com', 'sam@example.com'), isYou: true };

    expect(text(rows({ entries: [you] }))).toContain('pat@example.com You');
  });
});

describe('the line above the list', () => {
  /**
   * An unreadable list and an empty list put the same zero rows on screen and
   * have different remedies. Conflating them is what sends somebody looking for
   * a person who was never removed.
   */
  it('distinguishes a list that could not be read from a list with nobody on it', () => {
    const broken = listSummary({ entries: [seed('sam@example.com')], addedAdminsReadable: false, seedAdminCount: 1 });
    const empty = listSummary({ entries: [], addedAdminsReadable: true, seedAdminCount: 0 });

    expect(broken).toContain('could not be read');
    expect(broken).toContain('Nobody has lost the role.');
    expect(empty).toContain('no administrators');
    expect(empty).not.toContain('could not be read');
  });

  it('counts the two origins separately', () => {
    const summary = listSummary({
      entries: [seed('sam@example.com'), added('pat@example.com', 'sam@example.com')],
      addedAdminsReadable: true,
      seedAdminCount: 1,
    });

    expect(summary).toBe('2 administrators: 1 set at deployment, 1 added here.');
  });
});

describe('the copy on the card', () => {
  const editor = source('AdminListEditor.tsx');
  const roles = source('UserRoleEditor.tsx');

  /** The binding copy rule for this app. */
  it('uses no em dashes', () => {
    const visible = text(rows({ entries: [added('pat@example.com', 'sam@example.com')] }));

    expect(visible).not.toContain('\u2014');
  });

  /**
   * Opening a settings page must not change anybody's permissions. It used to: the
   * editor posted to a route that reconciled Unity Catalog grants for everybody on
   * the list, on every load.
   */
  it('reads on load and asks for no grants', () => {
    for (const file of [editor, roles]) {
      expect(file).not.toContain('/api/admins/access');
      expect(file).not.toContain('applyAccess');
    }
    expect(editor).toMatch(/fetch\('\/api\/admins'\)/);
  });

  /**
   * The add succeeded or it did not. The line used to point the reader at rows of
   * grant state under the name, which is where the refusal they could do nothing
   * about was waiting.
   */
  it('reports the add as the one thing it is', () => {
    expect(editor).toContain('is now an administrator.');
    expect(editor).not.toContain('Their access is below.');
    expect(editor).not.toMatch(/now an administrator with (?:full )?access/);
  });

  it('keeps the add roles without the mechanics narrative', () => {
    expect(roles).not.toContain('Adding grants the role');
    expect(editor).not.toContain('Adding grants the role');
    expect(roles).not.toContain('Telemetry feeds the Ops health block');
    expect(editor).not.toContain('Telemetry feeds the Ops health block');
    expect(roles).toContain("const ADDABLE_ROLES: readonly Role[] = ['admin', 'consumer']");
  });
});

describe('the add control', () => {
  it('does nothing until there is something to submit, and not while busy', () => {
    expect(canSubmit('', false)).toBe(false);
    expect(canSubmit('   ', false)).toBe(false);
    expect(canSubmit('pat@example.com', true)).toBe(false);
    expect(canSubmit('pat@example.com', false)).toBe(true);
  });

  /**
   * SAM'S REPORT, AS A TEST. This card's add row has two controls rather than three,
   * but it shares the rules with the roster's, and its Add button was clipped by the
   * same right edge.
   */
  it('gives the address field the room and keeps the button whole', () => {
    const css = partial('settings.css');

    expect(css).toMatch(/\.admin-add \{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.admin-add > \[data-slot='input'\] \{[^}]*flex:\s*1 1 14rem/);
    expect(css).toMatch(/\.admin-add \[data-slot='button'\] \{[^}]*flex:\s*none/);
  });
});
