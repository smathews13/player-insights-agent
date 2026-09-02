import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { StageDetail } from './TraceDag';
import { PayloadView } from './TraceTimeline';
import { partial } from './styles/stylesheet';
import type { TraceStage } from './answer-shape';

/**
 * What a step's result LOOKS LIKE once it is drawn as its shape.
 *
 * The companion to step-results.test.ts, which asserts the reading. This file
 * asserts the drawing, through the real surface: `StageDetail` is what a reader
 * opens, so every case below renders a whole step panel rather than a renderer on
 * its own, and what is asserted is the structure that appeared -- a grid where
 * there was a sentence, rows where there was a dash-run, a note in a block of its
 * own -- and not the class names it is made of.
 *
 * EVERY SHAPE HAS A MALFORMED CASE, and those are the tests protecting the reader
 * from this whole feature. A renderer that guessed at a payload it could not read
 * would put a confident card over text that says something else, which is worse
 * than the paragraph this replaced. So each one asserts the degrade: the text
 * survives, nothing is invented, and the panel does not come back blank.
 *
 * What is NOT verified here, and cannot be without a browser: how any of it looks,
 * where a row actually wraps, and what happens when a reader presses the rows that
 * expand. The claims are about the markup the component returns and the
 * declarations that style it.
 */
const TRACE_CSS = partial('trace.css');
const DARK_CSS = partial('dark-mode.css').replace(/\/\*[\s\S]*?\*\//g, ' ');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(TRACE_CSS)?.[1] ?? '';
}

function darkRule(selector: string): string {
  for (const match of DARK_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').some((candidate) => candidate.trim() === selector)) return match[2];
  }
  return '';
}

function stage(fields: Partial<TraceStage> & { id: string }): TraceStage {
  return {
    name: 'Queried governed data',
    kind: 'tool',
    start: 0,
    duration: 1000,
    status: 'complete',
    calls: 1,
    depth: 1,
    parent_id: '',
    input: '',
    output: '',
    ...fields,
  } as TraceStage;
}

/** One step panel, drawn as a reader would open it. */
function panel(fields: Partial<TraceStage> & { id: string }): string {
  return renderToStaticMarkup(<StageDetail stage={stage(fields)} step={6} origin={0} id="detail" />);
}

/** The rendered half of a panel, so a Raw assertion cannot pass on the argument block. */
function result(markup: string): string {
  const start = markup.indexOf('aria-label="Result payload"');
  return markup.slice(start);
}

const DATA_GENIE = [
  'Asking Genie space Player Insights Data (d00dfeedd00dfeedd00dfeedd00dfeed).',
  '',
  'Query interpretation: You want to see the total number of unique players in the silver_player_profiles table.',
  '',
  'Query result: distinct_players',
  '12000',
  '',
  'There are **12,000 distinct player_id values** in the silver_player_profiles table.',
].join('\n');

const DICTIONARY_GENIE = [
  'Asking Genie space Player Insights Data Dictionary (badc0ffebadc0ffebadc0ffebadc0ffe).',
  '',
  "Query interpretation: You want to see the business definitions for columns named like 'player_id'.",
  '',
  'Query result: table_name | column_name | business_definition | usage_guardrail',
  'silver_player_profiles | player_id | Surrogate key for one player account within its owning label. | Never return in an answer. Aggregate only.',
  '',
  'Based on this information, **player_id** is the correct field to count distinct players.',
].join('\n');

const SEMANTIC = [
  'SEMANTIC SEARCH RESULTS. These are descriptions and definitions, not data. Nothing here is a measurement.',
  '',
  '[table] <your_catalog>.<your_schema>.silver_player_profiles (uncertified)',
  'Table <your_catalog>.<your_schema>.silver_player_profiles. Validated player profiles with explicit email eligibility and identity scope.',
  'Columns:',
  '- player_id (string)',
  '- crm_customer_ref (string)',
  '- label (string)',
  '- identity_confidence (decimal(5,4))',
  '- signup_date (date)',
  '- snapshot_date (date)',
  '- marketing_region (string)',
  'platform (string)',
  'platform_generation (string)',
  'country_code (string)',
  'favorite_title_code (string)',
  'last_play_date (date)',
  '[table] <your_catalog>.<your_schema>.data_dictionary (uncertified)',
  'Table <your_catalog>.<your_schema>.data_dictionary. Business definitions and usage guardrails.',
  'Columns:',
  '- table_name (string)',
  '',
  'What appears above was filtered by a cached snapshot of grants from when this semantic layer was built.',
].join('\n');

const FINDINGS = [
  'There are **12,000 distinct players** in the dataset.',
  '',
  '**Source details:** - **Table:** `silver_player_profiles` - **Key used:** `player_id` — defined in the data ' +
    'dictionary as a surrogate key - **Count:** 12,000 distinct `player_id` values (NULLs excluded)',
  '',
  'Note: `player_id` is scoped per label, so a player under two labels is counted twice — let me know if you want ' +
    'the cross-label figure.',
].join('\n');

const DECLARED_TABLES = [
  '<your_catalog>.<your_schema>.data_dictionary',
  '<your_catalog>.<your_schema>.gold_player_180d_summary',
  '<your_catalog>.<your_schema>.silver_player_profiles',
];

const DECLARED_TABLE_LIST = [
  'DATA OVERVIEW',
  '',
  'Declared governed sources:',
  'Declared tables:',
  `${DECLARED_TABLES[0]} [franchise: untagged]`,
  `${DECLARED_TABLES[1]} [franchise: Northwind]`,
  `${DECLARED_TABLES[2]} [franchise: Contoso]`,
  'This is the declared set in one listing. A missing franchise tag means untagged, not that the table cannot answer.',
  'Call describe_table for columns, types, and comments.',
].join('\n');

describe('dark step details keep one night-sky surface', () => {
  /*
   * The panel is a card inside a card: the map's node opens it, and the map sits
   * on the run's own pane. Three translucent whites in a stack is what made it a
   * grey slab, so the panel keeps one quiet fill and its header takes none --
   * the hairline under the header is what separates it, not a second wash.
   */
  it('uses a quiet tile without repainting its header', () => {
    for (const selector of [
      "html[data-theme='dark'] .trace-dag.map .dag-node",
      "html[data-theme='dark'] .trace-dag.map .dag-detail",
    ]) {
      expect(darkRule(selector), `${selector} is not on the quiet fill`).toMatch(
        /background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)/
      );
    }
    expect(darkRule("html[data-theme='dark'] .trace-dag.map .dag-detail-head")).toMatch(/background:\s*transparent/);
  });
});

describe('a data_genie step', () => {
  const markup = panel({ id: 'step-6-1-data_genie', input: '{"question": "how many players"}', output: DATA_GENIE });

  it('names the space that answered on the Result row, instead of burying it in the prose', () => {
    // The whole first line of the old dump. It is a fact about the run -- which of
    // the two Genie spaces was asked -- and it was previously only recoverable by
    // reading a sentence.
    expect(result(markup)).toContain('Player Insights Data');
    expect(result(markup)).toContain('d00dfeed…feed');
    // Not the whole id on the page, and not lost either: the full value is the
    // title, which is the rule for every id in this app.
    expect(result(markup)).toContain('title="d00dfeedd00dfeedd00dfeedd00dfeed"');
  });

  it('outlines the space id rather than slabbing it, so the header keeps one background', () => {
    // The detail spec asks for an outlined mono chip here and the design reference
    // draws one. It was a #E8ECF0 fill with no edge, and this chip sits on the
    // Result row's own header beside the space name -- a grey slab there reads as a
    // second heading rather than as a value pinned to the one above it.
    const chip = rule('.trace-dag.map .dag-space-id');
    expect(chip).toMatch(/border: 1px solid var\(--ast-border-input\)/);
    expect(chip).toMatch(/font-family: var\(--font-mono\)/);
    expect(chip, 'an outlined chip has no fill').not.toMatch(/background/);
  });

  it('draws the four parts as rows, so the figure is not inside a sentence', () => {
    expect(markup).toContain('<dt>Understood as</dt>');
    // "Returned" and not "Result": a row called Result inside a row called Result
    // leaves the reader asking which.
    expect(markup).toContain('<dt>Returned</dt>');
    expect(markup).toContain('<dt>Answer</dt>');
    expect(markup).not.toContain('Asking Genie space');
    expect(markup).not.toContain('Query interpretation:');
  });

  it('draws a one-row result as a grid with its column name over it', () => {
    expect(result(markup)).toContain('<th scope="col">distinct_players</th>');
    // The figure takes the emphasis, because in a grid of governed text it is the
    // one cell the reader opened the step to find.
    expect(result(markup)).toContain('<td><b>12000</b></td>');
  });

  it('renders the answer’s bold as bold, rather than as four asterisks', () => {
    expect(result(markup)).toContain('<strong>12,000 distinct player_id values</strong>');
    expect(result(markup)).not.toContain('**');
  });

  it('sets the table and column names in the sentence as chips', () => {
    const understood = markup.slice(markup.indexOf('<dt>Understood as</dt>'), markup.indexOf('<dt>Returned</dt>'));
    expect(understood).toContain(
      '<code class="dag-name-chip" title="silver_player_profiles">silver_player_profiles</code>'
    );
    // The info family, which is what every other surface sets an identifier in and
    // the two values the detail spec names for this chip: #0E538B on #DDEAF4, at
    // 6.34:1. The same 3px box the answer card's identifier tags carry, so a name
    // is one shape wherever the app draws one and only the colour says which block
    // it is in.
    const chip = rule('.trace-dag.map .dag-name-chip');
    expect(chip).toMatch(/background: var\(--ast-info-fill\)/);
    expect(chip).toMatch(/color: var\(--ast-info-text\)/);
  });

  it('degrades to the text when the payload is not a Genie conversation at all', () => {
    const broken = panel({ id: 'step-6-1-data_genie', output: 'Genie refused: the warehouse was unavailable.' });
    expect(result(broken)).toContain('Genie refused: the warehouse was unavailable.');
    expect(broken).not.toContain('<dt>Understood as</dt>');
    expect(broken).not.toContain('dag-source');
  });

  it('still draws a bare grid as a grid, rather than as a shape that failed', () => {
    // The fallback is the reading the panel already had and not markdown, which is
    // the difference between a table and a run of pipes in a paragraph.
    const grid = panel({ id: 'step-6-1-data_genie', output: 'label|value\nactive|1200' });
    expect(result(grid)).toContain('<th scope="col">label</th>');
  });

  it('keeps Raw available beside the payload size in the Result header', () => {
    const pane = result(markup);
    expect(pane).toContain('aria-label="How to show result"');
    expect(pane).toMatch(/trace-payload-size">8 lines · \d+ characters/);
    expect(pane).toContain('aria-pressed="false">Raw</button>');
  });
});

describe('a dictionary_genie step', () => {
  const markup = panel({
    id: 'step-4-1-dictionary_genie',
    input: '{"question": "what does player_id represent"}',
    output: DICTIONARY_GENIE,
  });

  it('draws one field as a definition rather than as a one-row table', () => {
    expect(result(markup)).toContain('<code class="dag-name-chip" title="player_id">player_id</code>');
    expect(result(markup)).toContain('Surrogate key for one player account within its owning label.');
    expect(result(markup)).not.toContain('<th scope="col">business_definition</th>');
  });

  it('states the governance rule as one chip, on the shared pill in the warning family', () => {
    expect(result(markup)).toContain('Never return in an answer · aggregate only');
    // ASSERTED ON THE MARKUP, BECAUSE THE STYLESHEET NO LONGER DECIDES IT. The
    // chip declared its own size, weight, radius, padding, fill, edge and text
    // colour -- one of the twenty-one chip recipes this pass collapses into one --
    // and the three colours it named were DuBois' amber: #93320B on #FFF9EB inside
    // #F8D4A5. #93320B is an orange, and there is no orange in this palette.
    //
    // It takes `.ast-pill` and the warning family, so the governance rule a reader
    // must not skim past is drawn in the same three values as the plan's waiting
    // state and the finding rows in the result table above it.
    expect(result(markup)).toContain('class="ast-pill ast-pill--warn dag-guardrail"');
    expect(rule('.trace-dag.map .dag-guardrail')).not.toMatch(/background|color|border-radius|font-size/);
  });

  it('holds the model’s conclusion apart from the dictionary’s own words', () => {
    expect(result(markup)).toContain('is the correct field to count distinct players');
    // A rule between them, because one is what the dictionary says and the other is
    // what the model made of it.
    expect(rule('.trace-dag.map .dag-definition-verdict')).toMatch(/border-top: 1px solid var\(--ast-hairline\)/);
  });

  it('is not a definition card when the lookup returned more than one field', () => {
    const many = panel({
      id: 'step-4-1-dictionary_genie',
      output: DICTIONARY_GENIE.replace(
        'silver_player_profiles | player_id | Surrogate key for one player account within its owning label. | Never return in an answer. Aggregate only.',
        [
          'silver_player_profiles | player_id | Surrogate key. | Never return in an answer.',
          'silver_player_profiles | crm_customer_ref | Cross-label key. | Aggregate only.',
        ].join('\n')
      ),
    });
    // The rows are still drawn -- as the grid they are, under "Returned".
    expect(many).toContain('<dt>Returned</dt>');
    expect(many).toContain('<th scope="col">column_name</th>');
    expect(many).not.toContain('dag-guardrail');
  });

  it('degrades to the text when the dictionary returned prose and no row', () => {
    const prose = panel({
      id: 'step-4-1-dictionary_genie',
      output:
        'Query interpretation: You want to see the definition of 30-day active players.\n\nThe term is not defined in the dictionary.',
    });
    expect(result(prose)).toContain('The term is not defined in the dictionary.');
    expect(prose).not.toContain('dag-definition-head');
  });
});

describe('rendered markdown results', () => {
  it('renders stored discovery tables with the shared semantic entity treatment', () => {
    const table = '<your_catalog>.<your_schema>.gold_title_daily_summary';
    const markup = result(
      panel({
        id: 'inventory',
        name: 'Listed available tables',
        kind: 'discovery',
        input: '{}',
        output: `Declared tables:\n  - ${table}  [franchise: Contoso]`,
        tables: [table],
      })
    );

    expect(markup).toContain('1</span> table declared');
    expect(markup).toContain('entity-table-mark');
    expect(markup).toContain('data-entity-part="catalog"');
    expect(markup).toContain('data-entity-part="schema"');
    expect(markup).toContain('data-entity-part="table"');
    expect(markup).not.toContain('>{}<');
  });

  it.each([
    ['Data Source Finder', 'data_source_finder', 'agent'],
    ['Prepared the answer', 'synthesis', 'agent'],
    ['Listed available tables', 'inventory', 'discovery'],
  ])('renders declared table blocks in %s as compact shared entities', (name, id, kind) => {
    const markup = result(panel({ id, name, kind, input: 'what data is available?', output: DECLARED_TABLE_LIST }));
    for (const table of DECLARED_TABLES) {
      const [catalog, schema, object] = table.split('.');
      expect(markup).toContain(`data-entity-part="catalog">${catalog}</span>`);
      expect(markup).toContain(`data-entity-part="schema">${schema}</span>`);
      expect(markup).toContain(`data-entity-part="table">${object}</span>`);
    }
    expect(markup).toContain('aria-label="Declared tables, 3 tables"');
    expect(markup).toContain('3</span> tables declared');
    expect(markup).toContain('entity-table-list-meta">franchise: untagged</span>');
    expect(markup).toContain('entity-table-list-meta">franchise: Northwind</span>');
    expect(markup).toContain('entity-table-list-meta">franchise: Contoso</span>');
    expect(markup).not.toContain('This is the declared set in one listing.');
    expect(markup).not.toContain('A missing franchise tag means');
    expect(markup).not.toContain('Call describe_table');
    expect(markup).not.toContain('dag-structured-table-prose');
  });

  it('uses the same table-list renderer for live payloads and stored stage details', () => {
    const live = renderToStaticMarkup(<PayloadView text={DECLARED_TABLE_LIST} />);
    const stored = result(panel({ id: 'synthesis', kind: 'agent', output: DECLARED_TABLE_LIST }));
    expect(live.match(/entity-table-mark/g)).toHaveLength(DECLARED_TABLES.length);
    expect(stored.match(/entity-table-mark/g)).toHaveLength(DECLARED_TABLES.length);
    expect(live).toContain('dag-structured-table-result');
    expect(stored).toContain('dag-structured-table-result');
    for (const markup of [live, stored]) {
      expect(markup).not.toContain('This is the declared set');
      expect(markup).not.toContain('Call describe_table');
    }
  });

  it('removes the retired caption from Raw while preserving the table rows', () => {
    const raw = renderToStaticMarkup(<PayloadView text={DECLARED_TABLE_LIST} initialRaw />);
    for (const table of DECLARED_TABLES) expect(raw).toContain(table);
    expect(raw).not.toContain('This is the declared set');
    expect(raw).not.toContain('A missing franchise tag means');
    expect(raw).not.toContain('Call describe_table');
  });

  it('does not promote ordinary dotted prose without a structural list heading', () => {
    const prose =
      'The release 2.4.1 was discussed in docs.example.com, but this sentence does not declare a governed table.';
    const markup = result(panel({ id: 'synthesis', kind: 'agent', output: prose }));
    expect(markup).toContain(prose);
    expect(markup).not.toContain('dag-structured-table-result');
    expect(markup).not.toContain('data-entity-part="table"');
  });

  it('renders a heading, markdown table, and bold answer instead of leftover syntax', () => {
    const markup = result(
      panel({
        id: 'synthesis',
        kind: 'agent',
        name: 'Prepared the answer',
        output:
          '## DATA PACKAGE\n\n---\n\n| catalog.schema.table | players |\n| --- | ---: |\n| catalog.schema.players | 12,000 |\n\n**Prepared the answer.**\n\n```sql\nSELECT * FROM catalog.schema.players\n```',
      })
    );
    expect(markup).toContain('class="dag-md-head"');
    expect(markup).toContain('>DATA PACKAGE</strong>');
    expect(markup).toContain('class="dag-md-rule"');
    expect(markup).toContain('<table class="answer-table">');
    expect(markup).toContain('<strong>Prepared the answer.</strong>');
    expect(markup).toContain(
      '<pre class="dag-md-code"><code data-language="sql">SELECT * FROM catalog.schema.players</code></pre>'
    );
    expect(markup).not.toContain('| --- |');
    expect(markup).not.toContain('**Prepared');
    expect(markup).not.toContain('## DATA PACKAGE');
  });

  it('renders the reported DATA PACKAGE columns table in Run Explorer', () => {
    const output = [
      '## DATA PACKAGE',
      '',
      '- **Interpretation:** inspect the governed player fields.',
      '',
      '### Columns',
      '',
      '| Table | Column | Type | Description | Rows |',
      '|---|---|---|---|---:|',
      '| `player_profiles` | `player_id` | `STRING` | Stable identifier \u2014 not a display name | 14,421,932 |',
      '',
      '- **Sources:** `catalog.schema.player_profiles`.',
    ].join('\n');
    const markup = result(
      panel({
        id: 'data_source_finder',
        kind: 'agent',
        name: 'Prepared the data package',
        output,
      })
    );
    expect(markup).toContain('<table class="answer-table">');
    expect(markup).toContain('<th scope="col" data-align="left" data-wrap="atomic">Table</th>');
    expect(markup).toContain('<code class="dag-name-chip" title="player_profiles">player_profiles</code>');
    expect(markup).toContain('<td data-align="right" data-wrap="atomic">14,421,932</td>');
    // The one column that holds a sentence keeps wrapping; the rest are single
    // values a narrow panel must not break. See answer.css.
    expect(markup).toContain('data-wrap="prose">Stable identifier');
    expect(markup).not.toContain('|---|');
    expect(markup).not.toContain('`player_id`');
  });

  it('does not turn a whole prose block into one blue identifier chip', () => {
    const long =
      '`This is an entire paragraph with spaces and enough content that it must remain readable code, not a chip.`';
    const markup = result(panel({ id: 'synthesis', kind: 'agent', output: long }));
    expect(markup).toContain('class="dag-inline-code"');
    expect(markup).not.toContain('class="dag-name-chip"');
  });

  it('uses the same rendered-first reading in the Run Explorer timeline', () => {
    const markup = renderToStaticMarkup(
      <PayloadView text={'## DATA PACKAGE\n\n**Prepared.**\n\n```sql\nSELECT 1\n```'} />
    );
    expect(markup).toContain('aria-label="How to show this payload"');
    expect(markup).toMatch(/aria-pressed="true">Rendered<\/button>/);
    expect(markup).toContain('class="dag-md-head"');
    expect(markup).toContain('<strong>Prepared.</strong>');
    expect(markup).toContain('<pre class="dag-md-code"><code data-language="sql">SELECT 1</code></pre>');
    expect(markup).not.toContain('## DATA PACKAGE');
  });

  it('renders markdown arguments while leaving generated SQL as code', () => {
    const markup = panel({
      id: 'step-4-agent',
      kind: 'agent',
      input: JSON.stringify({
        context: '## Evidence\n\n**Governed** source',
        sql: 'SELECT * FROM governed.players',
      }),
      output: 'done',
    });
    expect(markup).toContain('class="dag-md-head"');
    expect(markup).toContain('<strong>Governed</strong>');
    expect(markup).not.toContain('## Evidence');
    expect(markup).toContain('class="dag-sql open"');
    expect(markup).toContain('semantic-code-keyword">SELECT</span>');
    expect(markup).toContain('governed.players');
  });
});

describe('a search_semantics step', () => {
  const markup = panel({
    id: 'step-2-1-search_semantics',
    input: '{"question": "players dataset player count", "kind": "table"}',
    output: SEMANTIC,
  });

  it('says how many tables matched, instead of opening on a notice to the model', () => {
    expect(result(markup)).toContain('2 tables matched');
    expect(result(markup)).toContain('definitions, not data');
    expect(markup).not.toContain('SEMANTIC SEARCH RESULTS');
    expect(markup).not.toContain('cached snapshot of grants');
  });

  it('draws each match as a row that says what it is and how wide it is', () => {
    expect(result(markup)).toContain('silver_player_profiles');
    expect(result(markup)).toContain('12 columns');
    expect(result(markup)).toContain('1 column');
    expect(result(markup)).toContain('uncertified');
    // The same segmented catalog/schema/table graphic used in answer prose is
    // kept here rather than collapsing this surface to a separate name recipe.
    expect(result(markup)).toContain('data-entity-part="schema"><your_schema></span>');
    expect(result(markup)).toContain('title="<your_catalog>.<your_schema>.silver_player_profiles"');
  });

  it('sets the column count in the face that can line a column of them up', () => {
    // A RIGHT-ALIGNED META COUNT, which is one of the four placements the numeral
    // rule names, and it is read DOWN the rows rather than in a sentence: every
    // match has one, at the same offset. The rule asked DM Sans for
    // `font-variant-numeric: tabular-nums` instead, which switches on nothing --
    // DM Sans in this repo declares no `tnum` feature and its digits are
    // proportional, a `1` being just over half the width of a `0` -- so the counts
    // could not line up however the stylesheet was written.
    expect(result(markup)).toContain('class="ast-num dag-col-count"');
    expect(rule('.trace-dag.map .dag-col-count')).not.toMatch(/font-family|tabular-nums/);
  });

  it('chips the certification as the shared outlined pill, not a recipe of its own', () => {
    // Outlined and not tinted, which is both what the detail spec names for this
    // chip and what the shared recipe offers for a chip on a tinted surface: the
    // row washes on hover, and a neutral tint on that wash reads as a rendering
    // fault. #46596B inside a #CBCBCB edge, 5.42:1, so it clears AA at 11px --
    // which the old rule reached by naming a one-off #445461 and explaining in a
    // comment why the token file's own secondary grey was not usable here.
    expect(result(markup)).toContain('class="ast-pill ast-pill--neutral-outline dag-cert"');
    expect(rule('.trace-dag.map .dag-cert')).not.toMatch(/color|border|font-size|padding/);
  });

  it('opens the first row and shuts the rest, so the panel is a list and not a wall', () => {
    expect(result(markup).match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(result(markup).match(/aria-expanded="false"/g)).toHaveLength(1);
    // The opened row is capped at ten; the complete list remains in Raw.
    expect(result(markup)).toContain('>player_id</code>');
    expect(result(markup)).toContain('class="dag-col-name"');
    expect(result(markup)).toContain('class="dag-col-type">string</span>');
    expect(result(markup)).toContain('+ 2 more columns');
    expect(result(markup)).toContain('>country_code</code>');
    expect(result(markup)).not.toContain('>favorite_title_code</code>');
    expect(result(markup)).not.toContain('>last_play_date</code>');
    expect(result(markup)).toContain('data-entity-part="catalog"');
    expect(result(markup)).toContain('data-entity-part="schema"');
    expect(result(markup)).toContain('data-entity-part="table"');
  });

  it('keeps what the search said it left out', () => {
    const budgeted = panel({
      id: 'step-2-1-search_semantics',
      output: SEMANTIC + '\n\n13 further entr(y/ies) matched and were left out to stay inside the result budget.',
    });
    expect(result(budgeted)).toContain('13 further entr(y/ies) matched');
  });

  it('labels the row for what the step did, and the filter as a chip beside it', () => {
    expect(markup).toContain('aria-label="Arguments payload"');
    expect(markup).toContain('tables only');
  });

  it('draws the question as a sentence with its names picked out', () => {
    // The question is English the model wrote, so it is set in the reading face
    // with only the identifiers in mono -- not as a mono block with a `question`
    // key in front of it, which is what a recorded payload looks like unread.
    const asked = panel({
      id: 'step-6-1-data_genie',
      input: '{"question": "How many distinct player_id values are in silver_player_profiles?"}',
      output: DATA_GENIE,
    });
    const question = asked.slice(
      asked.indexOf('aria-label="Arguments payload"'),
      asked.indexOf('aria-label="Result payload"')
    );
    expect(question).toContain('<code class="dag-name-chip" title="player_id">player_id</code>');
    expect(question).toContain(
      '<code class="dag-name-chip" title="silver_player_profiles">silver_player_profiles</code>'
    );
    expect(question).not.toContain('<b>question</b>');
  });

  it('degrades to the text when the search failed rather than matched', () => {
    const failed = panel({
      id: 'step-2-1-search_semantics',
      output: 'SEMANTIC SEARCH UNAVAILABLE. The index could not be reached: connection refused.',
    });
    expect(result(failed)).toContain('The index could not be reached: connection refused.');
    expect(failed).not.toContain('tables matched');
  });
});

describe('the step panel and the shapes in it are on one palette', () => {
  /**
   * The step detail chrome, every renderer, and the SQL and raw blocks.
   *
   * Bounded structurally rather than by line number: from the panel's own rule to
   * the keyframes that follow the last of the Advanced blocks. Everything above
   * `.dag-detail` in this file is the agent map and the rail, which is another
   * lane's, and this must not make a claim about it.
   */
  const PANEL = TRACE_CSS.slice(
    TRACE_CSS.indexOf('.trace-dag.map .dag-detail {'),
    TRACE_CSS.indexOf('@keyframes pulse')
  );

  it('is bounded where it says it is', () => {
    // A guard on the guard. If either marker moves or is renamed, the slice
    // silently becomes the whole file or none of it, and a test that asserts an
    // absence over an empty string passes for the wrong reason -- which is the one
    // failure mode a stylesheet test cannot afford, because it looks like green.
    expect(PANEL).toContain('.trace-dag.map .dag-detail-head {');
    expect(PANEL).toContain('.trace-dag.map .dag-raw-meta {');
    expect(PANEL, 'the agent map is above this and belongs to another lane').not.toContain('.dag-edge');
    expect(PANEL.length).toBeGreaterThan(4000);
  });

  it('spends no colour, size or radius that is not the astrolabe palette’s', () => {
    // THE OLDER SPELLINGS FAIL HERE RATHER THAN RENDERING SOMETHING PLAUSIBLE.
    // Every one of these resolved to a real value, so nothing in this panel looked
    // broken while half of it was on the previous palette -- and two of them were
    // oranges the palette does not contain: #93320B on the guardrail chip and
    // #BE501E on a finding row.
    const legacy = PANEL.match(
      /var\(--(?:db-[a-z0-9-]+|muted-foreground|border|card|primary|primary-foreground|radius-(?:sm|md|lg)|text-(?:xs|sm|base|lg)|success|destructive|chart-\d)\)/g
    );
    expect(legacy, `legacy tokens still in the step panel: ${[...new Set(legacy ?? [])].join(', ')}`).toBeNull();
  });

  it('asks DM Sans for tabular figures nowhere in the panel', () => {
    // The property does nothing in the face this app ships, so every use of it is
    // either inert or a column that does not line up. Where a figure in this panel
    // sits in a column or a right-aligned meta slot it is mono, either from
    // `.ast-num` on the markup or from `font-family` on a rule that also sets the
    // alignment; `font-variant-numeric` beside a mono family is redundant, and
    // without one it is a claim the font cannot honour.
    for (const [, body] of PANEL.matchAll(/\n([^\n{}]+\{[^}]*\})/g)) {
      if (!body.includes('tabular-nums')) continue;
      expect(body, `tabular-nums without a mono family: ${body.split('{')[0].trim()}`).toMatch(
        /font-family: (?:var\(--font-mono\)|inherit)/
      );
    }
  });
});

describe('an agent step that wrote up its findings', () => {
  const markup = panel({
    id: 'step-7-agent',
    name: 'Prepared the findings',
    kind: 'agent',
    input: 'Evidence gathered so far',
    output: FINDINGS,
  });

  it('renders the figure as bold text rather than as a wall of asterisks', () => {
    expect(result(markup)).toContain('<strong>12,000 distinct players</strong>');
    expect(result(markup)).not.toContain('**');
  });

  it('turns the inline label/value run into the rows it was written as', () => {
    expect(result(markup)).toContain('<dt>Table</dt>');
    expect(result(markup)).toContain('<dt>Key used</dt>');
    expect(result(markup)).toContain('<dt>Count</dt>');
    expect(result(markup)).toContain(
      '<code class="dag-name-chip" title="silver_player_profiles">silver_player_profiles</code>'
    );
    expect(result(markup)).not.toContain('**Source details:**');
  });

  it('gives the note a block of its own, because it qualifies the figure above it', () => {
    expect(result(markup)).toContain('dag-note-tag">Note</span>');
    expect(result(markup)).toContain('scoped per label');
    // A reader who skims to the figure and stops has to see that it has a caveat,
    // which is exactly what being the tail of the same paragraph prevented.
    expect(rule('.trace-dag.map .dag-note')).toMatch(/border-left: 3px solid/);
  });

  it('drops the offer to do more work, which is addressed to a live reader', () => {
    expect(result(markup)).not.toContain('let me know');
  });

  it('names the row for what the step was given', () => {
    expect(markup).toContain('aria-label="Arguments payload"');
    expect(markup).toContain('Evidence gathered so far');
  });

  it('degrades to markdown when the step wrote nothing but a sentence', () => {
    const plain = panel({ id: 'step-1-agent', kind: 'agent', output: 'search_semantics' });
    expect(result(plain)).toContain('search_semantics');
    expect(plain).not.toContain('dag-note');
  });

  it('does not crash or blank on a payload that is only markup-looking characters', () => {
    const odd = panel({ id: 'step-1-agent', kind: 'agent', output: '**** `` - - -\n\nNote:' });
    expect(odd).toContain('aria-label="Result payload"');
    expect(odd.length).toBeGreaterThan(200);
  });
});
