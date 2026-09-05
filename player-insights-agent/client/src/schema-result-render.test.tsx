import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SchemaResultView } from './StepResult';
import { RawPayload } from './TraceTimeline';
import { schemaResult } from './step-results';

const CSS = readFileSync(new URL('./styles/trace.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-runs.css', import.meta.url), 'utf8');
const DAG = readFileSync(new URL('./TraceDag.tsx', import.meta.url), 'utf8');
const TIMELINE = readFileSync(new URL('./TraceTimeline.tsx', import.meta.url), 'utf8');
const ANSWER = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const MONITORING = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');
const EXPLORER = readFileSync(new URL('./RunExplorer.tsx', import.meta.url), 'utf8');
const DETAILS = readFileSync(new URL('./RunDetails.tsx', import.meta.url), 'utf8');

const PURCHASES = `<your_catalog>.<your_schema>.silver_purchases
Table comment: Windowed purchases with SKU detail, net bookings, and the same guardrail and integrity verdicts as gameplay
purchase_id: string
player_id: string
platformid_accountid: string
partner_player_ref: string
label: string
transaction_label: string
brand_scope_status: string
title_code: string
title_name: string
platform: string
platform_generation: string
purchase_date: date
sku_id: string
sku_name: string
item_category: string
is_recurrent_consumer_spending: boolean
list_price_usd: decimal(12,2)
net_bookings_usd: decimal(12,2)
purchase_status: string
storefront: string
marketing_region: string
country_code: string
integrity_status: string
`;

const PROFILES = `<your_catalog>.<your_schema>.silver_player_profiles
Table comment: Validated player profiles with explicit email eligibility and identity scope
player_id: string
platformid_accountid: string
partner_player_ref: string
crm_customer_ref: string
label: string
primary_platform: string
platform_generation: string
display_name: string
marketing_region: string
country_code: string
region_code: string
favorite_title_code: string
email: string
email_marketing_consent: boolean
email_addressability_status: string
is_email_addressable: boolean
identity_use_scope: string
identity_confidence: decimal(5,4)
signup_date: date
snapshot_date: date
`;

describe('canonical describe-table schema results', () => {
  it('parses and renders every line of the 26-line purchases fixture', () => {
    expect(PURCHASES.split('\n')).toHaveLength(26);
    const result = schemaResult(PURCHASES);
    expect(result).not.toBeNull();
    if (!result) throw new Error('Purchases fixture did not parse');
    expect(result.table).toBe('<your_catalog>.<your_schema>.silver_purchases');
    expect(result.columns).toHaveLength(23);
    expect(result.columns[result.columns.length - 1]).toEqual({ name: 'integrity_status', type: 'string' });

    const markup = renderToStaticMarkup(<SchemaResultView result={result} />);
    expect(markup).toContain('data-entity-part="catalog"');
    expect(markup).toContain('data-entity-part="schema"');
    expect(markup).toContain('data-entity-part="table"');
    expect(markup).toContain('<th scope="col">Column</th><th scope="col">Type</th>');
    expect(markup.match(/class="dag-schema-column-token"/g)).toHaveLength(23);
    expect(markup).toContain('>list_price_usd</code>');
    expect(markup).toContain('>decimal(12,2)</code>');
    expect(markup.indexOf('</header>')).toBeLessThan(markup.indexOf('class="dag-schema-comment"'));
  });

  it('parses the complete 23-line profiles fixture without joining its comment to the object', () => {
    expect(PROFILES.split('\n')).toHaveLength(23);
    const result = schemaResult(PROFILES);
    expect(result).not.toBeNull();
    if (!result) throw new Error('Profiles fixture did not parse');
    expect(result.columns).toHaveLength(20);
    const markup = renderToStaticMarkup(<SchemaResultView result={result} />);

    expect(markup).toContain('silver_player_profiles');
    expect(markup).toContain('Table comment</strong><p>Validated player profiles');
    expect(markup.match(/class="dag-schema-column-token"/g)).toHaveLength(20);
    expect(markup).toContain('>identity_confidence</code>');
    expect(markup).toContain('>decimal(5,4)</code>');
  });

  it('preserves type punctuation, optional comments, and long wrapping content', () => {
    const result = schemaResult(
      [
        'catalog_name.schema_name.table_name',
        'Table comment: A very long comment: its punctuation and words remain intact at narrow widths.',
        'long_column_name_that_must_wrap_without_clipping: struct<amount:decimal(12,2)>',
      ].join('\n')
    );
    expect(result).toEqual({
      table: 'catalog_name.schema_name.table_name',
      comment: 'A very long comment: its punctuation and words remain intact at narrow widths.',
      columns: [
        {
          name: 'long_column_name_that_must_wrap_without_clipping',
          type: 'struct<amount:decimal(12,2)>',
        },
      ],
    });
    expect(schemaResult('a_catalog.a_schema.a_table\nplayer_id: string')?.comment).toBeNull();
  });

  it('rejects partial and prose-like shapes so the existing renderer keeps every line', () => {
    for (const malformed of [
      'The table a_catalog.a_schema.a_table has player_id: string.',
      'a_catalog.a_schema.a_table\nTable comment: comment only',
      'a_catalog.a_schema.a_table\nplayer_id: string\nthis line cannot be parsed',
      'a_catalog.a_schema.a_table\nsummary: this is arbitrary prose',
      'a_catalog.a_schema\nplayer_id: string',
    ]) {
      expect(schemaResult(malformed), malformed).toBeNull();
    }
  });

  it('leaves the Raw projection byte-for-byte unchanged', () => {
    const markup = renderToStaticMarkup(
      <RawPayload
        payload={{
          body: PURCHASES,
          chars: PURCHASES.length,
          empty: false,
          fields: null,
          lines: PURCHASES.split('\n').length,
          truncated: false,
        }}
      />
    );
    expect(markup).toContain(PURCHASES);
  });

  it('shares one parser and renderer across every trace host', () => {
    expect(DAG).toContain('schemaResult(text)');
    expect(DAG).toContain('<SchemaResultView');
    expect(TIMELINE).toContain('schemaResult(payload.body)');
    expect(TIMELINE).toContain('<SchemaResultView');
    expect(ANSWER).toContain('<TraceTimeline');
    expect(MONITORING).toContain('<AnswerCard');
    expect(DETAILS).toContain('<PayloadView');
    expect(EXPLORER).toContain('<TraceDag');
    expect(EXPLORER).toContain('<TraceTimeline');
  });

  it('wraps and grows naturally without a schema sub-scroller', () => {
    for (const selector of ['dag-schema-result', 'dag-schema-object', 'dag-schema-comment', 'dag-schema-columns']) {
      const body = CSS.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, selector).not.toMatch(/max-height|overflow(?:-x|-y)?:\s*(auto|scroll)/);
    }
    expect(CSS).toMatch(/\.dag-schema-object \{[^}]*overflow-wrap: anywhere/s);
    expect(CSS).toMatch(/\.dag-schema-columns \{[^}]*table-layout: fixed/s);
    expect(RESPONSIVE).toMatch(/@media \(max-width: 960px\)[\s\S]*\.dag-schema-columns td[\s\S]*display: block/);
  });
});
