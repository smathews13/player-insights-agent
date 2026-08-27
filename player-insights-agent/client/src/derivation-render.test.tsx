import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { SourcesModule } from './SourcesModule';
import { normalizeAnswer, type Derivation, type WireAnswer } from './answer-shape';
import type { Answer, FeedbackEntry } from './app-types';

/**
 * What the answer says about HOW it got its figure, rendered and read back.
 *
 * The agent derives four facts from the parse of each statement it executed --
 * the table, the measure, the date range, the rest of the WHERE clause -- and
 * this is the block that puts them on screen. The suite is a render rather than
 * assertions about the entries because the failure modes here are all about what
 * a reader ends up looking at: a label with nothing beside it, a bordered strip
 * with no facts in it, or a sentence explaining the block, which is the one thing
 * this surface must never grow.
 *
 * IT IS ALSO WHERE THE OVER-CLAIMS WOULD LAND. An empty window is a statement
 * with no date predicate, and drawing that as "All time" would be this file
 * asserting the population behind a figure -- the class of defect that put the
 * demo dataset under a live narrative and a "Synthetic data" chip beside a real
 * table name. Empty draws nothing, and the tests below hold that.
 */

const TABLE = 'main.player_insights.gold_spend_daily';
const SECOND = 'main.player_insights.gold_title_daily_summary';
const FRESHNESS = 'Read during this run';

/** One statement's worth of provenance, in the shape the agent publishes it. */
function derivation(fields: Partial<Derivation> = {}): Derivation {
  return { source: TABLE, metric: 'net_bookings', window: '', filter: '', ...fields };
}

/**
 * The text a reader sees, tags removed and entities put back.
 *
 * Tags collapse to nothing rather than to a space, as in the sibling suite, because
 * a three-level name is drawn as two spans -- the qualifier recessed, the short
 * name tinted -- and a space between them would make every assertion about a table
 * name pass against a name split across two words on screen.
 */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, '\u2019')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A label and the value drawn beside it, as the markup pairs them. */
function fact(label: string, value: string): string {
  return `<span class="derivation-label">${label} </span><code class="derivation-value">${value}</code>`;
}

/**
 * Only the provenance bullets, so a claim about what they do not say is about them.
 *
 * The rest of the card has its own vocabulary and some of it collides: the source
 * row wears a "Role not recorded" chip for a table whose role the run did not
 * publish, which is a true statement about the role and would satisfy a
 * card-wide search for a hedge.
 */
function strips(markup: string): string {
  const at = markup.indexOf('source-list-derivation');
  return at < 0 ? '' : markup.slice(at);
}

function renderModule(entries: Derivation[], sources: string[] = [TABLE], caveats: string[] = []): string {
  return renderToStaticMarkup(<SourcesModule
      sources={sources.map((name) => ({ name, freshness: FRESHNESS }))}
      caveats={caveats}
      derivation={entries}
    />
  );
}

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

function renderCard(raw: WireAnswer): string {
  return renderToStaticMarkup(<AnswerCard
      answer={normalizeAnswer(raw) as Answer}
      feedback={feedback}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback={false}
    />
  );
}

describe('the facts the block states', () => {
  it('labels the measure, the range and the filter, and puts the value beside each', () => {
    const markup = renderModule([
      derivation({ metric: 'net_bookings', window: '2025-01-01 → 2025-03-31', filter: 'platform = xbox' }),
    ]);

    // A distinct strong label for the word repeated across answers, followed by a
    // code value for the fragment of this run's statement.
    expect(markup).toContain(fact('Metric', 'net_bookings'));
    expect(markup).toContain(fact('Window', '2025-01-01 → 2025-03-31'));
    expect(markup).toContain(fact('Filter', 'platform = xbox'));
  });

  it('states the three in the order a reader asks them', () => {
    // What, over when, of which subset. Not the order the parse produced them.
    const markup = renderModule([
      derivation({ metric: 'net_bookings', window: '≥ 2025-01-01', filter: 'platform = xbox' }),
    ]);

    expect(markup.indexOf('Metric ')).toBeLessThan(markup.indexOf('Window '));
    expect(markup.indexOf('Window ')).toBeLessThan(markup.indexOf('Filter '));
  });

  it('says nothing about a field the statement did not carry', () => {
    // A query with no WHERE clause has no window and no filter, and the labels
    // for them are not drawn empty. THE WORDS THIS ASSERTS THE ABSENCE OF ARE
    // THE POINT: "All time" and "No filter" are claims about the population
    // behind the figure, and nothing in the run checked either.
    const markup = renderModule([derivation({ metric: 'active_players' })]);

    expect(markup).toContain(fact('Metric', 'active_players'));
    expect(markup).not.toContain('class="derivation-label">Window </span>');
    expect(markup).not.toContain('class="derivation-label">Filter </span>');
    expect(text(strips(markup))).not.toMatch(/all time|no filter|unknown|not recorded/i);
  });

  it('draws one strip per statement when a run ran more than one', () => {
    const markup = renderModule([
      derivation({ metric: 'net_bookings', window: '≥ 2025-01-01' }),
      derivation({ metric: 'active_players', window: '≥ 2025-01-01' }),
    ]);

    expect(markup.match(/source-list-derivation/g)).toHaveLength(2);
    expect(markup).toContain(fact('Metric', 'net_bookings'));
    expect(markup).toContain(fact('Metric', 'active_players'));
  });

  it('keeps a redacted value as the agent redacted it, rather than dropping the fact', () => {
    // The agent withholds the VALUE of an identifying predicate and keeps the
    // column, so a reader still learns the figure was filtered to one player
    // without the block naming which. Dropping the whole fact would hide that a
    // filter was applied at all, which is the more misleading of the two.
    const markup = renderModule([derivation({ filter: 'platformid_accountid = (withheld)' })]);

    expect(markup).toContain(fact('Filter', 'platformid_accountid = (withheld)'));
  });
});

describe('what it refuses to draw', () => {
  it('draws no strip for an entry that states nothing this card would show', () => {
    // Not hypothetical: an entry can arrive carrying only its source, and the
    // source is suppressed on a single-table answer because the row above
    // already names it. A strip with no facts in it is a bordered empty line.
    const markup = renderModule([{ source: TABLE, metric: '', window: '', filter: '' }]);

    expect(markup).not.toContain('source-list-derivation');
    // And the module still draws, because the source row is real.
    expect(text(markup)).toContain(TABLE);
  });

  it('renders nothing at all when the entries are empty and there is no source or caveat', () => {
    expect(renderModule([{ source: '', metric: '', window: '', filter: '' }], [], [])).toBe('');
  });

  it('does not repeat the table on an answer that read one', () => {
    // The card's own rule, held here too: a fact true of every row is said once.
    // The row above names the table; repeating it under every measure would make
    // the block a second sources list.
    const markup = renderModule([derivation({ metric: 'net_bookings' })], [TABLE]);

    expect(text(markup).match(new RegExp(TABLE.replace(/\./g, '\\.'), 'g'))).toHaveLength(1);
    expect(markup).not.toContain('class="derivation-label">Source </span>');
  });

  it('names each table once on its leftover bullet rather than repeating it as a source fact', () => {
    const markup = renderModule([derivation({ metric: 'net_bookings', source: SECOND })], [TABLE, SECOND]);

    expect(markup).not.toContain('class="derivation-label">Source </span>');
    expect(text(markup).match(new RegExp(SECOND.replace(/\./g, '\\.'), 'g'))).toHaveLength(1);
    expect(text(markup)).toContain(TABLE);
    expect(text(markup)).toContain(SECOND);
  });

  it('uses the same table-name pill treatment on every leftover source row', () => {
    const markup = renderModule(
      [derivation({ metric: 'net_bookings', source: SECOND, filter: 'platform = xbox' })],
      [TABLE, SECOND],
    );

    expect(markup.match(/class="source-list-name source-name-pill"/g)).toHaveLength(2);
    expect(markup).toContain('class="source-name-short">gold_title_daily_summary</span>');
    expect(markup).toContain(
      '<span class="derivation-label">Filter </span><code class="derivation-value">platform = xbox</code>',
    );
    expect(markup).toContain('class="derivation-label">Metric </span>');
    expect(markup).not.toContain('class="derivation-label">Source </span>');
  });

  it('explains itself nowhere: no sentence, no heading of its own', () => {
    // The rule that had explanatory prose removed from nearly every surface in
    // this app. The block is labelled facts. A sentence saying what provenance is
    // would be the longest thing in the card and the least read.
    const rendered = text(strips(renderModule([
          derivation({ metric: 'net_bookings', window: '≥ 2025-01-01', filter: 'platform = xbox' }),
        ])
      )
    );

    expect(rendered).not.toMatch(/derived|provenance|this answer|the agent|was computed|comes from/i);
    // Nor may it volunteer anything about the data being synthetic or a demo:
    // that wording was removed everywhere a customer can see it, including from
    // the chip that used to sit on the row above.
    expect(rendered).not.toMatch(/synthetic|demo|illustrative|sample data/i);
  });
});

describe('where it sits in the card', () => {
  it('goes under the tables and above what to keep in mind', () => {
    // Between the two for a reason: it is a fact about the query, so it belongs
    // with the tables it queried, and it is not a qualification, so it must not
    // join the ranked caveat fold and push a real caveat out of the top five.
    const markup = renderModule(
      [derivation({ metric: 'net_bookings' })],
      [TABLE],
      ['Totals are cumulative player-days.']
    );

    expect(markup.indexOf('source-list-row')).toBeLessThan(markup.indexOf('source-list-derivation'));
    expect(markup.indexOf('source-list-derivation')).toBeLessThan(markup.indexOf('Keep in mind'));
    // And the caveat is still there, in its own footer.
    expect(text(markup)).toContain('Totals are cumulative player-days.');
  });

  it('reaches the screen through the real normaliser and the real answer card', () => {
    // The module being right in isolation says nothing about the wire field
    // arriving. `derivation` is a new key on the answer contract, so every hop
    // between the model and this card is a place it can be dropped.
    const markup = renderCard({
      id: 'msg-1',
      mode: 'live',
      provenance: 'live',
      takeaway: 'Net bookings rose 12% in the quarter.',
      narrative: 'Growth came from the two largest titles.',
      figures: [],
      sources: [{ name: TABLE, freshness: FRESHNESS }],
      caveats: [],
      derivation: [{ source: TABLE, metric: 'net_bookings', window: '2025-01-01 → 2025-03-31', filter: '' }],
      sql: 'SELECT sum(spend) AS net_bookings FROM gold_spend_daily',
    } as WireAnswer);

    expect(markup).toContain(fact('Metric', 'net_bookings'));
    expect(markup).toContain(fact('Window', '2025-01-01 → 2025-03-31'));
  });

  it('draws nothing for an answer from a model version that did not derive any', () => {
    // Every answer in the store today, and every answer served until the model
    // is re-logged. The card renders as it did before the field existed.
    const rendered = renderCard({
      id: 'msg-1',
      mode: 'live',
      provenance: 'live',
      takeaway: 'Net bookings rose 12% in the quarter.',
      narrative: 'Growth came from the two largest titles.',
      figures: [],
      sources: [{ name: TABLE, freshness: FRESHNESS }],
      caveats: [],
      sql: 'SELECT sum(spend) FROM gold_spend_daily',
    } as WireAnswer);

    expect(rendered).not.toContain('source-list-derivation');
    expect(text(rendered)).toContain(TABLE);
  });
});
