import { describe, expect, it } from 'vitest';
import type { EvalRow } from '../../shared/eval-dataset';
import { alignGuidelinesToHumans, guidelinesFromAlignBody, tryMLflowJudgeAlign } from './judge-alignment';

function row(partial: Partial<EvalRow> = {}): EvalRow {
  return {
    id: '1',
    question: 'How many players?',
    groundTruthSql: '',
    expectedAnswer: 'Count them.',
    sqlCorrect: '',
    thumbs: 'down',
    ...partial,
  };
}

describe('align guidelines to human labels', () => {
  it('uses MLflow judge.align when the workspace returns a rubric', async () => {
    const result = await alignGuidelinesToHumans({
      base: 'Be professional.',
      rows: [row()],
      cases: [
        {
          question: 'How many players?',
          judgements: [{ name: 'guidelines', state: 'scored', value: 'yes' }],
        },
      ],
      alignClient: {
        request: async () => ({ instructions: 'Stay on labelled SQL only.' }),
      },
    });
    expect(result.method).toBe('mlflow');
    expect(result.guidelinesText).toBe('Stay on labelled SQL only.');
    expect(result.agreement.agreed).toBe(0);
    expect(result.agreement.compared).toBe(1);
  });

  it('rewrites the rubric with the judge model when align is blocked', async () => {
    const result = await alignGuidelinesToHumans({
      base: 'Be professional.\nHuman labels:\nold dump',
      rows: [row()],
      cases: [],
      alignClient: {
        request: async () => {
          throw new Error('403 missing scope');
        },
      },
      invokeJudge: async () => ({
        choices: [{ message: { content: '{"guidelines":"Match the labelled expected answer.","result":"yes"}' } }],
      }),
    });
    expect(result.method).toBe('rewrite');
    expect(result.guidelinesText).toBe('Match the labelled expected answer.');
    expect(result.guidelinesText).not.toContain('Human labels:');
  });

  it('distils a replacement rubric when neither API nor judge can run', async () => {
    const result = await alignGuidelinesToHumans({
      base: 'Be professional.',
      rows: [row({ sqlCorrect: 'no' })],
      cases: [],
    });
    expect(result.method).toBe('distill');
    expect(result.guidelinesText).toContain('Be professional.');
    expect(result.guidelinesText).toContain('Published SQL must match');
    expect(result.guidelinesText).not.toContain('Human labels:');
    expect(result.note).toContain('not available');
  });

  it('does not invent an align result from an empty body', async () => {
    expect(guidelinesFromAlignBody({ status: 'ok' })).toBe('');
    await expect(
      tryMLflowJudgeAlign(
        { request: async () => ({ status: 'ok' }) },
        { experimentId: '', guidelines: 'x', pairs: [] }
      )
    ).rejects.toThrow();
  });
});
