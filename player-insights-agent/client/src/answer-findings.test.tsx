import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerProse } from './DataEntityLinks';
import { layoutFindingBlocks, inlinePlainText } from './answer-findings';
import { parseAnswerMarkdown } from './answer-markdown';
import { evidenceLinkedSourceNames, leftoverSources, tableOriginMaps, tableOriginSources } from './answer-table-origins';
import { partial } from './styles/stylesheet';
import type { SourceRef } from './answer-shape';

function render(text: string, sources: SourceRef[] = []): string {
  return renderToStaticMarkup(<AnswerProse text={text} sources={sources} />);
}

function readable(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, '\u2019')
    .replace(/&#x2013;/g, '\u2013')
    .replace(/&#x2014;/g, '\u2014')
    .replace(/(\d)\s+[\u2013\u2014-]\s+(\d)/g, '$1\u2013$2')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function labels(markup: string): string[] {
  return [...markup.matchAll(/<h4 class="answer-finding-label">([\s\S]*?)<\/h4>/g)].map((match) =>
    match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

describe('finding layout', () => {
  it('draws a ### label plus bullets as a labeled finding block', () => {
    const markup = render('### Who\n\n- **12,000** players in `silver_player_profiles`.\n- Grain is 1 row per `player_id`.');
    expect(markup).toContain('class="answer-finding"');
    expect(markup).toContain('class="answer-finding-label"');
    expect(markup).toContain('Who');
    expect(markup).toContain('<ul class="answer-list">');
    expect(markup).toContain('12,000');
    expect(markup).toContain('silver_player_profiles');
    expect(markup).toContain('player_id');
    expect(markup).not.toContain('class="answer-heading answer-subheading"');
  });

  it('turns a dense paragraph into bullets and keeps figures and chips', () => {
    const markup = render(
      'The profile base is **12,000** distinct players in `silver_player_profiles`. Identity scores range **0.8365–0.8905**. Dynasty VII sessions average **108** minutes.'
    );
    expect(markup).toContain('<ul class="answer-list">');
    expect(markup.match(/<li>/g)).toHaveLength(3);
    expect(readable(markup)).toContain('12,000');
    expect(readable(markup)).toContain('0.8365');
    expect(readable(markup)).toContain('0.8905');
    expect(readable(markup)).toContain('108');
    expect(markup).toContain('<code class="answer-code entity-quote">');
    expect(markup).toContain('silver_player_profiles');
  });

  it('promotes a short bold lead-in to the finding label', () => {
    const markup = render(
      '**Sessions** Average session length is **108** minutes on Dynasty VII. Hoops 25 sits at **41** minutes.'
    );
    expect(markup).toContain('class="answer-finding-label"');
    expect(readable(markup)).toContain('Sessions');
    expect(markup.match(/<li>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(readable(markup)).toContain('108');
    expect(readable(markup)).toContain('41');
  });

  it('splits an unlabeled essay into Who / Identity / Sessions blocks', () => {
    const markup = render(
      [
        'The profile base is **12,000** distinct players in `silver_player_profiles`. Grain is 1 row per `player_id`.',
        'Identity confidence scores range **0.8365–0.8905**. VLHV leads on email addressability at **60.0%**.',
        'Dynasty VII sessions average **108** min. Hoops 25 sits at **41** min. VLHO net bookings are **$42,650**.',
        '**11** countries appear in the `country_code` column. Codes follow ISO 3166-1 alpha-2.',
        'The `label` column splits titles between Northwind and Contoso. Northwind bookings are **$42,650** for VLHO.',
        '`identity_use_scope` in `silver_player_profiles` was not aggregated in this run.',
      ].join('\n\n')
    );
    expect(labels(markup)).toEqual([
      'Who',
      'Identity',
      'Sessions & spend',
      'Where',
      'Publishers',
      'What this run skipped',
    ]);
    expect(readable(markup)).toContain('12,000');
    expect(readable(markup)).toContain('0.8365');
    expect(readable(markup)).toContain('0.8905');
    expect(readable(markup)).toContain('108');
    expect(readable(markup)).toContain('42,650');
    expect(markup).toContain('silver_player_profiles');
    expect(markup).toContain('country_code');
    expect(markup).toContain('identity_use_scope');
  });

  it('leaves Gold / Silver / Raw as bold lines, not finding labels', () => {
    const markup = render(
      [
        '**Gold (aggregates — preferred starting point)**',
        '- `gold_player_180d_summary`: Per-player aggregates.',
        '',
        '- **Reference / Metadata**',
        '- `data_dictionary`: Field definitions.',
      ].join('\n')
    );
    expect(markup).toContain('<p><strong>Gold (aggregates — preferred starting point)</strong></p>');
    expect(markup).toContain('<p><strong>Reference / Metadata</strong></p>');
    expect(markup).not.toContain('class="answer-finding-label"');
  });

  it('leaves a DATA PACKAGE heading a catalog title, not a finding label', () => {
    const markup = render('## DATA PACKAGE\n\n- **Interpretation:** inspect the governed player fields.');
    expect(markup).toContain('class="answer-heading"');
    expect(readable(markup)).toContain('DATA PACKAGE');
    expect(markup).not.toContain('class="answer-finding-label"');
  });

  it('leaves a one-sentence paragraph a paragraph', () => {
    const markup = render('Opening sentence survives.');
    expect(markup).toContain('<p>');
    expect(markup).not.toContain('<li>');
    expect(readable(markup)).toBe('Opening sentence survives.');
  });

  it('does not drop sentences when a paragraph has more than four of them', () => {
    const blocks = layoutFindingBlocks(
      parseAnswerMarkdown(
        'Players number **12,000**. A second fact. A third fact. A fourth fact. A fifth fact that must still be on screen.'
      )
    );
    const list = blocks.find((block) => block.kind === 'list');
    if (!list || list.kind !== 'list') throw new Error('expected a list');
    expect(list.items).toHaveLength(4);
    expect(list.items.some((item) => inlinePlainText(item.children).includes('fifth fact'))).toBe(true);
  });

  it('turns a colon opening into a finding label and keeps the body', () => {
    const markup = render(
      'Profile base (source: silver_player_profiles): Grain is 1 row per `player_id`. Identity scores range **0.8365–0.8905**.'
    );
    expect(markup).toContain('class="answer-finding-label"');
    expect(readable(markup)).toContain('Profile base');
    expect(readable(markup)).toContain('player_id');
    expect(readable(markup)).toContain('0.8365');
    expect(readable(markup)).toContain('0.8905');
  });
});

describe('table origin on the table header', () => {
  const PROFILES = '<your_catalog>.<your_schema>.silver_player_profiles';
  const DAILY = '<your_catalog>.<your_schema>.gold_title_daily_summary';
  const TABLE = '| Title | Players |\n| --- | ---: |\n| VLHO | 6044 |';

  it('puts the named source on that table’s header band', () => {
    const markup = render(
      `Profile base (source: \`${PROFILES}\`).\n\n${TABLE}`,
      [{ name: PROFILES, freshness: '', role: 'reading' }]
    );
    expect(markup).toContain('answer-table-origin');
    expect(markup).toContain('aria-label="Source table"');
    expect(markup).toContain('silver_player_profiles');
    const originAt = markup.indexOf('answer-table-origin');
    const tableAt = markup.indexOf('<table');
    expect(originAt).toBeGreaterThan(-1);
    expect(originAt).toBeLessThan(tableAt);
  });

  it('matches the short name in the heading above the table', () => {
    const blocks = parseAnswerMarkdown(`### gold_title_daily_summary\n\n${TABLE}`);
    const origins = tableOriginSources(blocks, [
      { name: DAILY, freshness: '', role: 'reading' },
      { name: PROFILES, freshness: '', role: 'reading' },
    ]);
    const table = blocks.find((block) => block.kind === 'table');
    if (!table || table.kind !== 'table') throw new Error('expected a table');
    expect(origins.get(table.start)?.map((source) => source.name)).toEqual([DAILY]);
  });

  it('does not put a reference dictionary on a results table unless the prose named it', () => {
    const blocks = parseAnswerMarkdown(`Sessions by title.\n\n${TABLE}`);
    const origins = tableOriginSources(blocks, [
      { name: DAILY, freshness: '', role: 'reading' },
      { name: 'main.player_insights.data_dictionary', freshness: '', role: 'reference' },
    ]);
    const table = blocks.find((block) => block.kind === 'table');
    if (!table || table.kind !== 'table') throw new Error('expected a table');
    expect(origins.get(table.start)?.map((source) => source.name)).toEqual([DAILY]);
  });

  it('names chart figure-sources as already linked so Sources can drop the duplicate Open', () => {
    const names = evidenceLinkedSourceNames('Sessions rose.', null, [{ id: 'c1' }], [
      { name: DAILY, freshness: '', role: 'reading' },
      { name: 'main.player_insights.data_dictionary', freshness: '', role: 'reference' },
    ]);
    expect(names).toEqual([DAILY]);
    expect(
      leftoverSources(
        [
          { name: DAILY, freshness: '', role: 'reading' },
          { name: 'main.player_insights.data_dictionary', freshness: '', role: 'reference' },
        ],
        names
      ).map((source) => source.name)
    ).toEqual(['main.player_insights.data_dictionary']);
  });

  it('pins a content table to a source named only in the narrative', () => {
    const maps = tableOriginMaps(
      [`Profile base (source: \`${PROFILES}\`).`, TABLE],
      [{ name: PROFILES, freshness: '', role: 'reading' }]
    );
    const tables = parseAnswerMarkdown(TABLE).filter((block) => block.kind === 'table');
    expect(maps[1].get(tables[0].start)?.map((source) => source.name)).toEqual([PROFILES]);
  });
});

describe('finding and origin styles', () => {
  const css = partial('answer.css');

  it('draws a finding label as an eyebrow, not as a second title', () => {
    expect(css).toMatch(/\.answer-finding-label \{[^}]*font-size: 10px/s);
    expect(css).toMatch(/\.answer-finding-label \{[^}]*text-transform: uppercase/s);
    expect(css).toMatch(/\.answer-table-origin \{[^}]*justify-content: flex-end/s);
    expect(css).toMatch(/\.answer-finding-head \{[^}]*justify-content: space-between/s);
  });
});
