import { describe, expect, it } from 'vitest';
import {
  declaredColumns,
  ENTITY_PARAM,
  entityForms,
  entityHref,
  entityRowId,
  linkableEntities,
  linkifyEntities,
  mentionedIdentifiers,
  trackedEntity,
  trackedTables,
  type ProseSegment,
} from './data-entities';

const CATALOG = '<your_catalog>.<your_schema>';
const DAILY = `${CATALOG}.gold_title_daily_summary`;
const PURCHASES = `${CATALOG}.silver_purchases`;

/** A preflight report shaped like the one `/api/preflight` returns. */
function report(names: string[], extra: Record<string, unknown>[] = []) {
  return {
    status: 'ok',
    checks: [
      { id: 'sql-warehouse', kind: 'sql-warehouse', name: '<sql-warehouse-id>', status: 'ok' },
      ...names.map((name) => ({ id: `table-${name}`, kind: 'table', name, status: 'ok' })),
      ...extra,
    ],
  };
}

/** The linked runs, as `[text, entity]`, which is what the assertions care about. */
function links(segments: ProseSegment[]): [string, string][] {
  return segments.filter((segment) => segment.entity).map((segment) => [segment.text, segment.entity!]);
}

/** The runs drawn bold with nothing to click. */
function bolded(segments: ProseSegment[]): string[] {
  return segments.filter((segment) => segment.emphasis).map((segment) => segment.text);
}

describe('trackedTables', () => {
  it('takes the table checks, which are the rows the table matrix renders', () => {
    expect(trackedTables(report([DAILY, PURCHASES]))).toEqual([DAILY, PURCHASES]);
  });

  it('keeps a blocked table, because its row exists and is worth reaching', () => {
    const blocked = { id: `table-${PURCHASES}`, kind: 'table', name: PURCHASES, status: 'failed' };
    expect(trackedTables(report([DAILY], [blocked]))).toEqual([DAILY, PURCHASES]);
  });

  it('reads nothing out of a body that is not a report', () => {
    // The route answers a report even for a failure, but a mid-deploy app can
    // answer anything at all. No names means no links, which is the safe end.
    expect(trackedTables(null)).toEqual([]);
    expect(trackedTables({ error: 'boom' })).toEqual([]);
    expect(trackedTables({ checks: 'not an array' })).toEqual([]);
    expect(trackedTables({ checks: [null, { kind: 'table' }, { kind: 'table', name: '  ' }] })).toEqual([]);
  });
});

describe('linkableEntities', () => {
  it('keeps a declared source the app tracks', () => {
    expect(linkableEntities([DAILY], [DAILY, PURCHASES])).toEqual([DAILY]);
  });

  it('drops a declared source with no entry on the Connections page', () => {
    // The representative answer cites `main.player_insights.…`, a deliberate
    // stand-in for a table nobody's workspace has. A link to it would go nowhere.
    expect(linkableEntities(['main.player_insights.silver_gameplay_activity'], [DAILY])).toEqual([]);
  });

  it('drops a source that is not a table at all', () => {
    expect(linkableEntities(['Player Insights Data Dictionary Genie'], [DAILY])).toEqual([]);
  });

  it('answers with the tracked spelling, so the link and the row agree', () => {
    expect(linkableEntities([DAILY.toUpperCase()], [DAILY])).toEqual([DAILY]);
  });

  it('does not link a tracked table the answer never declared', () => {
    // Provenance: the table matrix tracks six tables, and an answer that read
    // one of them must not appear to have read the other five.
    expect(linkableEntities([DAILY], [DAILY, PURCHASES])).not.toContain(PURCHASES);
  });
});

describe('entityForms', () => {
  it('accepts the qualified name, the schema tail, and the bare name', () => {
    expect([...entityForms([DAILY]).keys()]).toEqual([
      DAILY.toLowerCase(),
      '<your_schema>.gold_title_daily_summary',
      'gold_title_daily_summary',
    ]);
  });

  it('refuses a bare name with no underscore in it', () => {
    // `sessions` is a word people write in sentences about sessions.
    const forms = entityForms(['some_catalog.some_schema.sessions']);
    expect(forms.has('sessions')).toBe(false);
    expect(forms.has('some_schema.sessions')).toBe(true);
  });

  it('drops a bare name two tracked tables could both claim', () => {
    const forms = entityForms(['cat_a.sch.gold_daily_totals', 'cat_b.sch.gold_daily_totals']);
    expect(forms.has('gold_daily_totals')).toBe(false);
    expect(forms.has('sch.gold_daily_totals')).toBe(false);
    expect(forms.has('cat_a.sch.gold_daily_totals')).toBe(true);
  });
});

describe('linkifyEntities', () => {
  const tracked = [DAILY, PURCHASES];

  it('links a known table named in the prose', () => {
    const prose = `Source: ${'`'}gold_title_daily_summary${'`'} (published rollup), refunds already netted.`;
    expect(links(linkifyEntities(prose, [DAILY], tracked))).toEqual([['gold_title_daily_summary', DAILY]]);
  });

  it('links a fully-qualified mention once, as a whole', () => {
    const prose = `Read from ${DAILY} during this run.`;
    expect(links(linkifyEntities(prose, [DAILY], tracked))).toEqual([[DAILY, DAILY]]);
  });

  it('links a mention that ends a sentence', () => {
    // The trailing dot is punctuation here, not the start of a column name, and
    // an off-by-one on that boundary silently drops the commonest mention there is.
    expect(links(linkifyEntities(`It came from ${DAILY}.`, [DAILY], tracked))).toEqual([[DAILY, DAILY]]);
    expect(links(linkifyEntities('It came from gold_title_daily_summary.', [DAILY], tracked))).toEqual([
      ['gold_title_daily_summary', DAILY],
    ]);
  });

  it('leaves an identifier the app does not track as plain text', () => {
    const prose = 'Derived from gold_title_weekly_rollup, which nothing here tracks.';
    expect(links(linkifyEntities(prose, [DAILY], tracked))).toEqual([]);
  });

  it('leaves a column alone, because no page documents columns', () => {
    const prose =
      'Full-game net bookings is net_bookings_usd minus recurrent_consumer_spending_usd, ' +
      'per is_recurrent_consumer_spending.';
    expect(links(linkifyEntities(prose, [DAILY], tracked))).toEqual([]);
  });

  it('does not link a table name that is only part of a longer identifier', () => {
    const prose = 'Neither gold_title_daily_summary_v2 nor my_gold_title_daily_summary is this table.';
    expect(links(linkifyEntities(prose, [DAILY], tracked))).toEqual([]);
  });

  it('does not link the table when the prose is naming one of its columns', () => {
    const prose = 'The value in gold_title_daily_summary.net_bookings_usd is already net of refunds.';
    expect(links(linkifyEntities(prose, [DAILY], tracked))).toEqual([]);
  });

  it('does not linkify an ordinary word that happens to be a table name', () => {
    // The rule that stops this is the underscore requirement on a bare name,
    // and it is the reason a reader can trust the links that do appear.
    const tracked = ['<your_catalog>.<your_schema>.sessions'];
    const prose = 'Sessions were flat, and the average session ran 34 minutes.';
    expect(links(linkifyEntities(prose, tracked, tracked))).toEqual([]);
  });

  it('links every mention, not just the first', () => {
    const prose = 'gold_title_daily_summary is the rollup; gold_title_daily_summary nets refunds.';
    expect(links(linkifyEntities(prose, [DAILY], tracked))).toHaveLength(2);
  });

  it('links two declared tables independently', () => {
    const prose = 'Engagement from gold_title_daily_summary, value from silver_purchases.';
    expect(links(linkifyEntities(prose, [DAILY, PURCHASES], tracked))).toEqual([
      ['gold_title_daily_summary', DAILY],
      ['silver_purchases', PURCHASES],
    ]);
  });

  it('never rewrites the answer', () => {
    // The whole point of segmenting rather than replacing: whatever the agent
    // wrote is what the reader sees, links or no links.
    const prose = `Source: ${DAILY} (published rollup); gold_title_daily_summary nets refunds into net_bookings_usd.`;
    const segments = linkifyEntities(prose, [DAILY], tracked);
    expect(segments.map((segment) => segment.text).join('')).toBe(prose);
    expect(links(segments)).toHaveLength(2);
  });

  it('leaves the prose alone when nothing is linkable', () => {
    expect(linkifyEntities('A sentence.', [], tracked)).toEqual([{ text: 'A sentence.', start: 0 }]);
    expect(linkifyEntities('A sentence.', [DAILY], [])).toEqual([{ text: 'A sentence.', start: 0 }]);
    expect(linkifyEntities('', [DAILY], tracked)).toEqual([]);
  });

  it('says where each run starts, so the renderer can key on it', () => {
    const prose = 'From gold_title_daily_summary, netted.';
    const segments = linkifyEntities(prose, [DAILY], tracked);
    expect(segments.map((segment) => segment.start)).toEqual([0, 5, 5 + 'gold_title_daily_summary'.length]);
    for (const segment of segments) {
      expect(prose.slice(segment.start, segment.start + segment.text.length)).toBe(segment.text);
    }
  });
});

describe('declaredColumns', () => {
  it('takes the columns a plan step lists', () => {
    const step = 'Read gold_title_daily_summary. Columns: event_date, title_code, title_name, active_players';
    expect(declaredColumns([step])).toEqual(['event_date', 'title_code', 'title_name', 'active_players']);
  });

  it('takes them through the punctuation and backticks a plan is written with', () => {
    expect(declaredColumns(['Columns: `event_date`, `active_players`.'])).toEqual(['event_date', 'active_players']);
  });

  it('names each column once, however many steps list it', () => {
    expect(declaredColumns(['Columns: event_date, active_players', 'Columns: active_players'])).toEqual([
      'event_date',
      'active_players',
    ]);
  });

  it('refuses a column with no underscore in it', () => {
    // The rule that keeps "by title over the 30-day window" from coming out
    // with a bolded "title" in it. A single-word column name is not
    // distinguishable from the English word, and a false bold costs the same
    // trust a false link does.
    expect(declaredColumns(['Columns: title, event_date, region'])).toEqual(['event_date']);
  });

  it('reads nothing out of prose that declares nothing', () => {
    expect(declaredColumns(['Aggregate active_players by title over the 30-day window.'])).toEqual([]);
    expect(declaredColumns([''])).toEqual([]);
  });

  it('stops at the end of the line the list is on', () => {
    // A list runs to the end of its line and no further; a second paragraph is
    // prose again, and the identifiers in it are declared by whatever line
    // declares them.
    expect(declaredColumns(['Columns: event_date\nGrouped by title_code where it exists'])).toEqual(['event_date']);
  });
});

/**
 * The candidate set for a caveat, which declares nothing and names everything.
 *
 * `declaredColumns` reads a list; a caveat is a sentence, and the two identifiers
 * a reader most needs marked in one -- a field the data dictionary does not
 * document, and a column the answer says is not additive -- are named in prose and
 * declared nowhere. One of them cannot be in any governed list by definition,
 * because the caveat's whole point is that it is missing from the dictionary.
 */
describe('mentionedIdentifiers', () => {
  it('takes the identifiers a caveat names in passing', () => {
    expect(mentionedIdentifiers(['active_players is not additive across labels.'])).toEqual(['active_players']);
    expect(
      mentionedIdentifiers(['The field launch_campaign_sessions is not documented in the data dictionary.'])
    ).toEqual(['launch_campaign_sessions']);
  });

  it('takes the parts of a qualified name as well as the whole of it', () => {
    // The bare tail is what a later sentence in the same caveat is likely to use,
    // and `proseForms` gives the fully-qualified mention the link and this one the
    // bold, so both spellings are marked and neither is marked twice.
    expect(mentionedIdentifiers(['Source is a_catalog.a_schema.gold_title_daily_summary (uncertified).'])).toEqual([
      'a_catalog',
      'a_schema',
      'gold_title_daily_summary',
    ]);
  });

  it('refuses every word that is only a word', () => {
    // The rule the whole thing rests on. Without it this bolds "figures",
    // "sessions" and "labels" in a panel that is mostly those words, and one wrong
    // mark costs the same trust a wrong link does.
    expect(mentionedIdentifiers(['Figures here aggregate sessions across labels and countries.'])).toEqual([]);
    expect(mentionedIdentifiers(['Totals are cumulative player-days, not unique players.'])).toEqual([]);
  });

  it('names each identifier once, however many caveats mention it', () => {
    expect(mentionedIdentifiers(['active_players is not additive.', 'active_players is a daily count.'])).toEqual([
      'active_players',
    ]);
  });

  it('reads nothing out of nothing', () => {
    expect(mentionedIdentifiers([])).toEqual([]);
    expect(mentionedIdentifiers([''])).toEqual([]);
  });
});

describe('an identifier with nowhere to send the reader', () => {
  const tracked = [DAILY, PURCHASES];

  it('bolds a declared column and does not link it', () => {
    // No page in this app documents a column, so there is nothing to link one
    // to. The reader still has to be able to see that the sentence is naming a
    // field rather than using a word.
    const prose = 'Aggregate active_players by title over the 30-day window.';
    const segments = linkifyEntities(prose, [DAILY], tracked, ['active_players']);
    expect(bolded(segments)).toEqual(['active_players']);
    expect(links(segments)).toEqual([]);
  });

  it('bolds a declared table the app does not track', () => {
    // The representative answer's `main.player_insights.…` is the standing
    // case: a source the answer cites that no deployment has a row for.
    const cited = 'main.player_insights.silver_gameplay_activity';
    const segments = linkifyEntities(`Read from ${cited} during this run.`, [cited], tracked);
    expect(bolded(segments)).toEqual([cited]);
    expect(links(segments)).toEqual([]);
  });

  it('links rather than bolds when the app does have a row', () => {
    // Both marks are on offer at the same position and the link wins, because
    // it carries the bold with it and a destination as well.
    const segments = linkifyEntities('From gold_title_daily_summary.', [DAILY], tracked, ['gold_title_daily_summary']);
    expect(links(segments)).toEqual([['gold_title_daily_summary', DAILY]]);
    expect(bolded(segments)).toEqual([]);
  });

  it('marks no ordinary word, in prose that is mostly ordinary words', () => {
    const prose =
      'Aggregate the daily summary by title over the window, then compare the active players to last month.';
    const segments = linkifyEntities(prose, [DAILY], tracked, ['active_players', 'event_date']);
    expect(links(segments)).toEqual([]);
    expect(bolded(segments)).toEqual([]);
  });

  it('never rewrites the plan either', () => {
    const prose = `Read ${DAILY}. Columns: event_date, active_players.`;
    const segments = linkifyEntities(prose, [DAILY], tracked, ['event_date', 'active_players']);
    expect(segments.map((segment) => segment.text).join('')).toBe(prose);
  });
});

describe('the proposed analysis plan, as it is actually written', () => {
  // Verbatim from a plan the demo produces, because the point of this feature
  // is what a reader sees in that card and not what the matcher can do.
  const tracked = [DAILY, PURCHASES];
  const SUMMARY = `Aggregate active_players from ${DAILY} by title over the 30-day window`;
  const STEP = `Read ${DAILY}. Columns: event_date, title_code, title_name, active_players`;
  const columns = declaredColumns([SUMMARY, STEP]);

  it('links the table it proposes to read, wherever the plan names it', () => {
    for (const line of [SUMMARY, STEP]) {
      expect(links(linkifyEntities(line, tracked, tracked, columns))).toEqual([[DAILY, DAILY]]);
    }
  });

  it('bolds every column it proposes to read', () => {
    expect(bolded(linkifyEntities(STEP, tracked, tracked, columns))).toEqual([
      'event_date',
      'title_code',
      'title_name',
      'active_players',
    ]);
    expect(bolded(linkifyEntities(SUMMARY, tracked, tracked, columns))).toEqual(['active_players']);
  });

  it('leaves the English around them alone', () => {
    const marked = linkifyEntities(SUMMARY, tracked, tracked, columns)
      .filter((segment) => segment.entity ?? segment.emphasis)
      .map((segment) => segment.text);
    expect(marked).toEqual(['active_players', DAILY]);
    // `title` and `window` are words in this sentence and a column list two
    // lines down happens to contain `title_code`. Neither is marked.
    expect(marked).not.toContain('title');
    expect(marked).not.toContain('window');
  });
});

describe('link targets', () => {
  // `/sources` since this feature was written, `/connections` since the two
  // pages merged into one. The table matrix an entity link lands on moved with
  // the merge, and a link to a page that only redirects would work but would
  // put a redirect in the middle of every citation in every answer.
  it('points at the page that holds the entry, carrying the entry it wants', () => {
    expect(entityHref(DAILY)).toBe(`/connections?${ENTITY_PARAM}=${encodeURIComponent(DAILY)}`);
  });

  it('names the row the same way from either side', () => {
    expect(entityRowId(DAILY)).toBe(entityRowId(DAILY.toUpperCase()));
  });

  it('matches a requested entry against the tracked spelling', () => {
    expect(trackedEntity(DAILY.toUpperCase(), [DAILY])).toBe(DAILY);
    expect(trackedEntity('nothing.like.this', [DAILY])).toBe('');
    expect(trackedEntity('   ', [DAILY])).toBe('');
  });
});
