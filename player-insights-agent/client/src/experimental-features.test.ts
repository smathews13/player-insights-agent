import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExperimentalSettingsSchema, NO_EXPERIMENTS } from '../../shared/experimental-settings';
import {
  decodeExperimentalSettingsDocument,
  EXPERIMENTAL_FEATURE_KEYS,
} from '../../shared/experimental-settings-browser';
import {
  showsBenchmarkLab,
  showsEgressControls,
  showsForecasting,
  showsNotebookAgentSync,
  withExperimentalFeature,
} from './experimental-features';

describe('deployment-wide experimental feature contract', () => {
  it('defaults every missing flag off without conflating false and true', () => {
    expect(ExperimentalSettingsSchema.parse({})).toEqual(NO_EXPERIMENTS);
    expect(ExperimentalSettingsSchema.parse({ benchmarkLab: false }).benchmarkLab).toBe(false);
    expect(ExperimentalSettingsSchema.parse({ benchmarkLab: true }).benchmarkLab).toBe(true);
  });

  it('round-trips every visible flag through the shared schema', () => {
    const enabled = { benchmarkLab: true, egressControls: true, forecasting: true, notebookAgentSync: true };
    expect(ExperimentalSettingsSchema.parse(enabled)).toEqual(enabled);
    expect(showsBenchmarkLab(enabled)).toBe(true);
    expect(showsEgressControls(enabled)).toBe(true);
    expect(showsForecasting(enabled)).toBe(true);
    expect(showsNotebookAgentSync(enabled)).toBe(true);
  });

  it('stages one flag without changing the others', () => {
    expect(withExperimentalFeature({ ...NO_EXPERIMENTS }, 'forecasting', true)).toEqual({
      ...NO_EXPERIMENTS,
      forecasting: true,
    });
  });

  it('keeps the eager browser decoder equivalent to the authoritative schema', () => {
    for (const settings of [
      {},
      { benchmarkLab: false, egressControls: true, forecasting: false, notebookAgentSync: true },
      { benchmarkLab: true, futureFlag: true },
    ]) {
      expect(decodeExperimentalSettingsDocument({ settings, revision: 4 })).toEqual({
        settings: ExperimentalSettingsSchema.parse(settings),
        revision: 4,
      });
    }
    for (const settings of [
      null,
      { benchmarkLab: 1 },
      { egressControls: 'true' },
      { forecasting: null },
      { notebookAgentSync: 'true' },
    ]) {
      expect(decodeExperimentalSettingsDocument({ settings, revision: 4 })).toBeNull();
      expect(ExperimentalSettingsSchema.safeParse(settings).success).toBe(false);
    }
    expect(decodeExperimentalSettingsDocument({ settings: {}, revision: -1 })).toBeNull();
    expect([...ExperimentalSettingsSchema.keyof().options].sort()).toEqual([...EXPERIMENTAL_FEATURE_KEYS].sort());
  });

  it('keeps Zod and the authoritative schema out of Layouts eager fetch path', () => {
    const browser = readFileSync(new URL('../../shared/experimental-settings-browser.ts', import.meta.url), 'utf8');
    const api = readFileSync(new URL('./experimental-settings-api.ts', import.meta.url), 'utf8');
    const features = readFileSync(new URL('./experimental-features.ts', import.meta.url), 'utf8');
    const layout = readFileSync(new URL('./Layout.tsx', import.meta.url), 'utf8');
    for (const eagerModule of [browser, api, features]) {
      expect(eagerModule).not.toMatch(/from ['"]zod['"]/);
      expect(eagerModule).not.toMatch(/from ['"][^'"]*\/experimental-settings['"]/);
    }
    expect(layout).toContain("from './experimental-settings-api'");
    expect(api).toContain('decodeExperimentalSettingsDocument');
    expect(api).not.toContain('ExperimentalSettingsSchema');
  });
});
