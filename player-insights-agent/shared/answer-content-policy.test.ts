import { describe, expect, it } from 'vitest';
import {
  normalizeAnswerCaveat,
  normalizeReaderAnswer,
  normalizeReaderText,
  readerAnswerPlainText,
} from './answer-content-policy';

const SCREENSHOT_CAVEATS = [
  'No governed table was read for this answer, so it is not grounded in queried data.',
  'Review the generated SQL and source details before using this result.',
  'All 12 tables are untagged (no franchise label); this means franchise scope is unknown until a table is described or queried.',
];

describe('reader-facing answer content policy', () => {
  it('cleans the dataset overview without inventing SQL or source details', () => {
    expect(normalizeReaderAnswer({ caveats: SCREENSHOT_CAVEATS, sql: '', sources: [] }).caveats).toEqual([
      'Scope: The 12 listed tables span the configured dataset. Confirm franchise scope from table definitions before operational use.',
    ]);
  });

  it('handles legacy exact phrases and narrowly anchored paraphrases', () => {
    const caveats = [
      'No MLflow trace was recorded for this answer, so it cannot be opened in MLflow.',
      'This answer is not grounded in queried data.',
      'This answer did not query any governed tables and therefore is not grounded in source data.',
      'No SQL was generated or executed.',
      'No source/citation/tool was used.',
      'The agent did not inspect any tables.',
    ];
    expect(normalizeReaderAnswer({ caveats }).caveats).toEqual([]);
  });

  it('omits presentation-only notes about results left out of figures', () => {
    expect(
      normalizeAnswerCaveat(
        'Meridian Drift and Harbor City Nights are close in rank but omitted from figures due to the 6-figure limit.'
      )
    ).toBeNull();
    expect(
      normalizeAnswerCaveat('Terrace Rally 27 is not shown in figures but is included in the narrative.')
    ).toBeNull();
  });

  it.each([
    'The query failed with TABLE_OR_VIEW_NOT_FOUND; check the table name.',
    'The agent could not execute the query because the table was not found.',
    'Permission denied while reading main.analytics.players.',
    'Source data is stale as of 2026-01-01.',
    'The source data is incomplete for 3 of 12 regions.',
    'Conflicting evidence exists between the daily and monthly tables.',
    'This request is unsupported for streaming tables.',
    'Missing required input: choose a franchise.',
    'Data quality warning: duplicate player ids affect this total.',
  ])('preserves a material warning: %s', (warning) => {
    expect(normalizeAnswerCaveat(warning)).toBe(warning);
  });

  it('keeps generated SQL and source review conditional on evidence', () => {
    const caveat = 'Review the generated SQL and source details before using this result.';
    expect(normalizeAnswerCaveat(caveat, {})).toBeNull();
    expect(normalizeAnswerCaveat(caveat, { sql: 'SELECT 1' })).toBe(
      'Validation: Review the generated SQL before using this result.'
    );
    expect(normalizeAnswerCaveat(caveat, { sources: [{ name: 'main.analytics.players' }] })).toBe(
      'Validation: Review the sources before using this result.'
    );
    expect(
      normalizeAnswerCaveat(caveat, {
        sql: 'SELECT 1',
        sources: [{ name: 'main.analytics.players' }],
      })
    ).toBe('Validation: Review the generated SQL and sources before using this result.');
  });

  it('removes process-only sections while preserving quoted user content', () => {
    const narrative = [
      'The catalog contains 12 tables.',
      '',
      '> "No SQL was generated or executed."',
      '',
      '## What wasn’t done',
      'No governed table was read for this answer.',
      'No source was used.',
      '',
      '## Next step',
      'Describe the table before building operational logic.',
    ].join('\n');
    const normalized = normalizeReaderText(narrative);
    expect(normalized).toContain('The catalog contains 12 tables.');
    expect(normalized).toContain('> "No SQL was generated or executed."');
    expect(normalized).not.toContain('What wasn’t done');
    expect(normalized).not.toContain('No governed table was read for this answer.');
    expect(normalized).toContain('## Next step');
  });

  it('uses the same normalized content for live, stored, and plain-text export paths', () => {
    const raw = {
      takeaway: 'Tables available for analysis.',
      narrative: 'Use `data_dictionary` for field definitions.',
      caveats: SCREENSHOT_CAVEATS,
      sql: '',
      sources: [],
    };
    const live = normalizeReaderAnswer(raw);
    const stored = normalizeReaderAnswer(JSON.parse(JSON.stringify(raw)) as typeof raw);
    expect(stored).toEqual(live);
    const exported = readerAnswerPlainText(raw);
    expect(exported).toContain(live.caveats[0]);
    expect(exported).not.toMatch(/no governed table|not grounded|generated SQL|source details/i);
  });

  it('turns legacy format-process narration into an actionable failure', () => {
    expect(
      normalizeAnswerCaveat('This answer is degraded: no structured result arrived and no tool steps were recorded.')
    ).toBe('This answer is degraded: the response format was incomplete. Retry the question before using this result.');
    expect(normalizeReaderText('The agent did not return a structured result.', {}, 'takeaway')).toBe(
      'Answer format incomplete. Retry the question.'
    );
  });
});
