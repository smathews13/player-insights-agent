import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettingsSchema, runtimeEntityCssVariables } from './runtime-settings';

describe('runtime settings contract', () => {
  it('keeps the current agent behavior as its defaults', () => {
    expect(RuntimeSettingsSchema.parse(DEFAULT_RUNTIME_SETTINGS)).toEqual(DEFAULT_RUNTIME_SETTINGS);
    expect(DEFAULT_RUNTIME_SETTINGS.loop).toEqual({
      maxSteps: 12,
      maxToolCalls: 12,
      maxRunSeconds: 90,
    });
    expect(DEFAULT_RUNTIME_SETTINGS.answer.maxFigures).toBe(4);
  });

  it('ships distinct shared answer entity tokens', () => {
    expect(DEFAULT_RUNTIME_SETTINGS.entityStyles.catalog.background).toBe('#0e538b');
    expect(DEFAULT_RUNTIME_SETTINGS.entityStyles.schema.background).toBe('#ddeaf4');
    expect(DEFAULT_RUNTIME_SETTINGS.entityStyles.table.background).toBe('#e8e8e8');
    expect(runtimeEntityCssVariables(DEFAULT_RUNTIME_SETTINGS)).toMatchObject({
      '--entity-catalog-bg': '#0e538b',
      '--entity-schema-bg': '#ddeaf4',
      '--entity-table-bg': '#e8e8e8',
    });
  });

  it('defaults missing colorScheme to dark so older rows stay parseable', () => {
    const { colorScheme: _ignored, ...withoutTheme } = DEFAULT_RUNTIME_SETTINGS;
    expect(RuntimeSettingsSchema.parse(withoutTheme).colorScheme).toBe('dark');
    expect(DEFAULT_RUNTIME_SETTINGS.colorScheme).toBe('dark');
  });

  it('refuses unsafe or ineffective values', () => {
    expect(() =>
      RuntimeSettingsSchema.parse({
        ...DEFAULT_RUNTIME_SETTINGS,
        loop: { ...DEFAULT_RUNTIME_SETTINGS.loop, maxSteps: 100 },
      })
    ).toThrow();
    expect(() =>
      RuntimeSettingsSchema.parse({
        ...DEFAULT_RUNTIME_SETTINGS,
        behavior: { ...DEFAULT_RUNTIME_SETTINGS.behavior, surprise: true },
      })
    ).toThrow();
  });
});
