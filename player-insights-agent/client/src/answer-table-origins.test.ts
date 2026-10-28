import { describe, expect, it } from 'vitest';
import { tableOriginLists } from './answer-table-origins';
import type { SourceRef } from './answer-shape';

const SESSIONS: SourceRef = { name: 'main.gold.sessions', freshness: '', role: 'reading' };
const PLAYERS: SourceRef = { name: 'main.gold.players', freshness: '', role: 'reading' };
const TABLE = ['| Region | Value |', '| --- | --- |', '| EMEA | 40 |'].join('\n');

const names = (lists: ReturnType<typeof tableOriginLists>) => lists.map((list) => list.map((row) => row.name));

describe('which source a table links to', () => {
  it('links each table to the source named in its own lead-in', () => {
    const body = [
      'Sessions by region, from main.gold.sessions.',
      TABLE,
      '',
      'Players by region, from main.gold.players.',
      TABLE,
    ].join('\n\n');
    expect(names(tableOriginLists([body], [SESSIONS, PLAYERS]))).toEqual([
      ['main.gold.sessions'],
      ['main.gold.players'],
    ]);
  });

  it('gives a table with no named source no link, rather than the next one in line', () => {
    const body = ['Sessions by region, from main.gold.sessions.', TABLE, '', 'A second cut.', TABLE].join('\n\n');
    expect(names(tableOriginLists([body], [SESSIONS, PLAYERS]))).toEqual([['main.gold.sessions'], []]);
  });

  it('never reuses an earlier table’s source for a later table', () => {
    const body = [TABLE, '', 'Then players, from main.gold.players.', TABLE, '', TABLE].join('\n\n');
    expect(names(tableOriginLists([body], [SESSIONS, PLAYERS]))).toEqual([[], ['main.gold.players'], []]);
  });

  it('links every table when only one source could be behind the numbers', () => {
    const body = [TABLE, '', TABLE].join('\n\n');
    expect(names(tableOriginLists([body], [SESSIONS]))).toEqual([['main.gold.sessions'], ['main.gold.sessions']]);
  });
});
