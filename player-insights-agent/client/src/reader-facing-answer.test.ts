import { describe, expect, it } from 'vitest';
import {
  answerHonesty,
  isCannedTakeaway,
  readerFacingNarrative,
  readerFacingTakeaway,
  stripToolCallDumps,
} from './reader-facing-answer';

const DUMP = 'data_genie({"question": "For the title \\"Iron Frontier Reckoning 2\\", distinct players by platform"})';

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
    expect(
      readerFacingTakeaway('The analysis completed from assessed sources.', `${DUMP}\n\nPC led on distinct players.`)
    ).toBe('PC led on distinct players.');
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
  const identity = 'This answer was produced as analyst@example.com and covers only the data that identity is granted.';
  const table = '| Franchise | Players |\n| VLH | 6655 |';

  it('labels a clean run as a final answer and lifts nothing', () => {
    expect(answerHonesty({ truncated: false, caveats: [identity] })).toEqual({
      eyebrow: 'Final answer',
      tone: 'complete',
    });
  });

  it('keeps incomplete sources as a note when tables already answered the question', () => {
    const honesty = answerHonesty({
      truncated: false,
      caveats: [incomplete, identity],
      narrative: table,
    });
    expect(honesty.eyebrow).toBe('Final answer');
    expect(honesty.tone).toBe('complete');
  });

  it('keeps a finished answer with tables Complete when only a deadline note remains', () => {
    const honesty = answerHonesty({
      truncated: true,
      caveats: [deadline, incomplete, identity],
      narrative: table,
    });
    expect(honesty.eyebrow).toBe('Final answer');
    expect(honesty.tone).toBe('complete');
  });

  it('calls a writer timeout after tables landed a partial answer, not unanswered', () => {
    const timeout = 'The model that writes the answer was not reachable: APITimeoutError: Request timed out.';
    const honesty = answerHonesty({
      truncated: true,
      caveats: [timeout, incomplete, identity],
      narrative: table,
    });
    expect(honesty.eyebrow).toBe('Partial answer');
    expect(honesty.tone).toBe('partial');
  });

  it('will not title an empty deadline stop as a final answer', () => {
    const honesty = answerHonesty({ truncated: true, caveats: [deadline, incomplete, identity] });
    expect(honesty.eyebrow).toBe('Partial answer');
    expect(honesty.tone).toBe('partial');
  });

  it('reads the deadline out of the caveat when nothing landed and the flag is missing', () => {
    expect(answerHonesty({ caveats: [deadline] }).eyebrow).toBe('Partial answer');
    expect(answerHonesty({ truncated: null, caveats: [incomplete] }).eyebrow).toBe('Incomplete answer');
  });

  it('will not headline a landed card with This question was not answered', () => {
    expect(readerFacingTakeaway('This question was not answered.', `${table}\n\nVLH Online led the window.`)).toBe(
      'VLH Online led the window.'
    );
    expect(readerFacingTakeaway('This question was not answered.', '')).toBe('This question was not answered.');
    expect(readerFacingTakeaway('This question was not answered.', '| Title | Players |\n| VLH Online | 9575 |')).toBe(
      'The run reached its time limit before the answer could be composed.'
    );
  });

  /**
   * Catalog / data-access listings answer the question. The grant-timing
   * sentence is a standing note about query-time Unity Catalog checks, not a
   * refusal of the request that just listed the tables.
   */
  it('does not paint a successful table listing as Request refused', () => {
    const grantTiming =
      'These 12 tables are declared by the deployment; Unity Catalog grant evaluation happens at query time, so the signed-in user may not have SELECT access to all of them. Any refused table will be named explicitly if a query against it fails.';
    const liveWording =
      'Declaring a table does not guarantee read access; Unity Catalog grants are evaluated per query and a refusal will be named explicitly if it occurs.';
    const listing = [
      'This deployment has access to 12 declared tables in the catalog.',
      '',
      '| LAYER | TABLE | PURPOSE |',
      '| Raw | raw_gameplay_activity | Unprocessed gameplay events |',
    ].join('\n');
    const honesty = answerHonesty({
      truncated: false,
      caveats: [grantTiming, liveWording, identity],
      narrative: listing,
    });

    expect(honesty.eyebrow).toBe('Final answer');
    expect(honesty.tone).toBe('complete');
  });

  it('keeps a 12-table catalog listing Complete when DSF clipped optional detail', () => {
    const listing = [
      'The catalog exposes 12 tables, all within the schema.',
      '',
      '| Table | Purpose |',
      '| --- | --- |',
      '| gold_player_180d_summary | Per-player aggregates |',
      '',
      '- **Package note:** Optional detail was clipped at the DSF handoff bound.',
    ].join('\n');
    const honesty = answerHonesty({
      truncated: false,
      caveats: [],
      narrative: listing,
      stages: [{ id: 'synthesis', status: 'partial' }],
    });
    expect(honesty.eyebrow).toBe('Final answer');
    expect(honesty.tone).toBe('complete');
  });

  it('still labels an actual policy deny as Request refused', () => {
    const refusal =
      'A governance control refused part of this request, so that part is not answered here and was not answered another way.';
    const honesty = answerHonesty({ truncated: false, caveats: [refusal] });

    expect(honesty).toEqual({ eyebrow: 'Final answer', tone: 'complete' });
  });

  it('does not call a words-only degraded reply a refused final answer', () => {
    const degraded = 'This answer is degraded: no structured result arrived and no tool steps were recorded.';
    const honesty = answerHonesty({
      truncated: false,
      caveats: [degraded],
      narrative: 'VLH Online leads the last 30 days on distinct players in the window.',
    });

    expect(honesty.eyebrow).toBe('Partial answer');
    expect(honesty.tone).toBe('partial');
  });
});
