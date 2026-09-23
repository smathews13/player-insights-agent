import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTITY_STYLES,
  DEFAULT_RUNTIME_SETTINGS,
  DARK_ENTITY_STYLES,
  FONT_FAMILY_STACKS,
  PAPER_ENTITY_STYLES,
  RuntimeSettingsSchema,
  THEME_FONT_COLORS,
  fontColorsForScheme,
  parseRuntimeSettings,
  runtimeAppearanceCssVariables,
  runtimeEntityCssVariables,
  resolveEntityStylesForRender,
  upgradeEntityStylesForScheme,
  upgradePaperEntityStyles,
} from './runtime-settings';

describe('runtime settings contract', () => {
  it('keeps the current agent behavior as its defaults', () => {
    expect(RuntimeSettingsSchema.parse(DEFAULT_RUNTIME_SETTINGS)).toEqual(DEFAULT_RUNTIME_SETTINGS);
    expect(DEFAULT_RUNTIME_SETTINGS.loop).toEqual({
      maxSteps: 40,
      maxToolCalls: 80,
      maxRunSeconds: 600,
    });
    expect(DEFAULT_RUNTIME_SETTINGS.answer.maxFigures).toBe(6);
    expect(DEFAULT_RUNTIME_SETTINGS.answer.maxCharts).toBe(1);
  });

  it('ships the approved daylight entity palette as the default styles', () => {
    expect(DEFAULT_RUNTIME_SETTINGS.entityStyles).toEqual(DEFAULT_ENTITY_STYLES);
    expect(DEFAULT_ENTITY_STYLES).toEqual({
      catalog: { foreground: '#1a5b8f', background: '#e8f1fa' },
      schema: { foreground: '#4c5c68', background: '#eef2f5' },
      table: { foreground: '#0e1720', background: '#e2e8ed' },
      column: { foreground: '#4c5c68', background: '#f2f5f8' },
      quote: { foreground: '#4c5c68', background: '#f2f5f8' },
      tag: { foreground: '#0e1720', background: '#e8f1fa' },
    });

    expect(runtimeEntityCssVariables(DEFAULT_RUNTIME_SETTINGS)).toMatchObject({
      '--entity-catalog-fg': '#1a5b8f',
      '--entity-catalog-bg': '#e8f1fa',
      '--entity-schema-bg': '#eef2f5',
      '--entity-table-bg': '#e2e8ed',
      '--entity-column-bg': '#f2f5f8',
      '--entity-quote-bg': '#f2f5f8',
      '--entity-tag-bg': '#e8f1fa',
    });
  });

  it('upgrades leftover paper pairs and leaves a chosen pair alone', () => {
    expect(upgradePaperEntityStyles(PAPER_ENTITY_STYLES)).toEqual(DEFAULT_ENTITY_STYLES);

    const customTable = { foreground: '#ffffff', background: '#445566' };
    expect(
      upgradePaperEntityStyles({
        ...PAPER_ENTITY_STYLES,
        table: customTable,
      })
    ).toEqual({
      ...DEFAULT_ENTITY_STYLES,
      table: customTable,
    });

    const storedPaper = {
      ...DEFAULT_RUNTIME_SETTINGS,
      entityStyles: PAPER_ENTITY_STYLES,
    };
    expect(parseRuntimeSettings(storedPaper).entityStyles).toEqual(DEFAULT_ENTITY_STYLES);
    expect(
      parseRuntimeSettings({
        ...storedPaper,
        entityStyles: { ...PAPER_ENTITY_STYLES, table: customTable },
      }).entityStyles.table
    ).toEqual(customTable);
  });

  it('replaces a half-migrated dark pair as one light-mode pair', () => {
    const halfMigrated = {
      ...DEFAULT_ENTITY_STYLES,
      catalog: {
        foreground: DARK_ENTITY_STYLES.catalog.foreground,
        background: DEFAULT_ENTITY_STYLES.catalog.background,
      },
    };
    expect(upgradeEntityStylesForScheme(halfMigrated, 'light').catalog).toEqual(DEFAULT_ENTITY_STYLES.catalog);
  });

  it('preserves a readable custom pair that deliberately reuses one default hex', () => {
    const custom = {
      ...DEFAULT_ENTITY_STYLES,
      catalog: {
        foreground: DARK_ENTITY_STYLES.catalog.foreground,
        background: '#111827',
      },
    };
    expect(upgradeEntityStylesForScheme(custom, 'light').catalog).toEqual(custom.catalog);
  });

  it('falls back once when a render receives an unreadable pair', () => {
    const warnings: string[] = [];
    const resolved = resolveEntityStylesForRender(
      {
        colorScheme: 'light',
        entityStyles: {
          ...DEFAULT_ENTITY_STYLES,
          table: { foreground: '#ffffff', background: '#ffffff' },
        },
      },
      (message) => warnings.push(message)
    );
    expect(resolved.table).toEqual(DEFAULT_ENTITY_STYLES.table);
    expect(warnings).toEqual(['Unreadable table entity colors were replaced with the light defaults.']);
  });

  it('defaults missing colorScheme to light so older rows adopt the new default', () => {
    const { colorScheme: _ignored, ...withoutTheme } = DEFAULT_RUNTIME_SETTINGS;
    expect(RuntimeSettingsSchema.parse(withoutTheme).colorScheme).toBe('light');
    expect(DEFAULT_RUNTIME_SETTINGS.colorScheme).toBe('light');
  });

  it('fills type settings from the row theme when an older store omitted them', () => {
    const { fontBodyColor: _b, fontMutedColor: _m, fontFamily: _f, fontSize: _s, ...legacy } = DEFAULT_RUNTIME_SETTINGS;
    expect(RuntimeSettingsSchema.parse(legacy)).toMatchObject({
      fontBodyColor: THEME_FONT_COLORS.light.body,
      fontMutedColor: THEME_FONT_COLORS.light.muted,
      fontFamily: 'dm-sans',
      fontSize: 'm',
    });
    expect(
      RuntimeSettingsSchema.parse({
        ...legacy,
        colorScheme: 'dark',
      })
    ).toMatchObject({
      fontBodyColor: THEME_FONT_COLORS.dark.body,
      fontMutedColor: THEME_FONT_COLORS.dark.muted,
    });
  });

  it('normalizes legacy rows with safe interface defaults without changing their values', () => {
    const {
      backgroundGraphics: _backgroundGraphics,
      animations: _animations,
      density: _density,
      ...legacy
    } = {
      ...DEFAULT_RUNTIME_SETTINGS,
      loop: { ...DEFAULT_RUNTIME_SETTINGS.loop, maxSteps: 17 },
      fontFamily: 'system' as const,
    };

    expect(RuntimeSettingsSchema.parse(legacy)).toMatchObject({
      loop: { maxSteps: 17 },
      fontFamily: 'system',
      backgroundGraphics: true,
      animations: true,
      density: 'comfortable',
    });
  });

  it('writes type onto the same CSS variables every surface already reads', () => {
    const typed = {
      ...DEFAULT_RUNTIME_SETTINGS,
      fontBodyColor: '#ffeecc',
      fontMutedColor: '#8899aa',
      fontFamily: 'system' as const,
      fontSize: 'l' as const,
    };
    expect(runtimeAppearanceCssVariables(typed)).toMatchObject({
      '--ast-text': '#ffeecc',
      '--foreground': '#ffeecc',
      '--ast-text-secondary': '#8899aa',
      '--muted-foreground': '#8899aa',
      '--font-sans': FONT_FAMILY_STACKS.system,
      '--text-base': '15px',
      '--ast-fs-13': '15px',
    });
  });

  it('follows the new theme when type colours were still the previous default', () => {
    expect(fontColorsForScheme(DEFAULT_RUNTIME_SETTINGS, 'light')).toEqual({
      fontBodyColor: THEME_FONT_COLORS.light.body,
      fontMutedColor: THEME_FONT_COLORS.light.muted,
    });
    expect(
      fontColorsForScheme({ ...DEFAULT_RUNTIME_SETTINGS, fontBodyColor: '#ffeecc', fontMutedColor: '#8899aa' }, 'light')
    ).toEqual({ fontBodyColor: '#ffeecc', fontMutedColor: '#8899aa' });
  });

  it('refuses unsafe or ineffective values', () => {
    expect(() =>
      RuntimeSettingsSchema.parse({
        ...DEFAULT_RUNTIME_SETTINGS,
        loop: { ...DEFAULT_RUNTIME_SETTINGS.loop, maxSteps: 41 },
      })
    ).toThrow();
    expect(() =>
      RuntimeSettingsSchema.parse({
        ...DEFAULT_RUNTIME_SETTINGS,
        behavior: { ...DEFAULT_RUNTIME_SETTINGS.behavior, surprise: true },
      })
    ).toThrow();
    expect(() => RuntimeSettingsSchema.parse({ ...DEFAULT_RUNTIME_SETTINGS, density: 'dense' })).toThrow();
  });
});
