import { describe, expect, it } from 'vitest';
import { extractGenieResultTable, extractGenieSql, MissingSqlGateError, runGenieAccuracy, type GenieAsker } from './genie-accuracy';
import type { SqlExecutor } from './genie-result-execute';
import type { ExecutedTable } from '../../shared/benchmark-lab-v3';

function tableForSql(sql: string): ExecutedTable {
  const match = /select\s+(\d+)/i.exec(sql.trim());
  const value = match ? Number(match[1]) : 0;
  return { rowCount: 1, columns: [{ name: 'n', values: [value] }] };
}

function asker(script: Record<string, { sql?: string; error?: string; rows?: ExecutedTable }>): GenieAsker {
  return {
    async ask({ question }) {
      const next = script[question];
      if (!next) throw new Error(`unexpected question: ${question}`);
      if (next.error) throw new Error(next.error);
      return { sql: next.sql ?? '', note: 'scripted', rows: next.rows };
    },
  };
}

const sqlExecutor: SqlExecutor = async (sql) => ({ ok: true, table: tableForSql(sql) });

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

  it('reads a result table Genie already ran', () => {
    const table = extractGenieResultTable({
      message: {
        attachments: [{ query: { columns: ['n'], rows: [[1]] } }],
      },
    });
    expect(table?.rowCount).toBe(1);
    expect(table?.columns[0]?.values).toEqual([1]);
  });
});

describe('Genie accuracy run', () => {
  it('gates a complete suite when selected cases are missing SQL', async () => {
    await expect(
      runGenieAccuracy({
        spaceId: 'space-data',
        suiteKind: 'complete',
        rows: [
          { id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
          { id: '2', question: 'Skipped', groundTruthSql: '', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        ],
        asker: asker({}),
        executor: sqlExecutor,
      })
    ).rejects.toBeInstanceOf(MissingSqlGateError);
  });

  it('scores executed results on a partial suite and keeps missing SQL out of the denominator', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      spaceLabel: 'Player data',
      suiteKind: 'partial',
      datasetVersion: 'ds_v001',
      rows: [
        { id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Skipped', groundTruthSql: '', expectedAnswer: 'no sql', sqlCorrect: '', thumbs: '' },
        { id: '3', question: 'Wrong', groundTruthSql: 'SELECT 2', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      asker: asker({
        'How many?': { sql: 'select 1' },
        Wrong: { sql: 'SELECT 9' },
      }),
      executor: sqlExecutor,
      now: () => 1_700_000_000_000,
    });
    expect(result.matchingPolicyId).toBe('executed-result-equivalence');
    expect(result.datasetVersion).toBe('ds_v001');
    expect(result.suiteKind).toBe('partial');
    expect(result.score).toEqual({ passed: 1, total: 2, percent: 50, label: '1/2 = 50% · 1 not scored (warehouse or timeout)', excluded: 1 });
    expect(result.cases.map((entry) => entry.outcome)).toEqual(['pass', 'excluded', 'fail']);
    expect(result.cases[2]?.note).toContain('values for `n` do not match');
  });

  it('records an error as not passed instead of inventing a score', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      suiteKind: 'complete',
      rows: [{ id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' }],
      asker: asker({ 'How many?': { error: 'Genie finished with status FAILED.' } }),
      executor: sqlExecutor,
    });
    expect(result.cases[0]?.outcome).toBe('error');
    expect(result.cases[0]?.excluded).toBe(false);
    expect(result.score.label).toBe('0/1 = 0%');
  });

  it('does not call a slow Genie FAILED a warehouse timeout', async () => {
    let clock = 0;
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      suiteKind: 'complete',
      rows: [{ id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' }],
      asker: asker({ 'How many?': { error: 'Genie finished with status FAILED.' } }),
      executor: sqlExecutor,
      now: () => {
        const at = clock;
        clock += 51_000;
        return at;
      },
    });
    expect(result.cases[0]?.durationMs).toBeGreaterThanOrEqual(50_000);
    expect(result.cases[0]?.missKind).toBe('error');
    expect(result.cases[0]?.excluded).toBe(false);
    expect(result.score).toEqual({ passed: 0, total: 1, percent: 0, label: '0/1 = 0%', excluded: 0 });
  });

  it('still excludes a slow cancel or warehouse start', async () => {
    let clock = 0;
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      suiteKind: 'complete',
      rows: [
        { id: '1', question: 'Cancelled', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Warming', groundTruthSql: 'SELECT 2', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      asker: asker({
        Cancelled: { error: 'Genie finished with status CANCELLED.' },
        Warming: { error: 'warehouse is starting' },
      }),
      executor: sqlExecutor,
      now: () => {
        const at = clock;
        clock += 51_000;
        return at;
      },
    });
    expect(result.cases.map((entry) => entry.missKind)).toEqual(['timeout', 'warehouse']);
    expect(result.cases.every((entry) => entry.excluded)).toBe(true);
    expect(result.score.excluded).toBe(2);
  });

  it('keeps a starting warehouse out of the accuracy fraction', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      suiteKind: 'complete',
      rows: [
        { id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Warming', groundTruthSql: 'SELECT 2', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      asker: asker({
        'How many?': { sql: 'select 1' },
        Warming: { error: 'warehouse is starting' },
      }),
      executor: sqlExecutor,
    });
    expect(result.cases[1]?.missKind).toBe('warehouse');
    expect(result.cases[1]?.excluded).toBe(true);
    expect(result.score).toMatchObject({ passed: 1, total: 1, excluded: 1, percent: 100 });
    expect(result.score.label).toContain('1/1 = 100%');
    expect(result.score.label).toContain('1 not scored');
  });

  it('does not invent a pass from SQL text when no result table arrived', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      suiteKind: 'complete',
      rows: [{ id: '1', question: 'How many?', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' }],
      asker: asker({ 'How many?': { sql: 'select 1' } }),
    });
    expect(result.cases[0]?.outcome).toBe('excluded');
    expect(result.cases[0]?.note).toContain('No executed result table');
    expect(result.score.total).toBe(0);
  });

  it('passes extra columns and reordered rows, and fails under-selection', async () => {
    const ground: ExecutedTable = {
      rowCount: 2,
      columns: [
        { name: 'title', values: ['a', 'b'] },
        { name: 'active_players', values: [10, 20] },
      ],
    };
    const extra: ExecutedTable = {
      rowCount: 2,
      columns: [
        { name: 'title', values: ['b', 'a'] },
        { name: 'active_players', values: [20, 10] },
        { name: 'sessions', values: [1, 2] },
      ],
    };
    const under: ExecutedTable = {
      rowCount: 2,
      columns: [{ name: 'title', values: ['a', 'b'] }],
    };
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      suiteKind: 'complete',
      rows: [
        { id: '1', question: 'Extra', groundTruthSql: 'SELECT ground', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Under', groundTruthSql: 'SELECT ground', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      asker: asker({
        Extra: { sql: 'SELECT extra', rows: extra },
        Under: { sql: 'SELECT under', rows: under },
      }),
      executor: async (sql) => (sql.includes('ground') ? { ok: true, table: ground } : { ok: false, note: 'unused' }),
    });
    expect(result.cases[0]?.outcome).toBe('pass');
    expect(result.cases[1]?.outcome).toBe('fail');
    expect(result.cases[1]?.note).toContain('Under-selection');
  });

  it('fails predicted SQL that cannot execute, without scoring a warehouse start as Genie-wrong', async () => {
    const result = await runGenieAccuracy({
      spaceId: 'space-data',
      suiteKind: 'complete',
      rows: [
        { id: '1', question: 'Broken', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
        { id: '2', question: 'Warming', groundTruthSql: 'SELECT 1', expectedAnswer: '', sqlCorrect: '', thumbs: '' },
      ],
      asker: asker({
        Broken: { sql: 'SELECT bad' },
        Warming: { sql: 'SELECT wait' },
      }),
      executor: async (sql) => {
        if (sql.includes('bad')) return { ok: false, note: 'column `sessions` does not exist' };
        if (sql.includes('wait')) return { ok: false, note: 'warehouse is starting' };
        return { ok: true, table: tableForSql(sql) };
      },
    });
    expect(result.cases[0]?.outcome).toBe('fail');
    expect(result.cases[0]?.excluded).toBe(false);
    expect(result.cases[1]?.missKind).toBe('warehouse');
    expect(result.cases[1]?.excluded).toBe(true);
    expect(result.score).toMatchObject({ passed: 0, total: 1, excluded: 1 });
  });
});
