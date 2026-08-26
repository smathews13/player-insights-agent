import { describe, expect, it } from 'vitest';
import type { EvalRow } from './eval-dataset';
import {
  agreementFromPairs,
  alignmentRewritePrompt,
  distillGuidelinesFromLabels,
  humanVerdictFromRow,
  pairLabelsWithCases,
  parseAlignedGuidelines,
  stripAppendedHumanLabels,
} from './eval-judge-alignment';

function row(partial: Partial<EvalRow>): EvalRow {
  return {
    id: '1',
    question: 'How many players?',
    groundTruthSql: '',
    expectedAnswer: 'Count active players.',
    sqlCorrect: '',
    thumbs: '',
    ...partial,
  };
}

describe('judge alignment to human labels', () => {
  it('reads thumbs first, then SQL correct', () => {
    expect(humanVerdictFromRow(row({ thumbs: 'up', sqlCorrect: 'no' }))).toBe('yes');
    expect(humanVerdictFromRow(row({ thumbs: 'down' }))).toBe('no');
    expect(humanVerdictFromRow(row({ sqlCorrect: 'yes' }))).toBe('yes');
    expect(humanVerdictFromRow(row({}))).toBeNull();
  });

  it('pairs a labelled question with the last guidelines judge', () => {
    const pairs = pairLabelsWithCases(
      [row({ thumbs: 'down' })],
      [
        {
          question: 'How many players?',
          judgements: [{ name: 'guidelines', state: 'scored', value: 'yes' }],
        },
      ]
    );
    expect(pairs).toEqual([
      { question: 'How many players?', human: 'no', judge: 'yes', agree: false },
    ]);
    expect(agreementFromPairs(pairs).label).toContain('0/1');
  });

  it('replaces the rubric instead of appending Human labels', () => {
    const aligned = distillGuidelinesFromLabels('Be professional.\nHuman labels:\nWhen asked "x"', [
      row({ sqlCorrect: 'no', thumbs: 'down' }),
    ]);
    expect(aligned).toContain('Be professional.');
    expect(aligned).not.toContain('Human labels:');
    expect(aligned).toContain('Published SQL must match');
    expect(aligned).toContain('thumbs-down');
  });

  it('leaves the stem alone when nobody labelled a row', () => {
    expect(distillGuidelinesFromLabels('Be professional.', [row({})])).toBe('Be professional.');
    expect(stripAppendedHumanLabels('Be professional.\nHuman labels:\nextra')).toBe('Be professional.');
  });

  it('asks the judge model for replacement guidelines, not an append', () => {
    const prompt = alignmentRewritePrompt('Be professional.', [
      { question: 'How many players?', human: 'no', judge: 'yes', agree: false },
    ]);
    expect(prompt).toContain('Rewrite the guidelines');
    expect(prompt).toContain('Human verdict: no');
    expect(prompt).toContain('Do not append a "Human labels:" list');
  });

  it('reads replacement guidelines out of the judge JSON', () => {
    expect(parseAlignedGuidelines('{"guidelines":"Stay on the labelled SQL.","result":"yes"}')).toBe(
      'Stay on the labelled SQL.'
    );
    expect(parseAlignedGuidelines('not json and not empty')).toBe('not json and not empty');
    expect(parseAlignedGuidelines('{"result":"yes"}')).toBeNull();
  });
});
