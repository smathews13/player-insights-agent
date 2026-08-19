import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdminRows } from './AdminListEditor';
import {
  accessFor,
  addedOn,
  canSubmit,
  linkTargetFor,
  listSummary,
  needsAttention,
  originLabel,
  stateWord,
} from './admin-list';
import type { AccessResult, AccessState, AdminListEntry } from './admin-list';
import type { AdminEditorPayload } from '../../shared/admin-contract';
import { databricksLink } from '../../shared/databricks-links';
import { partial } from './styles/stylesheet';

/**
 * The row must not be able to lie about the access behind the role.
 *
 * Adding an administrator does two things: it writes a name to a list, and it asks
 * Unity Catalog for the grants Monitoring and Ops read. The second can be refused
 * while the first succeeds, and every test here is a way that fact could be
 * smoothed over on screen. Each of the smoothings looks tidier than the truth,
 * which is why they need a test rather than a comment:
 *
 *   - Drawing an unanswered row as "no access". It is "not checked".
 *   - Drawing a refusal as pending, so it reads as something that will resolve.
 *   - Drawing access the person already had as access this app granted, which
 *     decides whether it is taken away when they are removed.
 *   - Reporting the add as done when only the role landed.
 *
 * The visible claims are asserted against RENDERED markup, in the pattern
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

/**
 * A telemetry destination that is not any real deployment's.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, which is what a fixture
 * standing in for a customer's catalog should be. The whole point of the row under
 * test is that this name comes from configuration at runtime, so a fixture that
 * looked like somebody's real catalog would be the leak the design avoids.
 */
const TELEMETRY_SCHEMA = 'a_catalog.a_telemetry_schema';

const GRANTED: AccessResult = {
  target: 'telemetry',
  label: 'Telemetry schema',
  state: 'granted',
  objects: [{ name: TELEMETRY_SCHEMA, kind: 'schema' }],
  purpose: 'What the Ops health block reads.',
  summary: 'Granted just now by this app, so removing them takes it away again.',
  grant: null,
  note: '',
};

const REFUSED: AccessResult = {
  target: 'billing',
  label: 'Billing tables',
  state: 'refused',
  objects: [
    { name: 'system.billing.usage', kind: 'table' },
    { name: 'system.billing.list_prices', kind: 'table' },
  ],
  purpose: 'What the Ops cost block reads.',
  summary: 'Read access was not granted. The role was granted.',
  grant: {
    object: 'system.billing.usage',
    privilege: 'SELECT',
    statement: 'GRANT SELECT ON TABLE system.billing.usage TO `pat@example.com`;',
  },
  note: 'Granting on the billing system tables needs a metastore administrator.',
};

/** No sentence, because the state word beside a named object is the whole fact. */
const ALREADY_HELD: AccessResult = {
  target: 'telemetry',
  label: 'Telemetry schema',
  state: 'already-held',
  objects: [{ name: TELEMETRY_SCHEMA, kind: 'schema' }],
  purpose: 'What the Ops health block reads.',
  summary: '',
  grant: null,
  note: '',
};

/** The customer-target case: no destination, so no name to print. */
const NOT_CONFIGURED: AccessResult = {
  target: 'telemetry',
  label: 'Telemetry schema',
  state: 'not-configured',
  objects: [],
  purpose: 'What the Ops health block reads.',
  summary:
    'This deployment writes no app telemetry, so there is no schema to read and nothing to grant. ' +
    'Nothing is wrong. The destination is set in the deployment configuration.',
  grant: null,
  note: '',
};

function rows(payload: Partial<AdminEditorPayload> & { entries: AdminListEntry[] }): string {
  const full: AdminEditorPayload = {
    entries: payload.entries,
    addedAdminsReadable: payload.addedAdminsReadable ?? true,
    seedAdminCount: payload.seedAdminCount ?? payload.entries.filter((entry) => entry.origin === 'seed').length,
    access: payload.access ?? [],
  };
  return renderToStaticMarkup(<AdminRows payload={full} busy={false} onRemove={() => {}} />);
}

describe('a row that has not been checked yet does not claim there is no access', () => {
  /**
   * The one that would be easiest to get wrong, and the worst to get wrong. The
   * list arrives from a pure GET; the access arrives from a POST that reconciles
   * and may wait on a cold warehouse. In between, both targets say "Not checked".
   */
  it('says Not checked on both targets while the access call is still out', () => {
    const markup = rows({ entries: [seed('pat@example.com')] });
    const rendered = text(markup);

    expect(rendered).toContain('Telemetry schema');
    expect(rendered).toContain('Billing tables');
    expect(markup.match(/admin-access-state-not-checked/g) ?? []).toHaveLength(2);
    expect(rendered.match(/not set/g) ?? []).toHaveLength(2);
    expect(rendered).not.toContain('No access');
    expect(rendered).not.toContain('Not granted');
  });

  it('names both targets in the placeholder rather than leaving the row blank', () => {
    const results = accessFor('nobody@example.com', []);

    expect(results.map((result) => result.target)).toEqual(['telemetry', 'billing']);
    expect(results.every((result) => result.state === 'not-checked')).toBe(true);
  });

  /**
   * "Not checked" is not a problem to act on and must not be drawn as one. The
   * badge that means "somebody has to do something" is reserved for a refusal,
   * because a warning on every first paint is a warning nobody reads.
   */
  it.each<[AccessState, boolean]>([
    ['refused', true],
    ['not-checked', false],
    ['not-configured', false],
    ['granted', false],
    ['already-held', false],
  ])('%s needs attention: %s', (state, expected) => {
    expect(needsAttention(state)).toBe(expected);
  });
});

describe('a refused grant says what it is and what to run', () => {
  it('prints the state, the reason, the authority needed and the statement', () => {
    const rendered = text(rows({
        entries: [added('pat@example.com', 'sam@example.com')],
        access: [{ email: 'pat@example.com', results: [GRANTED, REFUSED] }],
      }),
    );

    expect(rendered).toContain('Billing tables');
    expect(rendered).toContain('Not granted');
    expect(rendered).toContain('The role was granted.');
    expect(rendered).toContain('needs a metastore administrator');
    // The object, the privilege and a statement somebody with authority runs, in
    // the same copyable panel Connections uses for the same kind of refusal.
    expect(rendered).toContain('GRANT SELECT ON TABLE system.billing.usage');
  });

  it('offers the statement as one selectable block with a copy button', () => {
    const markup = rows({
      entries: [added('pat@example.com', 'sam@example.com')],
      access: [{ email: 'pat@example.com', results: [REFUSED] }],
    });

    expect(markup).toContain('connections-code');
    expect(markup).toContain('aria-label="Grant SELECT on system.billing.usage"');
    expect(text(markup)).toContain('Copy');
  });

  /**
   * The left edge, not a wash. It reads in one glance without hovering, it
   * survives a greyscale screenshot, and it does not tint the block of SQL a
   * reader is about to select.
   */
  it('marks the refused row so it reads at a glance and without colour', () => {
    const markup = rows({
      entries: [added('pat@example.com', 'sam@example.com')],
      access: [{ email: 'pat@example.com', results: [GRANTED, REFUSED] }],
    });

    expect(markup).toContain('admin-access admin-access-attention');
    // The granted row beside it is not marked, so the mark means something.
    expect(markup).toMatch(/class="admin-access"/);
    expect(partial('settings.css')).toMatch(/\.admin-access-attention \{\s*border-left:/);
  });

  /** Every state has a word. A colour on its own is nothing to a reader who cannot see it. */
  it.each<[AccessState, string]>([
    ['granted', 'Granted'],
    ['already-held', 'Already held'],
    ['refused', 'Not granted'],
    ['not-configured', 'Not set up'],
    ['not-checked', 'Not checked'],
  ])('%s reads as "%s"', (state, word) => {
    expect(stateWord(state)).toBe(word);
  });
});

describe('access somebody already held is not access this app granted', () => {
  /**
   * The distinction that decides what happens on removal. A person who held read
   * access for an unrelated reason keeps it when the role goes, so the row must
   * not say this app granted it.
   */
  it('says it was already held rather than granted', () => {
    const rendered = text(rows({
        entries: [added('pat@example.com', 'sam@example.com')],
        access: [{ email: 'pat@example.com', results: [ALREADY_HELD] }],
      }),
    );

    expect(rendered).toContain('Telemetry schema');
    expect(rendered).toContain('Already held');
    expect(rendered).not.toContain('Granted');
  });

  /**
   * This used to assert the sentence "Nothing was changed.", which is the thing
   * that had to go: it was printed under every target of every person, so the card
   * spent two lines per row saying nothing about that row. The state word beside a
   * spelled-out object name is the fact, and the removal rule the sentence carried
   * is stated once for the card instead.
   */
  it('prints no explanatory sentence, because the word and the name are the fact', () => {
    const rendered = text(rows({
        entries: [added('pat@example.com', 'sam@example.com')],
        access: [{ email: 'pat@example.com', results: [ALREADY_HELD, { ...ALREADY_HELD, target: 'billing' }] }],
      }),
    );

    expect(rendered).not.toContain('Nothing changed');
    expect(rendered).not.toContain('removal will not take it away');
    // Said once for the whole card rather than once per row, which is the half of
    // the old sentence that was worth keeping.
    expect(rendered.match(/is left alone/g) ?? []).toHaveLength(0);
  });
});

describe('a row names the objects it is about, resolved at runtime', () => {
  /**
   * The bug Sam reported: "showing this in the deployment is useless I should be
   * able to see what these schemas are". The row said "Telemetry schema / Already
   * held" and named nothing, so a reader could not check the access, could not go
   * and look at the data, and could not tell what the row was about.
   */
  it('spells out the telemetry destination', () => {
    const rendered = text(rows({
        entries: [seed('sam@example.com')],
        access: [{ email: 'sam@example.com', results: [ALREADY_HELD] }],
      }),
    );

    expect(rendered).toContain(TELEMETRY_SCHEMA);
  });

  it('names both billing tables rather than the phrase Billing tables alone', () => {
    const rendered = text(rows({
        entries: [seed('sam@example.com')],
        access: [{ email: 'sam@example.com', results: [REFUSED] }],
      }),
    );

    expect(rendered).toContain('system.billing.usage');
    expect(rendered).toContain('system.billing.list_prices');
  });

  it('sets object names in mono, as the app sets every identifier', () => {
    const markup = rows({
      entries: [seed('sam@example.com')],
      access: [{ email: 'sam@example.com', results: [ALREADY_HELD] }],
    });

    expect(markup).toContain(`<code class="admin-access-object-name" title="${TELEMETRY_SCHEMA}">${TELEMETRY_SCHEMA}</code>`);
    // Both halves of the claim. A static render has no computed styles, so the
    // element carrying the class is one assertion and the class carrying the font
    // is the other -- and the second is the one that would rot silently if somebody
    // renamed the rule.
    expect(partial('settings.css')).toMatch(/\.admin-access-object-name \{[^}]*font-family: var\(--font-mono\)/);
  });

  /**
   * A refusal keeps everything it had. Naming the objects is an addition to the
   * row, not a replacement for the statement somebody with authority runs, and
   * collapsing the states to fit a tidier layout was the thing not to do.
   */
  it('keeps the copyable statement and the authority note on a refusal', () => {
    const rendered = text(rows({
        entries: [seed('sam@example.com')],
        access: [{ email: 'sam@example.com', results: [REFUSED] }],
      }),
    );

    expect(rendered).toContain('Billing tables');
    expect(rendered).toContain('Not granted');
    expect(rendered).toContain('GRANT SELECT ON TABLE system.billing.usage');
    expect(rendered).toContain('needs a metastore administrator');
  });

  /**
   * The customer-target case. There IS no destination, so there is no name, and
   * the row has to read as not set up rather than showing a blank or an invented
   * one. The invented one is the real hazard: it would be a catalog name in the
   * published tree.
   */
  /**
   * The failure this guards is silent. `OpenInDatabricks` refuses to guess a link,
   * so a schema routed through the table branch produces no anchor at all: no
   * error, nothing on screen, and no way to tell from reading the JSX that a link
   * was ever meant to be there. The reader would just never get one on the row Sam
   * asked to be able to open.
   */
  it('links a schema at its own two-level path rather than as a table', () => {
    const host = 'https://a-workspace.example.invalid';

    expect(databricksLink(host, linkTargetFor({ name: TELEMETRY_SCHEMA, kind: 'schema' }))).toBe(
      `${host}/explore/data/a_catalog/a_telemetry_schema`
    );
    // What it would have been, had the kind been ignored.
    expect(databricksLink(host, { kind: 'table', table: TELEMETRY_SCHEMA })).toBeNull();
  });

  it('links a billing table at its three-level path', () => {
    const host = 'https://a-workspace.example.invalid';

    expect(databricksLink(host, linkTargetFor({ name: 'system.billing.usage', kind: 'table' }))).toBe(
      `${host}/explore/data/system/billing/usage`
    );
  });

  it('offers no link at all when the deployment has no workspace host', () => {
    // The supported state the whole link module is built around. The name is still
    // printed; the row simply does not claim to be able to open it.
    expect(databricksLink('', linkTargetFor({ name: TELEMETRY_SCHEMA, kind: 'schema' }))).toBeNull();
  });

  it('reads as not set up when no telemetry destination is configured', () => {
    const markup = rows({
      entries: [seed('sam@example.com')],
      access: [{ email: 'sam@example.com', results: [NOT_CONFIGURED] }],
    });
    const rendered = text(markup);

    expect(rendered).toContain('Telemetry schema');
    expect(rendered).toContain('Not set up');
    expect(rendered).toContain('writes no app telemetry');
    expect(rendered).toContain('Nothing is wrong.');
    // No empty name element, which is what a blank would look like in the markup.
    expect(markup).not.toContain('admin-access-object-name');
    expect(markup).not.toContain('Open in Databricks');
  });
});

describe('where a row came from decides what may be done to it', () => {
  it('offers Remove on an added row and no button at all on a seed row', () => {
    const markup = rows({ entries: [seed('sam@example.com'), added('pat@example.com', 'sam@example.com')] });

    expect(markup).toContain('aria-label="Remove pat@example.com"');
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
    const visible = text(rows({
        entries: [added('pat@example.com', 'sam@example.com')],
        access: [{ email: 'pat@example.com', results: [GRANTED, REFUSED] }],
      }),
    );

    expect(visible).not.toContain('\u2014');
    expect(stateWord('refused')).not.toContain('\u2014');
  });

  /**
   * The reconcile is a POST, and the editor calls it on load. That is the whole
   * answer to "administrators set at deployment never pass through Add": their
   * grants are brought up to date whenever somebody opens this card. A GET must
   * not make grants, which is why it is a second call and not part of the read.
   */
  it('reconciles with a POST on load rather than inside the read', () => {
    expect(editor).toMatch(/fetch\('\/api\/admins\/access', \{ method: 'POST' \}\)/);
    expect(editor).not.toMatch(/fetch\('\/api\/admins\/access'\)/);
  });

  /**
   * The success line says the role landed and points at the rows for the access.
   * It must not claim the access, because it does not know: the refusal is per
   * target and lives on the row.
   */
  it('reports the add as the role only, and sends the reader to the rows', () => {
    expect(editor).toContain('is now an administrator. Their access is below.');
    expect(editor).not.toMatch(/now an administrator with (?:full )?access/);
  });

  it('uses the exact #24a behavior caption and add roles', () => {
    expect(roles).toContain(
      'Adding grants the role and requests the Unity Catalog access the role needs, under your own permissions.'
    );
    expect(roles).toMatch(/A\s+refused grant still grants the role; the row says what is missing\./);
    expect(roles).toContain('Access marked Already held is left alone.');
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
});
