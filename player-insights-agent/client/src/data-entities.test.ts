import { describe, expect, it } from 'vitest';
import {
  ENTITY_PARAM,
  entityForms,
  entityHref,
  entityRowId,
  linkableEntities,
  linkifyEntities,
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
