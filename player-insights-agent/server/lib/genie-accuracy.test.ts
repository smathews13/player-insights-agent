import { describe, expect, it } from 'vitest';
import { extractGenieSql, runGenieAccuracy, type GenieAsker } from './genie-accuracy';

function asker(script: Record<string, { sql?: string; error?: string }>): GenieAsker {
  return {
    async ask({ question }) {
      const next = script[question];
      if (!next) throw new Error(`unexpected question: ${question}`);
      if (next.error) throw new Error(next.error);
      return { sql: next.sql ?? '', note: 'scripted' };
    },
  };
}

describe('Genie SQL extraction', () => {
  it('reads the statement from a conversation attachment', () => {
    expect(
      extractGenieSql({
        message: {
          status: 'COMPLETED',
          attachments: [{ query: { query: 'SELECT count(*) FROM cat.sch.players' } }],
        },
      })
    ).toBe('SELECT count(*) FROM cat.sch.players');
  });
});

describe('Genie accuracy run', () => {
  it('scores passes over the SQL-backed rows only', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      spaceLabel: 'Player data',
      rows: [
        { id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Skipped', groundTruthSql: '', expectedAnswer: 'no sql', sqlCorrect: '', thumbs: '' },
        { id: '3', question: 'Wrong', groundTruthSql: 'SELECT 2', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      asker: asker({
        'How many?': { sql: 'select 1' },
        Wrong: { sql: 'SELECT 9' },
      }),
      now: () => 1_700_000_000_000,
    });
    expect(result.score).toEqual({ passed: 1, total: 2, percent: 50, label: '1/2 = 50%', excluded: 0 });
    expect(result.cases.map((entry) => entry.outcome)).toEqual(['pass', 'fail']);
  });

  it('records an error as not passed instead of inventing a score', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      rows: [{ id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' }],
      asker: asker({ 'How many?': { error: 'Genie finished with status FAILED.' } }),
    });
    expect(result.cases[0]?.outcome).toBe('error');
    expect(result.cases[0]?.excluded).toBe(false);
    expect(result.score.label).toBe('0/1 = 0%');
  });

  it('keeps a starting warehouse out of the accuracy fraction', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      rows: [
        { id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Warming', groundTruthSql: 'SELECT 2', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      asker: asker({
        'How many?': { sql: 'select 1' },
        Warming: { error: 'warehouse is starting' },
      }),
    });
    expect(result.cases[1]?.missKind).toBe('warehouse');
    expect(result.cases[1]?.excluded).toBe(true);
    expect(result.score).toMatchObject({ passed: 1, total: 1, excluded: 1, percent: 100 });
    expect(result.score.label).toContain('1/1 = 100%');
    expect(result.score.label).toContain('1 not scored');
  });
});
