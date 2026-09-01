import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitCaveats } from './degraded-answer';

/**
 * Whether the caveats under an answer can be read at all.
 *
 * They were rendered as `ordinaryCaveats.join(' ')`, which on a real answer
 * produced one unbroken ~200-word paragraph holding nine unrelated
 * disclosures: who the answer ran as, that row filters and column masks had
 * silently narrowed it, that the data is synthetic, that 19 of 30 days had
 * records, that totals are player-days rather than players, that one column is
 * not additive, and two notes about titles held out of the figures. The
 * reported verdict was that it is impossible to read, and the governance ones
 * are the cost of that: identity and masking are the first two sentences, so
 * they are where a reader who skims a wall of text stops reading.
 *
 * The fix is a list, and the whole of it is presentational. The wire contract
 * is already `caveats: z.array(z.string())` and the agent already assembles
 * discrete items, so the browser had structure and was flattening it. What
 * this pins is that it keeps rendering that structure faithfully rather than
 * manufacturing a nicer-looking one: same count, same text, nothing invented and
 * nothing dropped.
 *
 * SAME ORDER IS NO LONGER AMONG THOSE, and that is a reversal worth stating
 * rather than quietly editing out. The list this file won got the second half of
 * the same report: ten equal bullets, and the two that mattered -- a governance
 * refusal and an incomplete source list -- read no more urgently than the two
 * saying the data is synthetic. So the bullets are now ordered by what they
 * threaten and folded at five. The constraint underneath is unchanged and is what
 * the assertions below still guard: the browser may decide the ORDER a reader
 * meets these in, and may not decide what any of them says or whether it is shown
 * at all.
 */

/**
 * The component that renders them, shared by Ask PIA and the Run Explorer's Final
 * answer tab. AnswerCard.tsx held this markup until the second surface needed it,
 * and it is now the footer zone of the Sources module rather than a panel of its
 * own -- the box was reported invisible for months, so the caveats were moved
 * onto the card a reader is already looking at when they ask where a number came
 * from. Everything this file pins is unchanged by that move.
 */
const PANEL_SOURCE = readFileSync(new URL('./KeepInMind.tsx', import.meta.url), 'utf8');

/**
 * The reported answer's caveats, with invented titles and an invented address.
 *
 * EIGHT ITEMS FOR NINE CAVEATS, which is the fact worth writing down. The agent
 * sends the coverage disclosure as one item carrying two sentences -- the
 * identity and the masking that silently narrows it -- so the list has eight
 * bullets and the first holds two of the nine. Splitting it into two bullets
 * would need the agent to send two items; the browser must not do it with a
 * sentence split.
 *
 * The synthetic-data line appears twice, from two producers. See below.
 */
const REPORTED_CAVEATS = [
  'This answer was produced as analyst@example.com and covers only the data that identity is ' +
    'granted. Unity Catalog row filters and column masks apply without reporting themselves, so ' +
    'figures here may be computed from a subset of the rows another reader would see.',
  'All player data behind these figures is synthetic and does not represent real player behavior.',
  'Only 19 of the 30 calendar days have records; the remaining 11 days may be unpopulated or ' +
    'outside the table’s in-scope activity window, which could understate averages.',
  'Totals are cumulative player-days, not unique players across the period.',
  'active_players is not additive across labels; figures here aggregate across labels and ' +
    'countries within each title, which the data dictionary flags as a guardrail to observe.',
  'Meridian Drift and Harbor City Nights are close in rank but omitted from figures due to the ' + '6-figure limit.',
  'Terrace Rally 27 and Ashfall Provinces are not shown in figures but are included in the ' + 'narrative.',
  'Player data in this deployment is synthetic and representative, not live production data.',
];

describe('the caveats under an answer', () => {
  it('is a list of one bullet per caveat, not a joined paragraph', () => {
    expect(PANEL_SOURCE).toContain('<ul className="answer-list keep-in-mind-list">');
    expect(PANEL_SOURCE).toContain('<CaveatBullet caveat={caveat} sources={sources}');
    // The whole of the defect. A `join` here is a paragraph however the rest of
    // the block is written.
    expect(PANEL_SOURCE).not.toMatch(/caveats\.join\(|top\.join\(/);
  });

  it('still labels the block, which is what tells a reader what the bullets are', () => {
    // "Keep in mind" rather than "What to keep in mind:", and a heading rather
    // than a bolded run of the first line: it is now a named zone of a card, so
    // the label sits on the zone instead of introducing a sentence.
    expect(PANEL_SOURCE).toContain('<p className="keep-in-mind-heading">Keep in mind</p>');
  });

  /**
   * The constraint that makes this a presentational fix rather than a licence.
   *
   * The front end renders the orchestrator's content and does not interpret it.
   * Splitting a caveat on sentence boundaries to win a longer list, rewording
   * one to read better, or dropping one that looks like another would all be
   * this surface deciding what a disclosure says, and the two the permission
   * model rests on are the ones a heuristic would mangle. So the text reaches
   * the bullet untouched.
   */
  it('renders each caveat verbatim, without splitting or rewriting it', () => {
    // The bullet now cuts the caveat into runs so the figures inside it can be
    // bolded, which is a change in how the text is DRAWN and must not become a
    // change in what it SAYS. The cut is `emphasiseFigures`, whose runs
    // concatenate back to the input exactly -- pinned by a round-trip over the
    // real caveats in caveat-emphasis.test.ts -- and each run reaches the
    // document through `EntityText` as it arrived. What is still refused here is
    // the component doing any of it itself: a sentence split to win a shorter
    // bullet, a reword, a trim to the first clause.
    expect(PANEL_SOURCE).toContain('emphasiseFigures(caveat).map');
    expect(PANEL_SOURCE).toContain('<EntityText key={run.start} text={run.text} sources={sources}');
    expect(PANEL_SOURCE).not.toMatch(/\bcaveat\.(split|replace|slice|match|substring|trim)\(/);
  });

  /**
   * The fold hides bullets; it must not lose them. Both halves come out of one
   * `rankCaveats` call and both are rendered from the same component, so there is
   * no branch in which the second half is computed and then not drawn -- which is
   * the shape the old version of this test was guarding against when it refused a
   * cap outright.
   */
  it('renders the folded remainder rather than discarding it', () => {
    expect(PANEL_SOURCE).toMatch(/rest\.map\(\(caveat\) =>\s*<CaveatBullet/);
    expect(PANEL_SOURCE).not.toMatch(/\brest\b[^\n]*\.slice\(/);
  });

  it('opens the fold with show more, and does not count the hidden bullets', () => {
    expect(PANEL_SOURCE).toContain("'show more'");
    expect(PANEL_SOURCE).not.toMatch(/Show all \$\{/);
    expect(PANEL_SOURCE).not.toContain('rest.length} more');
  });

  /**
   * Length is still never capped, only count. Clamping a caveat to two lines
   * would cut the identity item's second sentence -- the row-filter warning -- off
   * mid-clause, and unlike a folded bullet there would be no control to recover
   * it.
   */
  it('caps the number of bullets shown and never the length of one', () => {
    // Comments stripped: the file's header now explains at length that the fold
    // is Sam's decision and NOT the sources-module spec's, which asks for every
    // caveat "untruncated". A test that reads the word in that sentence as a
    // clamp is a test that punishes the file for saying why it is the way it is.
    const markup = PANEL_SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
    expect(markup).not.toMatch(/line-clamp|truncate|text-ellipsis/);
  });
});

/**
 * The audit the restructuring has to survive: everything in, everything out.
 *
 * `splitCaveats` is the only thing between the payload and the bullets, and the
 * card maps 1:1 over what it returns, so the count and order it preserves are
 * the count and order on screen.
 */
describe('every caveat reaching a bullet', () => {
  it('keeps every one of them, in the order they arrived', () => {
    const { degraded, ordinary } = splitCaveats(REPORTED_CAVEATS);

    expect(degraded).toEqual([]);
    expect(ordinary).toEqual(REPORTED_CAVEATS);
  });

  it('still hands the lecture through as ordinary text, so ranking can drop it', () => {
    const [coverage] = splitCaveats(REPORTED_CAVEATS).ordinary;

    expect(coverage).toContain('covers only the data that identity is granted');
    expect(coverage).toContain('row filters and column masks apply without reporting themselves');
  });

  /**
   * The near-duplicate, kept deliberately rather than resolved here.
   *
   * Both say the data is synthetic and they come from different producers: the
   * second-listed one is the synthesiser's own sentence, written because
   * `synthesis_provenance_rule` told it to disclose synthetic data, and the
   * last is `SYNTHETIC_DATA_CAVEAT`, appended by a deployment that declared
   * itself synthetic. The agent already deduplicates on the exact constant, and
   * deliberately not on the word, because matching the word once let a denial
   * suppress the disclosure a deployment had asked for.
   *
   * Fuzzy-matching a model-written sentence in order to delete a governance line
   * is still the failure mode that must not exist, and this layer still does not
   * do it: `splitCaveats` passes both through, unexamined, and what reaches the
   * bullets is decided one layer up.
   *
   * THAT LAYER NOW COLLAPSES THIS PAIR, which reverses the conclusion this test
   * used to draw and is the reader's own decision -- they saw both in one list and
   * said so. What makes it safe is that it is not a similarity threshold: the
   * collapse in caveat-priority.ts fires only on a whitelisted claim AND only
   * between caveats it has already ranked as standing deployment facts, so the
   * denial-suppresses-the-disclosure case that stopped the agent matching on the
   * word cannot happen here either. See the tests in caveat-priority.test.ts,
   * which pin both halves: the pair collapses, and a refusal that merely uses the
   * word does not.
   */
  it('leaves both synthetic-data disclosures for the layer above to judge', () => {
    const synthetic = splitCaveats(REPORTED_CAVEATS).ordinary.filter((caveat) => caveat.includes('synthetic'));

    expect(synthetic).toHaveLength(2);
  });
});
