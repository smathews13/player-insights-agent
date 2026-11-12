/**
 * What the app is allowed to say about personal information.
 *
 * ── THE CLAIM THESE TESTS DEFEND ──
 *
 * There is no answer meaning "contains no personal data", and every route to one
 * is closed. That is the whole of it. A detector that guesses from values would
 * be wrong in both directions and, far worse, would be BELIEVED: a green tick
 * from an automated scan reads as a clearance, and the person it most reassures
 * is the one who most needs to be careful.
 *
 * So the assertions below are mostly about what does NOT happen. A refused read
 * does not become "not classified". An empty result from a catalog the reader
 * cannot see into does not become a clean bill. A name that cannot be safely put
 * in a statement is reported rather than skipped. Each of those is a way for a
 * silence to be read as a finding.
 *
 * Every catalog, schema, table and column name here is invented.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classificationStatements,
  classifyTables,
  CLASSIFY_TABLE_LIMIT,
  nameParts,
  NO_TOKEN_REASON,
} from './egress-classification';
import { CLASSIFICATION_LABEL, CLASSIFICATION_TONE } from '../../shared/egress-contract';
import type { SqlOutcome, SqlRunner } from './admin-access';

const TABLE = 'ledger_demo.play_events.session_summary';

/**
 * A runner that answers each of the three reads from a script.
 *
 * Keyed on the view the statement names rather than on its text, for the reason
 * the rest of this suite gives: matching a SQL string proves the string somebody
 * wrote is the string somebody wrote.
 */
function runner(script: {
  tags?: string[][] | 'refused';
  masks?: string[][] | 'refused';
  filters?: string[][] | 'refused';
}): SqlRunner & { statements: string[] } {
  const statements: string[] = [];
  const answer = (rows: string[][] | 'refused' | undefined): SqlOutcome =>
    rows === 'refused' ? { ok: false, message: 'permission denied' } : { ok: true, rows: rows ?? [] };
  const run = (statement: string) => {
    statements.push(statement);
    if (statement.includes('column_tags')) return Promise.resolve(answer(script.tags));
    if (statement.includes('column_masks')) return Promise.resolve(answer(script.masks));
    return Promise.resolve(answer(script.filters));
  };
  return Object.assign(run, { statements });
}

describe('the words this capability is allowed to use', () => {
  /**
   * Pinned as a string comparison rather than described in prose, because the
   * failure this guards against is somebody softening one word at one call site.
   */
  it('has no state meaning the data is clean', () => {
    const words = Object.values(CLASSIFICATION_LABEL).join(' ').toLowerCase();
    for (const forbidden of ['no personal', 'clean', 'safe', 'clear', 'none found', 'no pii']) {
      expect(words, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * A green chip on a table nobody has classified is the panel awarding a
   * clearance it has no grounds for. Neutral, and never positive.
   */
  it('renders an unclassified table in a neutral chip rather than a positive one', () => {
    expect(CLASSIFICATION_TONE['not-classified']).toBe('neutral');
    expect(CLASSIFICATION_TONE['not-checked']).toBe('warn');
  });
});

describe('asking the catalog', () => {
  it('reports a tagged column as classified, by tag name', async () => {
    const { classifications } = await classifyTables(
      runner({ tags: [['play_events', 'session_summary', 'player_ref', 'sensitivity']] }),
      [TABLE]
    );
    expect(classifications[0].state).toBe('classified');
    expect(classifications[0].columns).toEqual([{ column: 'player_ref', tags: ['sensitivity'], masked: false }]);
  });

  /**
   * A tag VALUE is a string from the customer's own taxonomy and can itself be
   * sensitive. The question the panel answers is whether the column is governed,
   * which the name settles, so the value is never asked for.
   */
  it('asks for tag names and never for tag values', () => {
    const statements = classificationStatements('ledger_demo', ['play_events'], ['session_summary']);
    expect(statements.tags).toContain('tag_name');
    expect(statements.tags).not.toContain('tag_value');
  });

  it('reports a masked column and a row filter as classified', async () => {
    const { classifications } = await classifyTables(
      runner({
        masks: [['play_events', 'session_summary', 'contact_ref']],
        filters: [['play_events', 'session_summary']],
      }),
      [TABLE]
    );
    expect(classifications[0].state).toBe('classified');
    expect(classifications[0].rowFilter).toBe(true);
    expect(classifications[0].columns[0].masked).toBe(true);
  });

  /**
   * The one place a negative is asserted, and it is asserted about the CATALOG.
   * An untagged table full of names is untagged, and this app has no way to know
   * it is full of names.
   */
  it('reports a table the catalog says nothing about as not classified', async () => {
    const { classifications } = await classifyTables(runner({}), [TABLE]);
    expect(classifications[0].state).toBe('not-classified');
    expect(classifications[0].rowFilter).toBe(false);
  });
});

describe('the failures, which must not read as findings', () => {
  it('reports a refused read as not checked rather than as not classified', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { classifications } = await classifyTables(runner({ tags: 'refused' }), [TABLE]);
    expect(classifications[0].state).toBe('not-checked');
    // Never false. False is the claim that there is no filter, which a read that
    // did not happen cannot support.
    expect(classifications[0].rowFilter).toBeNull();
  });

  /**
   * The three reads fail independently and a reader can hold privileges on one
   * view and not another. Reporting "not classified" on the strength of an empty
   * masks result, while the tags read was refused, is exactly the clearance this
   * file exists not to give.
   */
  it('does not let one answered read speak for a refused one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { classifications } = await classifyTables(runner({ tags: 'refused', masks: [], filters: [] }), [TABLE]);
    expect(classifications[0].state).toBe('not-checked');
  });

  /**
   * No forwarded token means the question was not asked. It does NOT mean fall
   * back to the app's own credential: three service-principal read paths were
   * deliberately closed and this is not the fourth.
   */
  it('reports every table as not checked when there is no runner, and says why', async () => {
    const { classifications, blocked } = await classifyTables(null, [TABLE]);
    expect(classifications[0].state).toBe('not-checked');
    expect(classifications[0].notChecked).toBe(NO_TOKEN_REASON);
    expect(blocked).toBe(NO_TOKEN_REASON);
  });

  it('reports a name it cannot put in a statement rather than skipping it', async () => {
    const { classifications } = await classifyTables(runner({}), ["ledger_demo.play'; DROP TABLE x--.t"]);
    expect(classifications).toHaveLength(1);
    expect(classifications[0].state).toBe('not-checked');
  });
});

describe('the shape a name has to have', () => {
  /**
   * These names reach a statement as literals, because the runner takes a
   * statement and no parameters. Escaping is the usual answer and the weaker one:
   * it leaves the accepted set open and rests on one function being right
   * forever. So the shape is enforced instead.
   */
  it('refuses anything that is not three plain identifier parts', () => {
    expect(nameParts('a.b.c')).toEqual({ catalog: 'a', schema: 'b', table: 'c' });
    for (const bad of ['a.b', 'a.b.c.d', "a.b.c'", 'a.b.c;--', 'a..c', '', 'a.b.`c`', 'a.b.c d']) {
      expect(nameParts(bad), bad).toBeNull();
    }
  });
});

describe('what one panel load costs', () => {
  /**
   * Three statements per catalog against a warehouse that may be cold. The panel
   * is a list of recent exports rather than a catalog browser, so a load naming
   * more tables than the ceiling classifies the first of them.
   */
  it('groups a catalog into three statements however many of its tables are asked about', async () => {
    const run = runner({});
    await classifyTables(run, [TABLE, 'ledger_demo.play_events.title_daily', 'ledger_demo.other.thing']);
    expect(run.statements).toHaveLength(3);
  });

  it('stops at the ceiling rather than classifying an unbounded list', async () => {
    const many = Array.from({ length: CLASSIFY_TABLE_LIMIT + 5 }, (_, index) => `c.s.t${index}`);
    const { classifications } = await classifyTables(runner({}), many);
    expect(classifications).toHaveLength(CLASSIFY_TABLE_LIMIT);
  });

  it('asks nothing at all when the deployment declares no tables', async () => {
    const run = runner({});
    const { classifications } = await classifyTables(run, []);
    expect(classifications).toHaveLength(0);
    expect(run.statements).toHaveLength(0);
  });
});
