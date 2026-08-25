import { describe, expect, it } from 'vitest';
import {
  answerHasLanded,
  answerRunVerdict,
  DSF_CLIP_NOTE,
  runVerdict,
  takeawayWhenTablesLanded,
  TIME_LIMIT_TAKEAWAY,
  WRITER_STOPPED_CAVEAT,
} from './run-verdict';

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
        caveats: [INCOMPLETE],
        figures: FIGURES,
        narrative: TABLE,
      })
    ).toBe('complete');
  });

  it('does not call incomplete sources Partial once figures are on the card', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: [INCOMPLETE],
        figures: FIGURES,
      })
    ).toBe('complete');
  });

  it('does not call a deadline note Partial once the writer finished and tables landed', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: [DEADLINE],
        figures: FIGURES,
        narrative: TABLE,
      })
    ).toBe('complete');
  });

  it('does not call a finished answer Partial because a tool step missed', () => {
    expect(
      answerRunVerdict({
        stages: [
          { id: 'sql', status: 'failed' },
          { id: 'synthesis', status: 'complete' },
        ],
        caveats: [INCOMPLETE, DEADLINE],
        figures: FIGURES,
        narrative: TABLE,
      })
    ).toBe('complete');
  });

  it('keeps a catalog listing Complete when the writer finished', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: [
          'Declaring a table does not guarantee read access; Unity Catalog grants are evaluated per query and a refusal will be named explicitly if it occurs.',
        ],
        narrative:
          'This deployment has access to 12 declared tables.\n\n| LAYER | TABLE |\n| Raw | raw_gameplay_activity |',
      })
    ).toBe('complete');
  });

  it('keeps a 12-table catalog listing Complete when DSF clipped optional detail', () => {
    const listing = [
      'All 12 declared tables live in <your_catalog>.<your_schema>.',
      '',
      '| Table | Purpose |',
      '| --- | --- |',
      '| gold_player_180d_summary | Per-player aggregates |',
      '',
      '- **Package note:** Optional detail was clipped at the DSF handoff bound.',
    ].join('\n');
    expect(DSF_CLIP_NOTE.test('Optional detail was clipped at the DSF handoff bound.')).toBe(true);
    expect(WRITER_STOPPED_CAVEAT.test('Optional detail was clipped at the DSF handoff bound.')).toBe(false);
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'partial' }],
        caveats: [],
        narrative: listing,
      })
    ).toBe('complete');
  });

  it('calls a writer timeout after tables landed Partial, not Failed or unanswered', () => {
    expect(
      answerRunVerdict({
        stages: [
          { id: 'sql', status: 'complete' },
          { id: 'synthesis', status: 'failed' },
        ],
        caveats: [
          'The model that writes the answer was not reachable: APITimeoutError: Request timed out.',
        ],
        narrative: TABLE,
      })
    ).toBe('partial');
    expect(
      takeawayWhenTablesLanded('This question was not answered.', TABLE)
    ).toBe(TIME_LIMIT_TAKEAWAY);
    expect(TIME_LIMIT_TAKEAWAY).toBe(
      'The run reached its time limit before the answer could be composed.'
    );
  });

  it('still calls a synthesis timeout Partial when the step is marked partial', () => {
    expect(
      answerRunVerdict({
        stages: [
          { id: 'sql', status: 'complete' },
          { id: 'synthesis', status: 'partial' },
        ],
        caveats: [
          'The model that writes the answer was not reachable: APITimeoutError: Request timed out.',
        ],
        narrative: TABLE,
      })
    ).toBe('partial');
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

  it('does not call a words-only degraded reply Complete', () => {
    expect(
      answerRunVerdict({
        stages: [{ id: 'synthesis', status: 'complete' }],
        caveats: ['This answer is degraded: no structured result arrived and no tool steps were recorded.'],
        figures: [],
        narrative: 'VLH Online leads the last 30 days on distinct players in the window.',
      })
    ).toBe('partial');
  });
});
