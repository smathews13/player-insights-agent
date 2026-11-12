import { describe, expect, it } from 'vitest';
import { caveatScope, emphasiseFigures } from './caveat-emphasis';

/**
 * What is set apart inside a caveat, and — the half that matters more — what is
 * left exactly as the agent wrote it.
 *
 * The Keep in mind section is a block of amber prose in which everything weighs
 * the same, which is what a reader said about it: to find which table a warning
 * is about, or how big "understated" turned out to be, they had to read every
 * bullet to the end. Bolding the numbers and tagging the table is the answer to
 * that, and it is also the first thing in this card that TOUCHES a disclosure
 * on its way to the screen. So the round trip below is the load-bearing test in
 * the file: the runs must concatenate back to the caveat, character for
 * character, whatever the regex did or failed to do.
 */

const CAVEATS = [
  'Only 19 of the 30 calendar days have records; the remaining 11 days may be unpopulated or ' +
    'outside the table’s in-scope activity window, which could understate averages.',
  'Matched on player_id for ~2,833 rows (1.81% of the table), so the remainder are unattributed.',
  'This answer was produced as analyst@example.com and covers only the data that identity is granted.',
  'Totals are cumulative player-days, not unique players across the period.',
  'active_players is not additive across labels; the value in gold_title_daily_summary_v2 is a daily count.',
  'Records begin 2026-02-06 and the 2026 season is partially covered.',
  'Meridian Drift and Harbor City Nights are omitted from figures due to the 6-figure limit.',
];

/** The bold runs of a caveat, in order. */
function figures(caveat: string): string[] {
  return emphasiseFigures(caveat)
    .filter((run) => run.figure)
    .map((run) => run.text);
}

describe('cutting a caveat into runs', () => {
  it('puts the caveat back together exactly, every time', () => {
    // The property the whole feature rests on. A disclosure may be drawn
    // differently; it may not be reworded, truncated or reordered, and a
    // renderer that lost a character to an off-by-one in the slicing would lose
    // it silently in the middle of a governance sentence.
    for (const caveat of CAVEATS) {
      expect(
        emphasiseFigures(caveat)
          .map((run) => run.text)
          .join(''),
        caveat
      ).toBe(caveat);
    }
  });

  it('hands back one plain run when there is no number in the sentence', () => {
    // The common case costs one element and reads identically to the untreated
    // text, which is what keeps the bullet a bullet rather than a chain of spans.
    const runs = emphasiseFigures('Totals are cumulative player-days, not unique players across the period.');

    expect(runs).toHaveLength(1);
    expect(runs[0].figure).toBeUndefined();
  });

  it('hands back nothing at all for an empty caveat', () => {
    expect(emphasiseFigures('')).toEqual([]);
  });

  it('gives every run a distinct key, so the list does not reuse one', () => {
    const runs = emphasiseFigures(CAVEATS[1]);

    expect(new Set(runs.map((run) => run.start)).size).toBe(runs.length);
  });
});

describe('what counts as a figure', () => {
  it('finds the counts a coverage caveat is actually about', () => {
    expect(figures(CAVEATS[0])).toEqual(['19', '30', '11']);
  });

  it('finds an approximation, a thousands separator and a percentage', () => {
    // All three are how the agent writes a quantity, and the percentage is the
    // one a reader is scanning for: "1.81% of the table" is the size of the
    // problem the sentence is disclosing.
    expect(figures(CAVEATS[1])).toEqual(['~2,833', '1.81%']);
  });

  it('finds a threshold written against a word', () => {
    expect(figures(CAVEATS[6])).toEqual(['6']);
  });

  it('leaves the digits inside an identifier alone', () => {
    // `gold_title_daily_summary_v2` is one name. Bolding the 2 in it would put
    // a weight change in the middle of a table name, which is the one kind of
    // string in this card a reader compares character by character.
    expect(figures(CAVEATS[4])).toEqual([]);
  });

  it('leaves a date at regular weight, both as a date and as a bare year', () => {
    // An ISO date offers three matches and bolding two would print
    // "2026-**02**-**06**". A bare year has nothing in the string to
    // distinguish it from a count, so the range is the distinguisher.
    expect(figures(CAVEATS[5])).toEqual([]);
  });

  it('still bolds a four-digit count that is plainly not a year', () => {
    // The cost of the year rule, kept as small as it can be: a separator, a
    // decimal or a percent all take a number back out of it.
    expect(figures('The join dropped 2,026 rows and 1996.5 player-days, or 2026% of the sample.')).toEqual([
      '2,026',
      '1996.5',
      '2026%',
    ]);
  });

  it('does not treat an email address or a version as a quantity', () => {
    expect(figures(CAVEATS[2])).toEqual([]);
  });
});

describe('the table a caveat is about', () => {
  const SUMMARY = { name: 'main.player_insights.gold_title_daily_summary' };
  const SPEND = { name: 'main.player_insights.gold_spend_daily' };

  it('tags a caveat that names exactly one of the answer’s tables', () => {
    // The short name, because the catalog and schema are the same on every row
    // and the module has already said them in full directly above.
    expect(caveatScope('gold_title_daily_summary counts a player once per day.', [SUMMARY, SPEND])).toBe(
      'gold_title_daily_summary'
    );
  });

  it('recognises the fully qualified spelling as the same table', () => {
    expect(caveatScope('Rows in main.player_insights.gold_spend_daily are pre-refund.', [SUMMARY, SPEND])).toBe(
      'gold_spend_daily'
    );
  });

  it('refuses to tag a caveat that names two of them', () => {
    // A comparison is not scoped to either side, and tagging it with whichever
    // was named first would be this surface deciding which half mattered.
    expect(caveatScope('gold_title_daily_summary and gold_spend_daily disagree on the window.', [SUMMARY, SPEND])).toBe(
      ''
    );
  });

  it('leaves a run-level caveat untagged', () => {
    // Identity, coverage, masking: these are about the answer, not a table, and
    // a tag on one would attach a governance warning to a single row of a list.
    expect(caveatScope('Totals are cumulative player-days, not unique players.', [SUMMARY, SPEND])).toBe('');
  });

  it('does not tag a table the answer never declared', () => {
    // The tag says "this warning is about that row up there". A name the module
    // is not drawing has no row to point at.
    expect(caveatScope('gold_spend_daily is pre-refund.', [SUMMARY])).toBe('');
  });

  it('does not find a table inside a longer name', () => {
    // `gold_spend_daily` is not in `gold_spend_daily_summary`, and the boundary
    // rule that settles it is the app's own rather than a second copy of it.
    expect(caveatScope('gold_spend_daily_summary is rebuilt nightly.', [SPEND])).toBe('');
  });

  it('tags nothing when the answer cited no tables', () => {
    expect(caveatScope('gold_spend_daily is pre-refund.', [])).toBe('');
  });
});
