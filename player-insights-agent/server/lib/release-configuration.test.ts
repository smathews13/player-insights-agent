import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { qualifyDataContractTables } from '../../shared/data-contract';
import { configurationFromRelease } from './release-configuration';

describe('release configuration, without asking the agent', () => {
  it('reads catalog, warehouse and Genie ids from the app environment', () => {
    const configuration = configurationFromRelease({
      PLAYER_INSIGHTS_CATALOG: 'cat',
      PLAYER_INSIGHTS_SCHEMA: 'sch',
      DATABRICKS_SQL_WAREHOUSE_ID: 'wh-1',
      PLAYER_INSIGHTS_DATA_GENIE_ID: 'space-data',
    });
    const byKey = Object.fromEntries(configuration.map((entry) => [entry.key, entry]));
    expect(byKey.catalog).toMatchObject({ value: 'cat', source: 'app-environment' });
    expect(byKey.schema.value).toBe('sch');
    expect(byKey.warehouse_id.value).toBe('wh-1');
    expect(byKey.data_genie_space_id.value).toBe('space-data');
    expect(byKey.declared_manifest.value).toEqual(qualifyDataContractTables('cat', 'sch'));
  });

  it('prefers an explicit declared manifest over qualifying the data contract', () => {
    const configuration = configurationFromRelease({
      PLAYER_INSIGHTS_CATALOG: 'cat',
      PLAYER_INSIGHTS_SCHEMA: 'sch',
      PLAYER_INSIGHTS_DECLARED_MANIFEST: 'other.place.t1,other.place.t2',
    });
    const manifest = configuration.find((entry) => entry.key === 'declared_manifest');
    expect(manifest?.value).toEqual(['other.place.t1', 'other.place.t2']);
  });

  it('does not invent a table list when catalog or schema is missing', () => {
    expect(configurationFromRelease({ PLAYER_INSIGHTS_CATALOG: 'cat' }).map((entry) => entry.key)).not.toContain(
      'declared_manifest'
    );
  });
});

describe('no fake serving question remains in the app', () => {
  it('does not POST the word preflight as an Ask', () => {
    const root = path.resolve(__dirname, '../..');
    const files = [
      'server/routes/insights-routes.ts',
      'server/routes/settings-routes.ts',
      'server/routes/ops-routes.ts',
      'server/routes/access-verification.ts',
      'client/src/session-checks.ts',
      'client/src/EvalFlywheel.tsx',
      'client/src/use-evaluation-lab.ts',
    ];
    for (const relative of files) {
      const source = readFileSync(path.join(root, relative), 'utf8');
      expect(source, `${relative} still builds a serving body whose question is preflight`).not.toMatch(
        /content:\s*['"]preflight['"]/
      );
      expect(source, `${relative} still calls invokePreflight`).not.toContain('invokePreflight');
      expect(source, `${relative} still builds a preflight serving body`).not.toContain('buildPreflightServingBody');
    }
  });
});
