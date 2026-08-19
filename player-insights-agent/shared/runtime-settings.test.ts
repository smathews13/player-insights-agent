import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettingsSchema } from './runtime-settings';

describe('runtime settings contract', () => {
  it('keeps the current agent behavior as its defaults', () => {
    expect(RuntimeSettingsSchema.parse(DEFAULT_RUNTIME_SETTINGS)).toEqual(DEFAULT_RUNTIME_SETTINGS);
    expect(DEFAULT_RUNTIME_SETTINGS.loop).toEqual({
      maxSteps: 8,
      maxToolCalls: 12,
      maxRunSeconds: 90,
    });
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
