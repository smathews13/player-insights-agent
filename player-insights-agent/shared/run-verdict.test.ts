import { describe, expect, it } from 'vitest';
import { answerHasLanded, answerRunVerdict, runVerdict } from './run-verdict';

const INCOMPLETE =
  'The sources for this answer are incomplete: part of it came from a query whose tables could not be determined.';
const DEADLINE = 'The turn deadline was reached before the answer could be written.';
const TABLE = [
  'VLH Online led the window.',
  '',
  '| Franchise | Unique players |',
  '| --- | ---: |',
  '| VLH | 6655 |',
  '| Iron Frontier | 5370 |',
].join('\n');
const FIGURES = [{ label: 'VLH unique players', value: 6655, display: '6,655' }];

describe('whether an answer actually landed', () => {
  it('treats figures or a pipe table as a landed answer', () => {
    expect(answerHasLanded({ figures: FIGURES })).toBe(true);
    expect(answerHasLanded({ narrative: TABLE })).toBe(true);
    expect(answerHasLanded({ narrative: '', figures: [] })).toBe(false);
    expect(answerHasLanded({ narrative: 'This question was not answered.' })).toBe(false);
  });
});

describe('the verdict a caveat cannot steal', () => {
  it('does not fail a payload with tables and an incomplete-sources note', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: [INCOMPLETE, DEADLINE],
        figures: FIGURES,
        narrative: TABLE,
      })
    ).toBe('complete');
  });

  it('does not call a deadline note Partial once figures are on the card', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: [DEADLINE],
        figures: FIGURES,
      })
    ).toBe('complete');
  });

  it('still fails a zero-step empty run', () => {
    expect(answerRunVerdict({ stages: [], caveats: [] })).toBe('failed');
    expect(runVerdict([])).toBe('failed');
    expect(answerRunVerdict({ stages: [], caveats: [INCOMPLETE], figures: FIGURES })).toBe('failed');
  });

  it('still fails a run that stopped after steps with nothing on the card', () => {
    expect(
      answerRunVerdict({
        stages: [
          { id: 'step-1', status: 'complete' },
          { id: 'step-2', status: 'failed' },
        ],
        caveats: ['This question was not answered.'],
        figures: [],
        narrative: '',
      })
    ).toBe('failed');
  });

  it('still marks a deadline without a landed answer as partial', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: [DEADLINE],
        figures: [],
        narrative: '',
      })
    ).toBe('partial');
  });
});
