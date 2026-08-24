import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerCard } from './AnswerCard';
import { SourcesModule } from './SourcesModule';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import type { Answer, FeedbackEntry } from './app-types';

/**
 * What the Sources module actually puts on screen, rendered and read back.
 *
 * A render rather than assertions about the source text, and that is the whole
 * point of the file. The defect this suite was written for was a table name run
 * into the words after it -- "…data_dictionaryRead during this run", one word,
 * half of it an identifier -- and every source-level claim anyone would think to
 * write was TRUE while it was on screen. Nothing short of composing the text and
 * reading it back could fail. `textContent` is also what a screen reader is
 * handed, so a run of text with no separator is not merely ugly; it is the
 * identifier being announced as part of the next sentence.
 *
 * Rendered through `renderToStaticMarkup`, so no effect runs: the tracked-table
 * and workspace-host reads both land after mount, and this sees the state every
 * surface passes through first -- the name unlinked, no "Open in Databricks"
 * control. That is deliberate. What the module says about a table must not
 * depend on whether the name turned out to be a link.
 */

/**
 * A three-level name in the shape the app cites one, with the deployment's own
 * catalog and schema replaced by the fixture names the other render tests use.
 * The row is the same row whatever the operator called their catalog, and a
 * live identifier in a fixture is one more place it has to be scrubbed.
 */
const NAME = 'main.player_insights.data_dictionary';
const FRESHNESS = 'Read during this run';
/** The tables a run's figures actually came from, beside the dictionary above. */
const QUERIED = ['main.player_insights.gold_title_daily_summary', 'main.player_insights.gold_spend_daily'];

/** The text a reader sees, tags removed and entities put back. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, '\u2019')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const feedback: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

/** An answer as the wire carries one, citing the table above. */
function wireAnswer(): WireAnswer {
  return {
    id: 'msg-1',
    mode: 'live',
    provenance: 'live',
    takeaway: 'The dictionary lists four spend fields.',
    narrative: 'The table documents each column and what it measures.',
    figures: [],
    sources: [{ name: NAME, freshness: FRESHNESS }],
    caveats: [],
    sql: 'SELECT * FROM data_dictionary',
  } as WireAnswer;
}

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

describe('the compact source line', () => {
  it('names the module and source in one paragraph', () => {
    const markup = renderToStaticMarkup(<SourcesModule sources={[{ name: NAME, freshness: FRESHNESS }]} caveats={[]} />);
    const rendered = text(markup);

    expect(rendered).toContain('Sources');
    expect(rendered).toContain(NAME);
    expect(markup.match(/<p class="source-line">/g)).toHaveLength(1);
  });

  it('keeps multiple sources in the same paragraph', () => {
    const markup = renderToStaticMarkup(<SourcesModule
          sources={QUERIED.map((name) => ({ name, freshness: FRESHNESS }))}
          caveats={[]}
        />
      );
    const rendered = text(markup);

    expect(rendered).toContain(QUERIED[0]);
    expect(rendered).toContain(QUERIED[1]);
    expect(markup.match(/<p class="source-line">/g)).toHaveLength(1);
  });

  it('says the governance line nowhere, however many tables the run read', () => {
    // The defect the module replaces, and then the half of it the module kept.
    // The strip printed "Governed Unity Catalog source · Read during this run"
    // on every row and the All sources tab printed it again on every row of its
    // own, so an answer that read five tables carried the same two facts ten
    // times. Collapsing them into the header made it once, which was the fix as
    // far as it went; the detail spec goes further and says the line belongs
    // nowhere in the module. It is right. The Unity Catalog mark beside the word
    // Sources says which product these tables are in, and the module appearing
    // under an answer says the run read them, so the sentence is the app
    // explaining its own design -- which section 7 rules out in as many words.
    const rendered = text(renderToStaticMarkup(<SourcesModule
          sources={[NAME, ...QUERIED].map((name) => ({ name, freshness: FRESHNESS, role: 'reading' as const }))}
          caveats={[]}
        />
      )
    );

    expect(rendered).not.toMatch(/governed/i);
    expect(rendered).not.toMatch(/read during this run/i);
    expect(rendered.match(/Queried for the figures/g)).toHaveLength(3);
  });
});

describe('the row that names a source', () => {
  it('names every table the run read, not the first one', () => {
    // The defect as reported: an answer comparing recurrent spending with net
    // bookings showed one source, the dictionary the agent had looked the two
    // terms up in, and none of the tables the figures came from. Both surfaces
    // rendered `sources[0]`, and the list is in the order the run read them, so
    // the lookup that ran first was the one thing on screen.
    const answer = {
      ...wireAnswer(),
      sources: [
        { name: NAME, freshness: FRESHNESS, role: 'reference' },
        ...QUERIED.map((name) => ({ name, freshness: FRESHNESS, role: 'reading' })),
      ],
    } as WireAnswer;
    const rendered = text(renderCard(answer));

    for (const name of [NAME, ...QUERIED]) expect(rendered, `${name} is listed`).toContain(name);
  });

  it('spells the whole three-part name, unbroken, in the order the run read them', () => {
    // The short name is tinted and the qualifier is recessive, which is two
    // spans where there was one string. Nothing may be added, dropped or
    // reordered by that: the name a reader copies out of this row has to be the
    // name they can paste into a query.
    const rendered = text(renderToStaticMarkup(<SourcesModule
          sources={[NAME, ...QUERIED].map((name) => ({ name, freshness: FRESHNESS }))}
          caveats={[]}
        />
      )
    );

    expect(rendered).toContain(NAME);
    expect(rendered.indexOf(NAME)).toBeLessThan(rendered.indexOf(QUERIED[0]));
    expect(rendered.indexOf(QUERIED[0])).toBeLessThan(rendered.indexOf(QUERIED[1]));
  });

  it('does not present a definition lookup as a source of the figures', () => {
    // The second half of the report, and the one a longer list on its own would
    // not have fixed: the dictionary is a source of the answer and not a source
    // of its numbers. The distinction is now on the row rather than in a caption
    // above a group, because a caption is what a reader scanning names skips.
    const rendered = text(renderToStaticMarkup(<SourcesModule
          sources={[
            { name: NAME, freshness: FRESHNESS, role: 'reference' },
            { name: QUERIED[0], freshness: FRESHNESS, role: 'reading' },
          ]}
          caveats={[]}
        />
      )
    );

    expect(rendered).toContain('Definition validation');
    expect(rendered).toContain('Queried for the figures');
    // The chip belongs to the row it is on: the dictionary's chip follows the
    // dictionary's name and precedes the queried table's.
    expect(rendered.indexOf('Definition validation')).toBeGreaterThan(rendered.indexOf(NAME));
    expect(rendered.indexOf('Definition validation')).toBeLessThan(rendered.indexOf(QUERIED[0]));
  });

  it('says it does not know the role rather than guessing at it', () => {
    // An answer stored before the agent published a role, which is every answer
    // in the store today. Both tables are named, and nothing claims which of
    // them produced the numbers, because this surface cannot tell.
    const rendered = text(renderToStaticMarkup(<SourcesModule
          sources={[{ name: NAME, freshness: FRESHNESS }, { name: QUERIED[0], freshness: FRESHNESS }]}
          caveats={[]}
        />
      )
    );

    expect(rendered).not.toContain('Queried for the figures');
    expect(rendered).not.toContain('Definition validation');
    expect(rendered.match(/Role not recorded/g)).toHaveLength(2);
    for (const name of [NAME, QUERIED[0]]) expect(rendered).toContain(name);
  });

  it('gives a table one row and one chip even when the wire sent it twice', () => {
    // A run that looked a table's definition up and then queried it declares it
    // twice. Two rows for one table is two claims about it, and a reader who
    // reads the first stops.
    const rendered = text(renderToStaticMarkup(<SourcesModule
          sources={[
            { name: QUERIED[0], freshness: FRESHNESS, role: 'reference' },
            { name: QUERIED[0], freshness: FRESHNESS, role: 'reading' },
          ]}
          caveats={[]}
        />
      )
    );

    expect(rendered.match(new RegExp(QUERIED[0].replace(/\./g, '\\.'), 'g'))).toHaveLength(1);
    // And the queried chip wins, because the reader's question is which tables
    // the numbers came from.
    expect(rendered).toContain('Queried for the figures');
    expect(rendered).not.toContain('Definition validation');
    expect(rendered.match(new RegExp(QUERIED[0].replace(/\./g, '\\.'), 'g'))).toHaveLength(1);
  });

  it('carries the freshness the server stated, where a reader can still reach it', () => {
    // Not printed on the row: it was, on two surfaces, and repeating the same
    // four words under every table is what buried the chip. It is in the row's
    // tooltip beside the full name, so nothing the server said has been dropped
    // from the document.
    const markup = renderToStaticMarkup(<SourcesModule sources={[{ name: NAME, freshness: 'Updated daily' }]} caveats={[]} />
    );

    expect(markup).toContain(`title="${NAME} · Updated daily"`);
  });

  it('is the module an answer card draws, chips and all', () => {
    // Through the real normaliser into the real card, because the module being
    // right in isolation says nothing about the card reaching it. The Run
    // Explorer's copy of this row was right in isolation too.
    const answer = {
      ...wireAnswer(),
      sources: [{ name: QUERIED[0], freshness: FRESHNESS, role: 'reading' }],
    } as WireAnswer;
    const rendered = text(renderCard(answer));

    expect(rendered).toContain(QUERIED[0]);
    expect(rendered).toContain('Queried for the figures');
    expect(rendered).toContain('Sources');
  });

  it('leaves the narrative’s own words untouched where it names the same table', () => {
    // The prose path, which links names inside a sentence rather than beside
    // one. Linking must move no character of the text: an entity that swallowed
    // the space after it would produce a defect one paragraph up that nothing in
    // the segmentation tests would notice.
    const sentence = `The figures come from ${NAME}, which is refreshed daily.`;
    const rendered = text(renderCard({ ...wireAnswer(), narrative: sentence }));

    expect(rendered).toContain(sentence);
  });
});

describe('what the module refuses to draw', () => {
  it('renders nothing at all when the run declared no source and sent no caveat', () => {
    // A definitional reply that read no table and had nothing to qualify has
    // nothing to say here, and an empty bordered card under the figures reads as
    // a list that failed to load.
    expect(renderToStaticMarkup(<SourcesModule sources={[]} caveats={[]} />)).toBe('');
    expect(renderToStaticMarkup(<SourcesModule sources={[]} caveats={['  ']} />)).toBe('');
  });

  it('still draws, for the caveats alone, when the answer cited no table', () => {
    // The case that must not regress. "What to keep in mind" was invisible for
    // months, and the module is now the only thing that draws it -- so an answer
    // with caveats and no sources has to bring the module with it.
    const rendered = text(renderToStaticMarkup(<SourcesModule sources={[]} caveats={['Totals are cumulative player-days.']} />)
    );

    expect(rendered).toContain('Keep in mind');
    expect(rendered).toContain('Totals are cumulative player-days.');
    // No count, because there is no claim about tables to make. "0 tables" is a
    // claim; saying nothing is not.
    expect(rendered).not.toContain('0 tables');
    expect(rendered).not.toContain('governed Unity Catalog');
  });

  it('is the one list: the card names no table anywhere else', () => {
    // The rule that made this a module rather than a restyle. The "All sources"
    // tab under Advanced trace details listed the same tables again, with the
    // same links and the same governance line, so the card contradicted itself
    // about how many places a reader had to look.
    const answer = {
      ...wireAnswer(),
      sources: QUERIED.map((name) => ({ name, freshness: FRESHNESS, role: 'reading' })),
    } as WireAnswer;
    const rendered = text(renderCard(answer));

    for (const name of QUERIED) {
      expect(rendered.match(new RegExp(name.replace(/\./g, '\\.'), 'g')), `${name} is named once`).toHaveLength(1);
    }
    expect(rendered).not.toContain('All sources');
    expect(rendered).not.toContain('all declared sources');
  });
});
