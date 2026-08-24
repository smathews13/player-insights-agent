import { describe, expect, it } from 'vitest';
import {
  answerHonesty,
  isCannedTakeaway,
  readerFacingNarrative,
  readerFacingTakeaway,
  stripToolCallDumps,
} from './reader-facing-answer';

const DUMP =
  'data_genie({"question": "For the title \\"Iron Frontier Reckoning 2\\", distinct players by platform"})';

const GRID = [
  'platform | total_distinct_players | avg_sessions',
  'PC | 18402 | 12.4',
  'PlayStation 5 | 15110 | 11.1',
  'Xbox Series X|S | 9804 | 10.8',
].join('\n');

describe('stripToolCallDumps', () => {
  it('drops a data_genie call and keeps the findings after it', () => {
    const cleaned = stripToolCallDumps(`${DUMP}\n\nPC led on distinct players.\n\n${GRID}`);
    expect(cleaned).not.toContain('data_genie');
    expect(cleaned).not.toContain('"question"');
    expect(cleaned).toContain('PC led on distinct players.');
    expect(cleaned).toContain('platform | total_distinct_players');
  });

  it('drops an unclosed call at a deadline cut rather than leaving a stub', () => {
    expect(stripToolCallDumps('data_genie({"question": "For the title')).toBe('');
    expect(stripToolCallDumps('Asked Genie.\ndata_genie({"question": "cut')).toBe('Asked Genie.');
  });

  it('leaves ordinary prose, including a pipe used as a separator in a sentence, alone', () => {
    const prose = 'Sessions concentrate in GB | DE | FR, in that order.';
    expect(stripToolCallDumps(prose)).toBe(prose);
  });
});

describe('the takeaway a reader is shown', () => {
  it('keeps a real finding', () => {
    expect(readerFacingTakeaway('PC led on distinct players.', DUMP)).toBe('PC led on distinct players.');
  });

  it('will not promote a canned completion line over a surviving sentence', () => {
    expect(isCannedTakeaway('The analysis completed from assessed sources.')).toBe(true);
    expect(readerFacingTakeaway('The analysis completed from assessed sources.', `${DUMP}\n\nPC led on distinct players.`))
      .toBe('PC led on distinct players.');
  });

  it('does not print the canned headline again as the first line of the body', () => {
    expect(
      readerFacingNarrative(
        'The analysis completed from assessed sources.',
        'The analysis completed from assessed sources.\n\nPC led on distinct players.'
      )
    ).toBe('PC led on distinct players.');
  });

  it('refuses to invent a finding when only a dump survived', () => {
    expect(readerFacingTakeaway('The analysis completed from assessed sources.', DUMP)).toBe('');
  });
});

describe('whether the section may call itself a final answer', () => {
  const incomplete =
    'The sources for this answer are incomplete: part of it came from a query whose tables could not be determined.';
  const deadline = 'The turn deadline was reached before the answer could be written.';
  const identity =
    'This answer was produced as analyst@example.com and covers only the data that identity is granted.';

  it('labels a clean run as a final answer and lifts nothing', () => {
    expect(answerHonesty({ truncated: false, caveats: [identity] })).toEqual({
      eyebrow: 'Final answer',
      tone: 'complete',
      warnings: [],
    });
  });

  it('will not title a deadline failure as a final answer', () => {
    const honesty = answerHonesty({ truncated: true, caveats: [deadline, incomplete, identity] });
    expect(honesty.eyebrow).toBe('Partial answer');
    expect(honesty.tone).toBe('partial');
    expect(honesty.warnings.map((warning) => warning.label)).toEqual([
      'Turn deadline reached',
      'Incomplete sources',
    ]);
  });

  it('reads the deadline out of the caveat when the run row never carried the flag', () => {
    expect(answerHonesty({ caveats: [deadline] }).eyebrow).toBe('Partial answer');
    expect(answerHonesty({ truncated: null, caveats: [incomplete] }).eyebrow).toBe('Incomplete answer');
  });
});
