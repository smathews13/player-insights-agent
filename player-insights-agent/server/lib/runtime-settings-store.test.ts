import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import {
  RUNTIME_SETTINGS_TABLE,
  forgetRuntimeSettings,
  readRuntimeSettings,
  writeRuntimeSettings,
} from './runtime-settings-store';

function client(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('runtime settings persistence', () => {
  it('qualifies the table with APP_SCHEMA so a non-default schema still hits migrations', () => {
    expect(RUNTIME_SETTINGS_TABLE).toBe(`${APP_SCHEMA}.runtime_settings`);
    const source = fs.readFileSync(path.join(__dirname, 'runtime-settings-store.ts'), 'utf8');
    expect(source).toContain("appTable('runtime_settings')");
    expect(source).not.toContain("'player_insights.runtime_settings'");
  });

  it('uses current behavior when no override exists', async () => {
    forgetRuntimeSettings();
    expect(await readRuntimeSettings(client() as never, { maxAgeMs: 0 })).toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it('prefers a stored valid override and writes JSON atomically', async () => {
    const override = {
      ...DEFAULT_RUNTIME_SETTINGS,
      loop: { ...DEFAULT_RUNTIME_SETTINGS.loop, maxSteps: 10 },
    };
    const reader = client([{ settings: override }]);
    expect((await readRuntimeSettings(reader as never, { maxAgeMs: 0 })).loop.maxSteps).toBe(10);

    const writer = client();
    await writeRuntimeSettings(writer as never, override, 'admin@example.com');
    expect(writer.calls[0]?.sql).toContain(RUNTIME_SETTINGS_TABLE);
    expect(writer.calls[0]?.values).toEqual(['effective', JSON.stringify(override), 'admin@example.com']);
  });

  it('persists light mode in the JSON row and restores it on a later read', async () => {
    forgetRuntimeSettings();
    const light = { ...DEFAULT_RUNTIME_SETTINGS, colorScheme: 'light' as const };
    const writer = client();

    expect(await writeRuntimeSettings(writer as never, light, 'admin@example.com')).toEqual(light);
    expect(writer.calls[0]?.values?.[1]).toBe(JSON.stringify(light));

    forgetRuntimeSettings();
    const reloaded = await readRuntimeSettings(client([{ settings: light }]) as never, { maxAgeMs: 0 });
    expect(reloaded.colorScheme).toBe('light');
  });

  /**
   * The #24a guidance, order, and type fields flow through unchanged. This is the
   * whole point of the surface: the server reads these from Lakebase and hands
   * them to the agent, so a value stored here is a value the next ask sees.
   */
  it('round-trips the new guidance, order, and chart-type fields', async () => {
    forgetRuntimeSettings();
    const override = {
      ...DEFAULT_RUNTIME_SETTINGS,
      answer: {
        ...DEFAULT_RUNTIME_SETTINGS.answer,
        takeawayGuidance: 'Lead with the decision.',
        narrativeGuidance: 'Cite the table each figure came from.',
        figuresOrder: 'totals-first' as const,
        chartsTypes: 'bar' as const,
      },
    };
    const value = await readRuntimeSettings(client([{ settings: override }]) as never, { maxAgeMs: 0 });
    expect(value.answer.takeawayGuidance).toBe('Lead with the decision.');
    expect(value.answer.figuresOrder).toBe('totals-first');
    expect(value.answer.chartsTypes).toBe('bar');
  });

  /**
   * A row written before these fields existed still reads, rather than being
   * thrown away and reverting the deployment to defaults on the next read. The
   * new keys carry schema defaults, so an older stored object gains them on parse
   * and every other value it set survives.
   */
  it('fills the new fields with defaults when an older stored row omits them', async () => {
    forgetRuntimeSettings();
    const legacy = {
      ...DEFAULT_RUNTIME_SETTINGS,
      loop: { ...DEFAULT_RUNTIME_SETTINGS.loop, maxSteps: 15 },
      answer: { ...DEFAULT_RUNTIME_SETTINGS.answer },
    } as Record<string, unknown>;
    delete (legacy.answer as Record<string, unknown>).takeawayGuidance;
    delete (legacy.answer as Record<string, unknown>).narrativeGuidance;
    delete (legacy.answer as Record<string, unknown>).figuresOrder;
    delete (legacy.answer as Record<string, unknown>).chartsTypes;

    const value = await readRuntimeSettings(client([{ settings: legacy }]) as never, { maxAgeMs: 0 });
    expect(value.loop.maxSteps).toBe(15);
    expect(value.answer.takeawayGuidance).toBe('');
    expect(value.answer.figuresOrder).toBe('as-ranked');
    expect(value.answer.chartsTypes).toBe('auto');
    expect(value.colorScheme).toBe('dark');
  });

  it('defaults a stored row without colorScheme to dark', async () => {
    forgetRuntimeSettings();
    const { colorScheme: _ignored, ...legacy } = DEFAULT_RUNTIME_SETTINGS;
    const value = await readRuntimeSettings(client([{ settings: legacy }]) as never, { maxAgeMs: 0 });
    expect(value.colorScheme).toBe('dark');
  });

  it('persists type settings and restores them on a later read', async () => {
    forgetRuntimeSettings();
    const typed = {
      ...DEFAULT_RUNTIME_SETTINGS,
      fontBodyColor: '#ffeecc',
      fontMutedColor: '#8899aa',
      fontFamily: 'system' as const,
      fontSize: 'l' as const,
    };
    const writer = client();

    expect(await writeRuntimeSettings(writer as never, typed, 'admin@example.com')).toEqual(typed);
    expect(writer.calls[0]?.values?.[1]).toBe(JSON.stringify(typed));

    forgetRuntimeSettings();
    const reloaded = await readRuntimeSettings(client([{ settings: typed }]) as never, { maxAgeMs: 0 });
    expect(reloaded.fontBodyColor).toBe('#ffeecc');
    expect(reloaded.fontMutedColor).toBe('#8899aa');
    expect(reloaded.fontFamily).toBe('system');
    expect(reloaded.fontSize).toBe('l');
  });
});
