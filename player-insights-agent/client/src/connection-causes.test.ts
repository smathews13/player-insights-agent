import { describe, expect, it } from 'vitest';

import {
  affectedLabel,
  causeGroupHeadline,
  causeKey,
  declaredTablesAside,
  groupByCause,
  rowStatusLine,
  sharedLabelPrefix,
} from './connection-causes';
import type { PreflightCheck } from './preflight';

/**
 * The grouping the "What to fix" panel is drawn from.
 *
 * WHAT IT IS FOR, in the words of the screen it replaced. One missing OAuth
 * scope stops twelve Unity Catalog table checks at the same instant, and the
 * panel drew one block per check: the same three-sentence diagnosis, the same
 * two-line remedy and the same "Why this is the fix" fold, twelve times,
 * verbatim. A reader crossed roughly forty lines of identical text and the one
 * fact they needed -- one permission, twelve objects -- was never stated at all.
 *
 * Asserted here rather than only through the markup because the interesting
 * claims are about WHICH checks belong together, and two of them are refusals
 * the page is forbidden from collapsing: a check that was refused and a check
 * that never got far enough to be refused are different claims with different
 * next actions (DECISIONS.md D6, D8), and one explanation may not be printed
 * over a row whose evidence does not support it (D10).
 */

const FRESH_SIGN_IN = {
  kind: 'ui' as const,
  statement: 'Open this app again in a private browsing window, and sign in there.',
  guidance: 'Signing out of Databricks does not clear this app\u2019s sign-in.',
};

const SCOPE_DIAGNOSIS =
  'HTTP 403. Your sign-in to this app does not carry `catalog.tables:read`, which the app asks ' +
  'for. The call stopped there, so nothing was established about whether you can reach the object. ' +
  'This is not a grant you are missing.';

function check(id: string, over: Partial<PreflightCheck> = {}): PreflightCheck {
  return {
    id,
    kind: 'dependency',
    name: '',
    label: id,
    status: 'unverified',
    detail: '',
    checked_with: '',
    duration_ms: 0,
    error: '',
    remedy: null,
    ...over,
  };
}

/** The twelve tables of the live deployment, all stopped by one missing scope. */
function refusedTables(count: number): PreflightCheck[] {
  return Array.from({ length: count }, (_unused, index) =>
    check(`table:a_catalog.a_schema.gold_table_${index}`, {
      kind: 'table',
      name: `a_catalog.a_schema.gold_table_${index}`,
      label: `a_catalog.a_schema.gold_table_${index}`,
      status: 'unverified',
      detail: SCOPE_DIAGNOSIS,
      error: 'HTTP 403',
      remedy: FRESH_SIGN_IN,
    })
  );
}

describe('collecting the blocked checks by cause', () => {
  /**
   * THE DEFECT, as arithmetic. Twelve checks, one block. Anything that puts the
   * explanation back on the individual check makes this twelve again.
   */
  it('puts twelve checks stopped by one permission into one block', () => {
    const groups = groupByCause(refusedTables(12));
    expect(groups).toHaveLength(1);
    expect(groups[0].checks).toHaveLength(12);
    expect(groups[0].detail).toBe(SCOPE_DIAGNOSIS);
    expect(groups[0].remedy).toBe(FRESH_SIGN_IN);
  });

  /**
   * The count is the fact the old panel never stated, so the group has to lead
   * with it rather than leaving a reader to count blocks.
   */
  it('leads a group of several with how many objects are in it', () => {
    expect(causeGroupHeadline(groupByCause(refusedTables(12))[0])).toContain('12');
  });

  /**
   * A group of one is a single blocked dependency and says so in its own name.
   * The page got this right before any grouping existed and must keep getting it
   * right: "1 checks, stopped for the same reason" over one row would be a
   * summary of nothing.
   */
  it('names a lone check by its own label rather than counting it', () => {
    const groups = groupByCause([check('sql-warehouse', { label: 'SQL warehouse', detail: 'Refused.' })]);
    expect(causeGroupHeadline(groups[0])).toBe('SQL warehouse');
    expect(causeGroupHeadline(groups[0])).not.toMatch(/\breason\b/);
  });

  /**
   * DECISIONS.md D8 and D6, as a grouping rule. A scope refusal is reported
   * `unverified` precisely because the call stopped before it established
   * anything about the object; a `failed` check is a workspace refusing a call
   * that reached the object. A group states ONE status for every member, so
   * collapsing these two would print "Blocked" over checks that never got there.
   */
  it('never puts a check that was refused in with a check that was not reached', () => {
    const groups = groupByCause([
      check('a', { status: 'failed', detail: 'The same words.', remedy: null }),
      check('b', { status: 'unverified', detail: 'The same words.', remedy: null }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.status)).toEqual(['failed', 'unverified']);
  });

  /**
   * D10, as a grouping rule. The group prints ONE explanation, so two checks
   * refused over different permissions must not share a block: the surviving
   * sentence would name a permission that one of them was not refused over,
   * which is a diagnosis asserting a cause its own evidence does not support.
   */
  it('keeps two different diagnoses in two blocks even when the remedy is the same', () => {
    const groups = groupByCause([
      check('catalog', { detail: 'Your sign-in does not carry `catalog.catalogs:read`.', remedy: FRESH_SIGN_IN }),
      check('schema', { detail: 'Your sign-in does not carry `catalog.schemas:read`.', remedy: FRESH_SIGN_IN }),
    ]);
    expect(groups).toHaveLength(2);
  });

  /**
   * And the converse, which is the case that put an eleven-line shell snippet on
   * screen twice: one remedy per distinct remedy, so two checks sharing a
   * diagnosis but needing different actions stay apart.
   */
  it('keeps two different remedies in two blocks even when the diagnosis is the same', () => {
    const groups = groupByCause([
      check('a', { detail: 'One sentence.', remedy: FRESH_SIGN_IN }),
      check('b', {
        detail: 'One sentence.',
        remedy: { kind: 'cli', statement: 'databricks apps stop x', guidance: '' },
      }),
    ]);
    expect(groups).toHaveLength(2);
  });

  /**
   * The guidance is part of the remedy's identity, and it matters more now that
   * it is drawn. It is the line saying what a reader needs in order to do the
   * statement correctly, so printing one group's line over another group's
   * objects tells some of them to do something that is not true of them.
   */
  it('treats two remedies that differ only in their guidance as two remedies', () => {
    const a = check('a', {
      detail: 'Same.',
      remedy: { kind: 'ui', statement: 'Do this.', guidance: 'You also need the thing.' },
    });
    const b = check('b', {
      detail: 'Same.',
      remedy: { kind: 'ui', statement: 'Do this.', guidance: '' },
    });
    expect(causeKey(a)).not.toBe(causeKey(b));
  });

  /** The report's order is the reader's order, within a group and between them. */
  it('keeps the order the report listed the checks in', () => {
    const groups = groupByCause([
      check('first', { detail: 'A.' }),
      check('second', { detail: 'B.' }),
      check('third', { detail: 'A.' }),
    ]);
    expect(groups.map((group) => group.checks.map((member) => member.id))).toEqual([['first', 'third'], ['second']]);
  });
});

describe('the affected list', () => {
  /**
   * Twelve three-part names are twelve copies of one catalog and one schema. The
   * shared part is stated once above the list, which is the same redundancy the
   * grouping exists to remove, one level down.
   */
  it('finds the catalog and schema that every affected table shares', () => {
    const labels = refusedTables(3).map((member) => member.label);
    expect(sharedLabelPrefix(labels)).toBe('a_catalog.a_schema');
    expect(affectedLabel(labels[0], 'a_catalog.a_schema')).toBe('gold_table_0');
  });

  /**
   * Never the whole label. A group whose members carry the same label must still
   * list something for each of them rather than collapsing to a row of blanks.
   */
  it('always leaves a name behind when the labels are identical', () => {
    expect(sharedLabelPrefix(['a.b.c', 'a.b.c'])).toBe('a.b');
    expect(affectedLabel('a.b.c', 'a.b')).toBe('c');
  });

  it('shares nothing when the names have nothing in common', () => {
    expect(sharedLabelPrefix(['a_catalog.a_schema.t', 'other.schema.t'])).toBe('');
    expect(sharedLabelPrefix(['SQL warehouse', 'Genie space'])).toBe('');
    expect(affectedLabel('SQL warehouse', '')).toBe('SQL warehouse');
  });
});

describe('what one row of the declared-tables matrix says', () => {
  /**
   * A STATUS, NOT AN ESSAY. The Detail cell printed each check's whole detail, so
   * opening that section on this deployment meant reading the same
   * three-sentence diagnosis twelve more times. The first sentence is the part
   * that is about THIS table.
   */
  it('cuts a row down to what the workspace said about that one table', () => {
    const row = check('t', {
      error: '',
      detail:
        'The workspace refused this identity: HTTP 403 PERMISSION_DENIED. Everything after this is the shared diagnosis.',
    });
    expect(rowStatusLine(row)).toBe('The workspace refused this identity: HTTP 403 PERMISSION_DENIED.');
  });

  /**
   * A dotted name is not the end of a sentence. A cut on the first full stop
   * would end this row at "The workspace answered: 17 columns" for one table and
   * mid-identifier for the next.
   */
  it('does not mistake a scope name or a three-part table name for a sentence ending', () => {
    expect(
      rowStatusLine(
        check('t', { detail: 'Your sign-in does not carry `catalog.tables:read`, which the app asks for. And more.' })
      )
    ).toBe('Your sign-in does not carry `catalog.tables:read`, which the app asks for.');
    expect(rowStatusLine(check('t', { detail: 'a_catalog.a_schema.gold_x could not be read. And more.' }))).toBe(
      'a_catalog.a_schema.gold_x could not be read.'
    );
  });

  it('says the whole thing when the whole thing is one sentence', () => {
    expect(rowStatusLine(check('t', { detail: 'The workspace answered: 17 columns' }))).toBe(
      'The workspace answered: 17 columns'
    );
  });
});

describe('the declared-tables aside', () => {
  /**
   * D6 AND D8 IN ONE LINE, which is what this aside used to break. It read
   * `N blocked` over every check that was not `ok`, so the scope refusals -- not
   * checked, by their own verdict, because the call never reached the table --
   * were counted and labelled as blocked.
   */
  it('collapses every resolved non-success verdict into disconnected', () => {
    const aside = declaredTablesAside([
      check('a', { status: 'ok' }),
      check('b', { status: 'failed' }),
      check('c', { status: 'unverified' }),
      check('d', { status: 'unverified' }),
    ]);
    expect(aside).toContain('4 tables declared');
    expect(aside).toContain('3 disconnected');
    expect(aside).not.toMatch(/blocked|refused|unreachable|not checked/i);
  });

  /** A zero never renders, here or on the summary line above it. */
  it('says only how many tables were declared when every one of them answered', () => {
    expect(declaredTablesAside([check('a', { status: 'ok' }), check('b', { status: 'ok' })])).toBe('2 tables declared');
  });
});
