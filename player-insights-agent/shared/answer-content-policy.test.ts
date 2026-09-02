import { describe, expect, it } from 'vitest';
import {
  normalizeAnswerCaveat,
  normalizeReaderAnswer,
  normalizeReaderText,
  readerAnswerPlainText,
} from './answer-content-policy';

const SCREENSHOT_CAVEATS = [
  'Optional tail was clipped at the DSF handoff bound, so some metadata fields may be incomplete.',
  'Validation: Review the sources before using this result.',
  'All 12 tables are declared but read access depends on the caller’s Unity Catalog grants — a declared table is not a guarantee of row-level access.',
  'All 12 tables are untagged by franchise in the current catalog listing; franchise-scoped filtering is not available from metadata alone.',
];

describe('reader-facing answer content policy', () => {
  it('removes the screenshot banner and generic Keep in mind filler', () => {
    expect(normalizeReaderAnswer({ caveats: SCREENSHOT_CAVEATS, sql: '', sources: [] }).caveats).toEqual([]);
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
    'Franchise filtering is unreliable for this requested breakdown because 4 queried rows have no franchise tag.',
  ])('preserves a material warning: %s', (warning) => {
    expect(normalizeAnswerCaveat(warning)).toBe(warning);
  });

  it.each([
    'Review the generated SQL and source details before using this result.',
    'Validation: Review the generated SQL before using this result.',
    'Validation: Review the sources before using this result.',
    'Verify the sources before using the result.',
    'Check source details.',
  ])('removes generic validation regardless of attached evidence: %s', (caveat) => {
    expect(
      normalizeAnswerCaveat(caveat, {
        sql: 'SELECT 1',
        sources: [{ name: 'main.analytics.players' }],
      })
    ).toBeNull();
  });

  it('removes a boilerplate validation prefix but preserves its concrete warning', () => {
    expect(
      normalizeAnswerCaveat('Validation: Query failed for main.analytics.players; retry after restoring access.')
    ).toBe('Query failed for main.analytics.players; retry after restoring access.');
  });

  it('removes process-only sections while preserving quoted user content', () => {
    const narrative = [
      'The catalog contains 12 tables.',
      '',
      '> "No SQL was generated or executed."',
      '> "Validation: Review the sources before using this result."',
      '',
      '- **Package note:** Optional detail was clipped at the DSF handoff bound.',
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
    expect(normalized).toContain('> "Validation: Review the sources before using this result."');
    expect(normalized).not.toContain('Package note');
    expect(normalized).not.toContain('What wasn’t done');
    expect(normalized).not.toContain('No governed table was read for this answer.');
    expect(normalized).toContain('## Next step');
  });

  it('uses the same normalized content for live, stored, and plain-text export paths', () => {
    const raw = {
      takeaway: 'Tables available for analysis.',
      narrative: 'Use `data_dictionary` for field definitions.',
      caveats: [
        ...SCREENSHOT_CAVEATS,
        'Permission denied while reading main.analytics.private_players.',
        'Permission denied while reading main.analytics.private_players!',
      ],
      sql: '',
      sources: [],
    };
    const live = normalizeReaderAnswer(raw);
    const stored = normalizeReaderAnswer(JSON.parse(JSON.stringify(raw)) as typeof raw);
    expect(stored).toEqual(live);
    const exported = readerAnswerPlainText(raw);
    expect(live.caveats).toEqual(['Permission denied while reading main.analytics.private_players.']);
    expect(exported).toContain('Permission denied while reading main.analytics.private_players.');
    expect(exported).not.toMatch(/partial evidence|optional tail|validation:|declared table is not|untagged/i);
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
