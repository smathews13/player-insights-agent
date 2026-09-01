import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUNTIME_SETTINGS,
  RUNTIME_ANSWER_KEYS,
  RUNTIME_BEHAVIOR_KEYS,
  RUNTIME_ENTITY_KINDS,
  RUNTIME_ENTITY_STYLE_KEYS,
  RUNTIME_LOOP_KEYS,
  RUNTIME_SETTINGS_KEYS,
  parsePersistedRuntimeSettings,
  type RuntimeSettings,
} from './runtime-settings-browser';
import {
  RuntimeEntityStylesObjectSchema,
  RuntimeSettingsObjectSchema,
  RuntimeSettingsSchema,
} from './runtime-settings';

function changed(path: readonly string[], value: unknown): unknown {
  const copy = structuredClone(DEFAULT_RUNTIME_SETTINGS) as unknown as Record<string, unknown>;
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path[path.length - 1]] = value;
  return copy;
}

function without(...paths: readonly (readonly string[])[]): unknown {
  const copy = structuredClone(DEFAULT_RUNTIME_SETTINGS) as unknown as Record<string, unknown>;
  for (const path of paths) {
    let target = copy;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
    delete target[path[path.length - 1]];
  }
  return copy;
}

describe('browser runtime settings cache parser', () => {
  it('normalizes the same complete and legacy rows as the authoritative schema', () => {
    const legacy = without(
      ['colorScheme'],
      ['entityStyles'],
      ['fontBodyColor'],
      ['fontMutedColor'],
      ['fontFamily'],
      ['fontSize'],
      ['backgroundGraphics'],
      ['animations'],
      ['density'],
      ['answer', 'takeawayGuidance'],
      ['answer', 'narrativeGuidance'],
      ['answer', 'figuresOrder'],
      ['answer', 'chartsTypes']
    );
    const trimmed = changed(['behavior', 'timezone'], '  America/Denver  ');

    for (const value of [DEFAULT_RUNTIME_SETTINGS, legacy, trimmed]) {
      expect(parsePersistedRuntimeSettings(value)).toEqual(RuntimeSettingsSchema.parse(value));
    }
  });

  it('accepts every numeric boundary and refuses out-of-range, fractional, and non-finite numbers', () => {
    const bounds = [
      [['loop', 'maxSteps'], 1, 20],
      [['loop', 'maxToolCalls'], 1, 40],
      [['loop', 'maxRunSeconds'], 30, 200],
      [['answer', 'maxCharts'], 0, 6],
      [['answer', 'maxFigures'], 0, 12],
      [['answer', 'maxCaveats'], 0, 20],
      [['answer', 'narrativeMaxCharacters'], 0, 12_000],
    ] as const;

    for (const [path, minimum, maximum] of bounds) {
      expect(parsePersistedRuntimeSettings(changed(path, minimum)), path.join('.')).not.toBeNull();
      expect(parsePersistedRuntimeSettings(changed(path, maximum)), path.join('.')).not.toBeNull();
      for (const invalid of [minimum - 1, maximum + 1, minimum + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const value = changed(path, invalid);
        expect(parsePersistedRuntimeSettings(value), `${path.join('.')}=${invalid}`).toBeNull();
        expect(RuntimeSettingsSchema.safeParse(value).success, `${path.join('.')} schema=${invalid}`).toBe(false);
      }
    }
  });

  it('refuses a malformed value for every non-numeric field', () => {
    const invalid = [
      [['answer', 'takeaway'], 'yes'],
      [['answer', 'narrative'], 1],
      [['answer', 'charts'], null],
      [['answer', 'figures'], 'false'],
      [['answer', 'caveats'], {}],
      [['answer', 'sources'], 'verbose'],
      [['answer', 'takeawayGuidance'], 4],
      [['answer', 'narrativeGuidance'], 'x'.repeat(2_001)],
      [['answer', 'figuresOrder'], 'random'],
      [['answer', 'chartsTypes'], 'pie'],
      [['behavior', 'clarification'], 'always'],
      [['behavior', 'timezone'], 'x'.repeat(81)],
      [['behavior', 'injectCurrentDate'], 'false'],
      [['colorScheme'], 'system'],
      [['fontBodyColor'], 'red'],
      [['fontMutedColor'], '#abcd'],
      [['fontFamily'], 'serif'],
      [['fontSize'], 'xl'],
      [['backgroundGraphics'], 1],
      [['animations'], 'true'],
      [['density'], 'dense'],
      [['entityStyles', 'catalog', 'foreground'], 'url(javascript:alert(1))'],
      [['entityStyles', 'schema', 'background'], '#12345g'],
    ] as const;

    for (const [path, value] of invalid) {
      const changedValue = changed(path, value);
      expect(parsePersistedRuntimeSettings(changedValue), path.join('.')).toBeNull();
      expect(RuntimeSettingsSchema.safeParse(changedValue).success, `${path.join('.')} schema`).toBe(false);
    }
  });

  it('is strict at every object level and requires every non-defaulted field', () => {
    for (const value of [
      null,
      [],
      'settings',
      { ...DEFAULT_RUNTIME_SETTINGS, surprise: true },
      changed(['loop'], { ...DEFAULT_RUNTIME_SETTINGS.loop, surprise: 1 }),
      changed(['answer'], { ...DEFAULT_RUNTIME_SETTINGS.answer, surprise: 1 }),
      changed(['behavior'], { ...DEFAULT_RUNTIME_SETTINGS.behavior, surprise: 1 }),
      changed(['entityStyles'], {
        ...DEFAULT_RUNTIME_SETTINGS.entityStyles,
        surprise: DEFAULT_RUNTIME_SETTINGS.entityStyles.tag,
      }),
      changed(['entityStyles', 'tag'], { ...DEFAULT_RUNTIME_SETTINGS.entityStyles.tag, surprise: '#ffffff' }),
      without(['loop', 'maxSteps']),
      without(['answer', 'takeaway']),
      without(['behavior', 'timezone']),
      without(['entityStyles', 'tag']),
    ]) {
      expect(parsePersistedRuntimeSettings(value)).toBeNull();
      expect(RuntimeSettingsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('keeps parser keys, defaults, and the authoritative schema aligned', () => {
    const shape = RuntimeSettingsObjectSchema.shape;
    expect([...RuntimeSettingsObjectSchema.keyof().options].sort()).toEqual([...RUNTIME_SETTINGS_KEYS].sort());
    expect([...shape.loop.keyof().options].sort()).toEqual([...RUNTIME_LOOP_KEYS].sort());
    expect([...shape.answer.keyof().options].sort()).toEqual([...RUNTIME_ANSWER_KEYS].sort());
    expect([...shape.behavior.keyof().options].sort()).toEqual([...RUNTIME_BEHAVIOR_KEYS].sort());
    expect([...RuntimeEntityStylesObjectSchema.keyof().options].sort()).toEqual([...RUNTIME_ENTITY_KINDS].sort());
    expect([...Object.keys(RuntimeEntityStylesObjectSchema.shape.catalog.shape)].sort()).toEqual(
      [...RUNTIME_ENTITY_STYLE_KEYS].sort()
    );
    expect(Object.keys(DEFAULT_RUNTIME_SETTINGS).sort()).toEqual([...RUNTIME_SETTINGS_KEYS].sort());
    expect(Object.keys(DEFAULT_RUNTIME_SETTINGS.loop).sort()).toEqual([...RUNTIME_LOOP_KEYS].sort());
    expect(Object.keys(DEFAULT_RUNTIME_SETTINGS.answer).sort()).toEqual([...RUNTIME_ANSWER_KEYS].sort());
    expect(Object.keys(DEFAULT_RUNTIME_SETTINGS.behavior).sort()).toEqual([...RUNTIME_BEHAVIOR_KEYS].sort());

    const parsed = parsePersistedRuntimeSettings(DEFAULT_RUNTIME_SETTINGS);
    expect(parsed satisfies RuntimeSettings | null).toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it('keeps Zod at API and persistence boundaries, never in the browser parser', () => {
    const browser = readFileSync(new URL('./runtime-settings-browser.ts', import.meta.url), 'utf8');
    const authoritative = readFileSync(new URL('./runtime-settings.ts', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../client/src/runtime-settings-api.ts', import.meta.url), 'utf8');
    const live = readFileSync(new URL('../client/src/runtime-settings-live.ts', import.meta.url), 'utf8');
    const vite = readFileSync(new URL('../client/vite.config.ts', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../server/lib/runtime-settings-store.ts', import.meta.url), 'utf8');
    const routes = readFileSync(new URL('../server/routes/runtime-settings-routes.ts', import.meta.url), 'utf8');
    expect(browser).not.toMatch(/from ['"]zod['"]/);
    expect(browser).toContain('only for the same-origin localStorage appearance cache');
    expect(authoritative).not.toContain('parsePersistedRuntimeSettings');
    expect(live).toContain("import('./runtime-settings-api')");
    expect(live).not.toMatch(/import\s+\{[^}]*runtimeSettingsFromResponse[^}]*\}\s+from/);
    expect(vite).toContain("id.includes('/node_modules/zod/')");
    expect(vite).toContain("return 'zod'");
    expect(api).toContain('RuntimeSettingsSchema');
    expect(store).toContain('parseStoredRuntimeSettings');
    expect(routes).toContain('RuntimeSettingsPatchSchema');
    for (const boundary of [api, store, routes]) expect(boundary).not.toContain('parsePersistedRuntimeSettings');
  });
});
