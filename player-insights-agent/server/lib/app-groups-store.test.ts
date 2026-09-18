import { describe, expect, it } from 'vitest';
import { readAppGroupsSettings, writeAppGroupsSettings } from './app-groups-store';
import { SettingsRevisionConflict } from './versioned-settings-store';

class MemorySettingsDb {
  row: { settings: unknown; revision: number } | null = null;
  readonly lakebase = {
    query: (sql: string, values: unknown[] = []) => {
      if (/^\s*SELECT settings, revision/m.test(sql))
        return Promise.resolve({ rows: this.row ? [{ ...this.row }] : [] });
      if (/^\s*INSERT INTO/m.test(sql)) {
        if (this.row) return Promise.resolve({ rows: [] });
        this.row = { settings: JSON.parse(String(values[1])), revision: 1 };
        return Promise.resolve({ rows: [{ ...this.row }] });
      }
      if (/^\s*UPDATE/m.test(sql)) {
        const expected = Number(values[3]);
        if (!this.row || this.row.revision !== expected) return Promise.resolve({ rows: [] });
        this.row = { settings: JSON.parse(String(values[1])), revision: expected + 1 };
        return Promise.resolve({ rows: [{ ...this.row }] });
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    },
  };
}

describe('Teams settings store', () => {
  it('uses defaults before the first write and canonicalizes the saved document', async () => {
    const db = new MemorySettingsDb();
    await expect(readAppGroupsSettings(db as never)).resolves.toEqual({ settings: { groups: [] }, revision: 0 });
    await expect(
      writeAppGroupsSettings(
        db as never,
        { groups: [{ id: 'g1', name: 'Trading', members: ['A@x.com', 'a@x.com'] }] },
        0,
        'admin@example.test'
      )
    ).resolves.toMatchObject({
      revision: 1,
      settings: { groups: [{ id: 'g1', name: 'Trading', members: ['a@x.com'] }] },
    });
  });

  it('rejects a stale revision', async () => {
    const db = new MemorySettingsDb();
    await writeAppGroupsSettings(db as never, { groups: [] }, 0, 'admin@example.test');
    await expect(writeAppGroupsSettings(db as never, { groups: [] }, 0, 'other@example.test')).rejects.toBeInstanceOf(
      SettingsRevisionConflict
    );
  });
});
