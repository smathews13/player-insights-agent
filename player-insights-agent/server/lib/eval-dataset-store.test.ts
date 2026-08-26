import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import { EMPTY_EVAL_DATASET } from '../../shared/eval-dataset';
import {
  EVAL_DATASET_TABLE,
  forgetEvalDataset,
  readEvalDataset,
  writeEvalDataset,
} from './eval-dataset-store';

function client(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('evaluation dataset persistence', () => {
  it('qualifies the table with APP_SCHEMA', () => {
    expect(EVAL_DATASET_TABLE).toBe(`${APP_SCHEMA}.eval_dataset`);
    const source = fs.readFileSync(path.join(__dirname, 'eval-dataset-store.ts'), 'utf8');
    expect(source).toContain("appTable('eval_dataset')");
  });

  it('reads an empty set when nothing has been saved', async () => {
    forgetEvalDataset();
    expect(await readEvalDataset(client() as never, { maxAgeMs: 0 })).toEqual(EMPTY_EVAL_DATASET);
  });

  it('writes the rows as JSON and reads them back', async () => {
    const dataset = {
      rows: [
        {
          id: 'q-1',
          question: 'How many players?',
          groundTruthSql: 'SELECT 1',
          expectedAnswer: '',
          sqlCorrect: '' as const,
          thumbs: '' as const,
        },
      ],
    };
    const writer = client();
    forgetEvalDataset();
    await writeEvalDataset(writer as never, dataset, 'admin@example.com');
    const insert = writer.calls.find((call) => call.sql.includes('INSERT'));
    expect(insert?.sql).toContain(EVAL_DATASET_TABLE);
    expect(insert?.values?.[0]).toBe('effective');
    expect(insert?.values?.[2]).toBe('admin@example.com');
    const stored = JSON.parse(String(insert?.values?.[1])) as { rows?: { question?: string }[] };
    expect(stored.rows?.[0]?.question).toBe('How many players?');

    const reader = client([{ rows: dataset.rows }]);
    forgetEvalDataset();
    expect((await readEvalDataset(reader as never, { maxAgeMs: 0 })).rows[0]?.question).toBe('How many players?');
  });

  it('reads a legacy JSON array and an envelope with a last Genie run', async () => {
    forgetEvalDataset();
    const legacy = await readEvalDataset(
      client([{ rows: [{ id: 'q-1', question: 'How many?', groundTruthSql: '', expectedAnswer: '', sqlCorrect: '', thumbs: '' }] }]) as never,
      { maxAgeMs: 0 }
    );
    expect(legacy.rows[0]?.question).toBe('How many?');
  });

  it('keeps a held-out lock when the next save omits lab extras', async () => {
    forgetEvalDataset();
    const store = client([
      {
        rows: [
          {
            id: 'q-1',
            question: 'How many players?',
            groundTruthSql: 'SELECT 1',
            expectedAnswer: '',
            sqlCorrect: '',
            thumbs: '',
            tag: 'edge_case',
            split: 'held_out',
            heldOutLockedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      },
    ]);
    const saved = await writeEvalDataset(
      store as never,
      {
        rows: [
          {
            id: 'q-1',
            question: 'How many players now?',
            groundTruthSql: 'SELECT 1',
            expectedAnswer: '',
            sqlCorrect: '',
            thumbs: '',
          },
        ],
      },
      'admin@example.com'
    );
    expect(saved.rows[0]?.question).toBe('How many players now?');
    expect(saved.rows[0]?.tag).toBe('edge_case');
    expect(saved.rows[0]?.split).toBe('held_out');
    expect(saved.rows[0]?.heldOutLockedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});
