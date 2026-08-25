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
    await writeEvalDataset(writer as never, dataset, 'admin@example.com');
    expect(writer.calls[0]?.sql).toContain(EVAL_DATASET_TABLE);
    expect(writer.calls[0]?.values?.[0]).toBe('effective');
    expect(writer.calls[0]?.values?.[2]).toBe('admin@example.com');

    const reader = client([{ rows: dataset.rows }]);
    forgetEvalDataset();
    expect((await readEvalDataset(reader as never, { maxAgeMs: 0 })).rows[0]?.question).toBe('How many players?');
  });
});
