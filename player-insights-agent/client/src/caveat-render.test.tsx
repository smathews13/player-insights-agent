import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import { DEGRADED_ANSWER_MARKER } from '../../shared/setup-remedies';
import type { Answer, FeedbackEntry } from './app-types';

/**
 * Whether "What to keep in mind" reaches the document, from a payload shaped
 * like the wire rather than like the type.
 *
 * It was reported as never appearing on real answers, and the four places it
 * could have been lost -- the agent not sending it, the ask route dropping it,
 * `normalizeAnswer` reading it off the wrong key or nesting level, and the
 * render condition being unsatisfiable -- all looked correct on inspection. So
 * did the deployed bundle. The panel does render, and the evidence for that is
 * this file: the payload below has the same shape as the ones a live workspace
 * returns, `caveats` a flat array of strings at the top level beside `figures`
 * and `sources`, and it goes through the real normaliser into the real card.
 *
 * Written as a render rather than as assertions about the source, which is what
 * `caveat-list.test.ts` next to it does. That file pins how the block is
 * written -- one bullet each, unsorted, uncapped, verbatim -- and it passed
 * throughout, because every one of those statements can be true of a block that
 * nothing ever reaches. A key renamed anywhere between the wire and the bullet
 * would leave it passing and this failing, which is the whole reason to render.
 */

/**
 * As the endpoint sends them, with invented titles and an invented address.
 *
 * In the agent's order, which is deliberately not the order they are drawn in:
 * the identity boilerplate arrives first and the two that qualify the figures
 * arrive third and fourth. What that costs a reader is the reason the panel ranks
 * them, and holding the payload in arrival order here is what lets these tests
 * tell the two orders apart.
 */
const IDENTITY =
  'This answer was produced as analyst@example.com and covers only the data that identity is ' +
  'granted. Unity Catalog row filters and column masks apply without reporting themselves, so ' +
  'figures here may be computed from a subset of the rows another reader would see.';
const SYNTHETIC = 'All player data behind these figures is synthetic and does not represent real player behavior.';
const COVERAGE =
  'Only 19 of the 30 calendar days have records; the remaining 11 days may be unpopulated or ' +
  'outside the table’s in-scope activity window, which could understate averages.';
const PLAYER_DAYS = 'Totals are cumulative player-days, not unique players across the period.';
const OMITTED =
  'Meridian Drift and Harbor City Nights are close in rank but omitted from figures due to the 6-figure limit.';

const WIRE_CAVEATS = [IDENTITY, SYNTHETIC, COVERAGE, PLAYER_DAYS, OMITTED];

/**
 * A whole answer, as a stored row carries one.
 *
 * Every section populated, because the card decides what to draw from several
 * of them at once and an answer with nothing in it exercises none of that: the
 * caveats sit under the figures they qualify, and a payload with no figures
 * would put them somewhere no reader has ever seen them.
 */
function wireAnswer(caveats: string[]) {
  return {
    id: 'msg-1',
    mode: 'live',
    provenance: 'live',
    takeaway: 'VLH Online led on active players over the window.',
    narrative: 'Across the last 30 days the leading title held its position.',
    figures: [{ label: 'Meridian Drift', value: 62, display: '18,402', comparison: '+4.1%' }],
    sources: [{ name: 'main.player_insights.gold_title_daily_summary', freshness: 'Updated daily' }],
    caveats,
    sql: 'SELECT title, SUM(active_players) FROM gold_title_daily_summary GROUP BY title',
    trace: {
      id: 'tr-feedfacefeedfacefeedfacefeedface',
      totalMs: 43_740,
      toolCalls: 6,
      stages: [{ id: 'step-1-discover', name: 'Chose the next step', status: 'complete', durationMs: 1829 }],
    },
  };
}

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

/** The card as Ask PIA mounts it, as markup. */
function renderWire(raw: WireAnswer): string {
  return renderToStaticMarkup(
    <AnswerCard
      answer={normalizeAnswer(raw) as Answer}
      feedback={feedback}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback={false}
    />
  );
}

function renderCard(caveats: string[]): string {
  return renderWire(wireAnswer(caveats));
}

/** Everything from the Keep in mind heading down. */
function keepInMind(markup: string): string {
  const at = markup.indexOf('Keep in mind');
  if (at < 0) throw new Error('The Keep in mind section is not in the document');
  return markup.slice(at);
}

/** The bullets of the Keep in mind section, in the order they were drawn. */
function caveatBullets(markup: string): string[] {
  const panel = keepInMind(markup);
  const list = panel.slice(panel.indexOf('<ul'), panel.indexOf('</ul>'));
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) =>
    match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, '\u2019')
      .replace(/&quot;/g, '"')
      .trim()
  );
}

describe('the caveats an answer arrives with', () => {
  it('shows material caveats and drops process-only figure omissions', () => {
    const markup = renderCard(WIRE_CAVEATS);

    expect(markup).toContain('Keep in mind');
    expect(caveatBullets(markup)).toHaveLength(3);
    expect(markup).not.toContain('show more');
    expect(markup).not.toContain(OMITTED);
  });

  /**
   * Where the section now lives, which is the change this move was made for.
   *
   * It was a standalone amber alert below the sources, one more panel in a
   * column of panels, and it went unnoticed for months. It is now the footer of
   * the card that lists the tables -- the thing a reader is already looking at
   * when they ask where a number came from -- so the qualification arrives with
   * the provenance rather than after it.
   */
  it('is drawn inside the Sources module rather than as a panel beside it', () => {
    const markup = renderCard(WIRE_CAVEATS);
    const module = markup.slice(markup.indexOf('class="sources-module"'));

    expect(module).toContain('keep-in-mind');
    expect(module.indexOf('sources-row')).toBeLessThan(module.indexOf('keep-in-mind'));
    // The alert it used to be is gone, not merely restyled.
    expect(markup).not.toContain('caveat-alert');
    expect(markup).not.toContain('What to keep in mind');
  });

  /**
   * The two the permission model rests on, named rather than counted. The
   * identity line is on every answer and the masking sentence is the second
   * half of one item, so a normaliser that truncated or a renderer that took a
   * first sentence would still leave a plausible-looking panel on screen.
   */
  it('drops identity and presentation-process notes without hiding material caveats', () => {
    const markup = renderCard(WIRE_CAVEATS);
    expect(markup).not.toContain('produced as analyst@example.com');
    expect(markup).not.toContain(OMITTED);
    expect(caveatBullets(markup)).toHaveLength(3);
  });

  /**
   * The order on screen, against the order on the wire.
   *
   * Ranked by what each one threatens about the figures: the coverage gap, then
   * what the total actually counts, then the synthetic-data statement.
   */
  it('draws them in risk order rather than the order they arrived', () => {
    const bullets = caveatBullets(renderCard(WIRE_CAVEATS));
    const ranked = [COVERAGE, PLAYER_DAYS, SYNTHETIC];

    // Compared whole. Each caveat is rendered through `EntityText`, which links
    // table names and bolds column names inside it, so a bullet is the caveat's
    // text with markup in the middle of it rather than the string itself.
    ranked.slice(0, 3).forEach((caveat, index) => {
      expect(bullets[index].replace(/\s+/g, ' ')).toBe(caveat.replace(/\s+/g, ' '));
    });
  });

  /**
   * The identifiers a caveat names, marked by the app's own entity machinery
   * rather than by a second copy of it.
   *
   * `active_players` and `player-days` are what the sentence is about, and in a
   * wall of amber prose they were the hardest words in it to find. The table gets
   * the link when the app tracks it and the column gets the bold either way,
   * which is `proseForms`' existing precedence rule and not a new one.
   */
  it('marks the identifiers named inside a caveat', () => {
    const panel = keepInMind(
      renderCard([
        'active_players is not additive across labels; the value in gold_title_daily_summary is a daily count.',
      ])
    );

    expect(panel).toContain('<span class="entity-mark entity-column font-semibold">active_players</span>');
    // The plain English around it is left alone, which is the whole reason the
    // candidate set requires an underscore.
    expect(panel).not.toContain('>additive<');
    expect(panel).not.toContain('>labels<');
  });

  /**
   * The tag in front of a bullet, which says what the warning is about before
   * the reader has read it.
   *
   * Only where the caveat names exactly one of the answer's own tables. A
   * caveat naming two is not scoped to either -- picking the first would be the
   * browser deciding which half of a comparison mattered -- and one naming none
   * is run-level and carries no tag at all.
   */
  it('tags a caveat with the one table it is about, and only then', () => {
    const scoped = caveatBullets(renderCard(['gold_title_daily_summary counts a player once per day.']));
    expect(keepInMind(renderCard(['gold_title_daily_summary counts a player once per day.']))).toContain(
      'caveat-scope'
    );
    // Short name, because the catalog and schema are the same on every row and
    // are already said in full above.
    expect(scoped[0]).toContain('gold_title_daily_summary');
    expect(scoped[0]).not.toContain('main.player_insights.gold_title_daily_summary');

    // Run-level: nothing named, so nothing tagged.
    expect(keepInMind(renderCard([PLAYER_DAYS]))).not.toContain('caveat-scope');
  });

  /**
   * The numbers, which are the other half of what a reader is scanning for. "19
   * of the 30 calendar days" is the size of the coverage gap, and in a
   * paragraph of amber prose it read as a clause like any other.
   */
  it('draws the counts and percentages inside a caveat in bold', () => {
    const panel = keepInMind(renderCard([COVERAGE]));

    expect(panel).toContain('<b>19</b>');
    expect(panel).toContain('<b>30</b>');
    expect(panel).toContain('<b>11</b>');
    // And the sentence is still the sentence: nothing added, dropped or moved
    // by cutting it into runs.
    expect(caveatBullets(renderCard([COVERAGE]))[0].replace(/\s+/g, ' ')).toBe(COVERAGE.replace(/\s+/g, ' '));
  });

  /**
   * The panel's absence has to mean the answer had nothing to disclose, which
   * is the reading the report of it never appearing was resting on. If an empty
   * list drew an empty amber panel, the two cases would be indistinguishable on
   * screen and this bug would have been unfalsifiable.
   */
  it('draws no panel at all when the answer sent no caveats', () => {
    const markup = renderCard([]);

    expect(markup).not.toContain('Keep in mind');
    expect(markup).not.toContain('keep-in-mind');
    // The module itself stays, because this answer did cite a table. Only the
    // footer is absent.
    expect(markup).toContain('sources-module');
  });

  /**
   * A degradation states that the card may not be read as an answer, so it is
   * lifted out and said above the figures instead of fifth in a list under
   * them. The rest of the list must survive that lift: the bug this would
   * cause -- one marked caveat suppressing the panel the other four belong in
   * -- is indistinguishable from the one that was reported.
   */
  it('still draws the panel when one caveat was lifted out as a degradation', () => {
    const markup = renderCard([`${DEGRADED_ANSWER_MARKER} the agent fell back to stored data.`, ...WIRE_CAVEATS]);

    expect(markup).toContain('Keep in mind');
    const bullets = caveatBullets(markup);
    expect(bullets).toHaveLength(3);
    expect(bullets.some((bullet) => bullet.includes(DEGRADED_ANSWER_MARKER))).toBe(false);
  });

  /**
   * The endpoint's contract is a loose object at every level, so an answer from
   * an agent ahead of this app carries keys the app has never heard of. The
   * disclosures must not be what a forward-compatible payload costs.
   */
  it('is unaffected by keys the app does not know about', () => {
    // Cast because `WireAnswer` names the keys this app reads, and the point of
    // the case is a payload carrying two it does not.
    const ahead = {
      ...wireAnswer(WIRE_CAVEATS),
      confidence_band: 'wide',
      caveat_metadata: { source: 'assemble' },
    } as WireAnswer;

    expect(caveatBullets(renderWire(ahead))).toHaveLength(3);
  });
});

/**
 * The fold, on the answer that prompted it.
 *
 * Ten bullets was the reported number and five is the reader's. What has to be
 * true of the other five is that they are still reachable and that the control
 * says they are there -- a fold nobody can see is a deletion with extra steps.
 */
describe('the three a reader is shown first', () => {
  const REFUSAL =
    'A governance control refused part of this request, so that part is not answered here and was not ' +
    'answered another way.';
  const UNDOCUMENTED =
    'The field launch_campaign_sessions is not documented in the data dictionary; its precise ' +
    'definition and counting rule are unknown.';
  const TEN = [IDENTITY, SYNTHETIC, COVERAGE, PLAYER_DAYS, OMITTED, REFUSAL, UNDOCUMENTED];

  it('shows three and no more', () => {
    expect(caveatBullets(renderCard(TEN))).toHaveLength(3);
  });

  /** A real refusal leads Keep in mind without becoming a second red banner. */
  it('shows the refusal on the card, not behind the fold', () => {
    const markup = renderCard(TEN);
    expect(markup).toContain('A governance control refused part of this request');
    expect(markup).not.toContain('Request refused');
    expect(markup).not.toContain('Partial evidence');
    expect(caveatBullets(markup)[0]).toContain('A governance control refused');
  });

  it('offers the rest behind show more, rather than dropping them silently', () => {
    const markup = renderCard(TEN);

    expect(markup).toContain('show more');
    expect(markup).not.toMatch(/Show all \d/);
    expect(caveatBullets(markup).join(' ')).not.toContain('—');
    expect(markup).not.toContain('produced as analyst@example.com');
    // Collapsed, so the synthetic line is absent from the list until the control
    // is used -- and the control is what says more exist.
    expect(markup).not.toContain('does not represent real player behavior');
  });

  it('draws no control when there is nothing behind it', () => {
    expect(renderCard([IDENTITY, SYNTHETIC])).not.toContain('show more');
  });

  it('never draws the identity and row-filter lecture', () => {
    const markup = renderCard(WIRE_CAVEATS);
    expect(markup).not.toContain('covers only the data that identity is granted');
    expect(markup).not.toContain('row filters and column masks');
  });
});
