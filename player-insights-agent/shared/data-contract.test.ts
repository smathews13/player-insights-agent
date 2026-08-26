import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DATA_CONTRACT_TABLES,
  DATA_GENIE_TABLES,
  DICTIONARY_GENIE_TABLES,
  qualifyDataContractTables,
} from './data-contract';

const PREFLIGHT = path.resolve(__dirname, '../../agent/preflight.py');

function literalTuple(source: string, name: string): string[] | null {
  const match = new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

describe('the app data contract matches agent/preflight.py', () => {
  it('names the same Genie-curated tables the release grants', () => {
    const source = readFileSync(PREFLIGHT, 'utf8');
    expect(literalTuple(source, 'DATA_GENIE_TABLES')).toEqual([...DATA_GENIE_TABLES]);
    expect(literalTuple(source, 'DICTIONARY_GENIE_TABLES')).toEqual([...DICTIONARY_GENIE_TABLES]);
    expect([...DATA_CONTRACT_TABLES]).toEqual([...DATA_GENIE_TABLES, ...DICTIONARY_GENIE_TABLES]);
  });

  it('qualifies bare names and leaves a three-level name alone', () => {
    expect(qualifyDataContractTables('cat', 'sch', ['gold_player_180d_summary', 'other.place.t'])).toEqual([
      'cat.sch.gold_player_180d_summary',
      'other.place.t',
    ]);
  });

  it('returns nothing when the namespace is missing, rather than guessing', () => {
    expect(qualifyDataContractTables('', 'sch')).toEqual([]);
    expect(qualifyDataContractTables('cat', '')).toEqual([]);
  });
});
