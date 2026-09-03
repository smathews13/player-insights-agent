import { describe, expect, it } from 'vitest';
import { sourceFacts, sourceRows, splitSourceName } from './source-rows';
import type { SourceRef } from './answer-shape';

/**
 * Which tables a row is drawn for, and what its chip is allowed to say.
 *
 * The two defects behind this file are one defect seen twice. An answer
 * comparing recurrent spending with net bookings showed a single source -- the
 * data dictionary the agent had looked the two terms up in -- and the tables
 * the figures actually came from were nowhere on screen. Both surfaces rendered
 * `sources[0]`, and the list arrives in the order the run read them, so the
 * lookup that ran first was the one thing a reader saw. Naming all of them
 * fixes half of it: the dictionary is a source of the ANSWER and not a source
 * of its NUMBERS, and a list that presents the two identically is a shorter way
 * of making the same false claim.
 *
 * So the ordering, the deduplication and the chip vocabulary live here, away
 * from the renderer, and the rule the file exists to hold is in its header: a
 * role is stated or it is not, and nothing here infers one.
 */

const DICTIONARY = 'main.player_insights.data_dictionary';
const SUMMARY = 'main.player_insights.gold_title_daily_summary';
const SPEND = 'main.player_insights.gold_spend_daily';

function ref(name: string, role?: SourceRef['role'], freshness?: string): SourceRef {
  return { name, ...(role ? { role } : {}), ...(freshness ? { freshness } : {}) } as SourceRef;
}

describe('splitting a name into the part a reader recognises', () => {
  it('cuts at the last dot, keeping the trailing dot with the qualifier', () => {
    // The qualifier keeps its dot so the two spans concatenate back to the name
    // exactly. A reader copies this out of the row to paste into a query.
    expect(splitSourceName(SUMMARY)).toEqual({
      qualifier: 'main.player_insights.',
      short: 'gold_title_daily_summary',
    });
  });

  it('treats a bare table name as all short name and no qualifier', () => {
    // Answers from before the agent qualified its names, and views cited by one
    // segment. There is nothing recessive to draw, and inventing a catalog to
    // put in front would be the surface stating something it does not know.
    expect(splitSourceName('gold_spend_daily')).toEqual({ qualifier: '', short: 'gold_spend_daily' });
  });
});

describe('the rows a list of declared sources becomes', () => {
  it('keeps every table, in the order the run read them', () => {
    const rows = sourceRows([ref(DICTIONARY, 'reference'), ref(SUMMARY, 'reading'), ref(SPEND, 'reading')]);

    expect(rows.map((row) => row.name)).toEqual([DICTIONARY, SUMMARY, SPEND]);
  });

  it('distinguishes a table the figures came from from one read for definitions', () => {
    const [dictionary, summary] = sourceRows([ref(DICTIONARY, 'reference'), ref(SUMMARY, 'reading')]);

    expect(dictionary.chip).toBe('Definition validation');
    expect(dictionary.tone).toBe('neutral');
    expect(summary.chip).toBe('Queried for the figures');
    expect(summary.tone).toBe('queried');
  });

  it('says the role was not recorded rather than guessing which it was', () => {
    // Every answer stored before the agent began publishing a role, which is
    // most of the store. The two available labels are both claims about where
    // the numbers came from, and this surface cannot tell -- so it says so, and
    // the row is drawn in the neutral treatment rather than the queried one.
    const [row] = sourceRows([ref(SUMMARY)]);

    expect(row.chip).toBe('Role not recorded');
    expect(row.tone).toBe('neutral');
    expect(row.note).toBe('This answer does not record whether the figures came from this table.');
  });

  it('gives a table one row when the run both looked it up and queried it', () => {
    // The wire carries it twice, legitimately. Two rows is two claims about one
    // table, in two different treatments, and a reader who reads the first one
    // stops.
    const rows = sourceRows([ref(SUMMARY, 'reference'), ref(SUMMARY, 'reading')]);

    expect(rows).toHaveLength(1);
    // The stronger claim survives: the reader's question is which tables the
    // numbers came from, and "also read for definitions" does not change it.
    expect(rows[0].chip).toBe('Queried for the figures');
  });

  it('collapses onto the first position rather than the last', () => {
    // Order is the order the run read them, and a table's position is when it
    // was first read. A duplicate moving its own row down the list would
    // reorder the history the list is reporting.
    const rows = sourceRows([ref(SUMMARY, 'reference'), ref(SPEND, 'reading'), ref(SUMMARY, 'reading')]);

    expect(rows.map((row) => row.name)).toEqual([SUMMARY, SPEND]);
  });

  it('matches names case-insensitively but keeps the answer’s own spelling', () => {
    // Unity Catalog identifiers are case-insensitive, so two spellings are one
    // table and must not be two rows. The spelling kept is the first one the
    // answer used, because this list is what a reader compares against the name
    // in the prose above it.
    const rows = sourceRows([ref(SUMMARY, 'reading'), ref(SUMMARY.toUpperCase(), 'reading')]);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(SUMMARY);
  });

  it('takes the freshness from whichever entry stated one', () => {
    // Same table, so the server had one thing to say about it; an entry without
    // a freshness must not blank the one that had it.
    const [row] = sourceRows([ref(SUMMARY, 'reference'), ref(SUMMARY, 'reading', 'Updated daily')]);

    expect(row.freshness).toBe('Updated daily');
  });

  it('leaves the freshness empty rather than inventing one', () => {
    expect(sourceRows([ref(SUMMARY, 'reading')])[0].freshness).toBe('');
  });

  it('drops an entry with no name at all', () => {
    // A blank row is a row a reader cannot act on, and it would still be
    // counted in the header's "N tables".
    expect(sourceRows([ref('   '), ref(SUMMARY, 'reading')]).map((row) => row.name)).toEqual([SUMMARY]);
  });
});

describe('the count in the header, which is the whole of what it says', () => {
  it('counts the tables and states nothing about them', () => {
    // It used to read "N tables · governed Unity Catalog · read during this
    // run", which was the strip's per-row line collapsed into one place rather
    // than removed. The detail spec removes it: the Unity Catalog mark beside
    // the heading says which product these are, and a Sources module under an
    // answer says the run read them, so both clauses were the interface
    // explaining itself.
    expect(sourceFacts(sourceRows([ref(SUMMARY, 'reading')]))).toBe('1 table');
    expect(sourceFacts(sourceRows([ref(SUMMARY, 'reading'), ref(SPEND, 'reading')]))).toBe('2 tables');
  });

  it('counts rows rather than declarations, so a duplicate is not counted twice', () => {
    expect(sourceFacts(sourceRows([ref(SUMMARY, 'reference'), ref(SUMMARY, 'reading')]))).toBe('1 table');
  });

  it('says nothing rather than "0 tables" when the answer declared none', () => {
    // A module drawn for its caveats alone is making no claim about tables.
    // "0 tables" is a claim, and next to a Caveats section it reads as one
    // about the answer's provenance.
    expect(sourceFacts([])).toBe('');
  });
});
