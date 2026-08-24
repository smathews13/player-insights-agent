import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTITY_STYLES,
  DEFAULT_RUNTIME_SETTINGS,
  PAPER_ENTITY_STYLES,
  RuntimeSettingsSchema,
  parseRuntimeSettings,
  runtimeEntityCssVariables,
  upgradePaperEntityStyles,
} from './runtime-settings';

const PAPER_FILLS = ['#ddeaf4', '#e8e8e8', '#f4f4f4', '#f7f7f7'] as const;

describe('runtime settings contract', () => {
  it('keeps the current agent behavior as its defaults', () => {
    expect(RuntimeSettingsSchema.parse(DEFAULT_RUNTIME_SETTINGS)).toEqual(DEFAULT_RUNTIME_SETTINGS);
    expect(DEFAULT_RUNTIME_SETTINGS.loop).toEqual({
      maxSteps: 12,
      maxToolCalls: 12,
      maxRunSeconds: 150,
    });
    expect(DEFAULT_RUNTIME_SETTINGS.answer.maxFigures).toBe(6);
    expect(DEFAULT_RUNTIME_SETTINGS.answer.maxCharts).toBe(1);
  });

  it('ships night-sky entity chips, not paper fills', () => {
    expect(DEFAULT_RUNTIME_SETTINGS.entityStyles).toEqual(DEFAULT_ENTITY_STYLES);
    expect(DEFAULT_ENTITY_STYLES).toEqual({
      catalog: { foreground: '#8fc1e8', background: '#1b3049' },
      schema: { foreground: '#f2f6fa', background: '#25323c' },
      table: { foreground: '#f2f6fa', background: '#2e3337' },
      column: { foreground: '#e8f2fa', background: '#1e2830' },
      quote: { foreground: '#b7d6ee', background: '#181e23' },
      tag: { foreground: '#f2f6fa', background: '#243746' },
    });

    const backgrounds = Object.values(DEFAULT_ENTITY_STYLES).map((style) => style.background.toLowerCase());
    const foregrounds = Object.values(DEFAULT_ENTITY_STYLES).map((style) => style.foreground.toLowerCase());
    for (const fill of PAPER_FILLS) {
      expect(backgrounds, `${fill} is a paper highlight`).not.toContain(fill);
    }
    expect(new Set(backgrounds).size, 'kinds share a highlight').toBe(backgrounds.length);
    expect(foregrounds.every((hex) => !['#16324f', '#3a3838', '#46596b'].includes(hex))).toBe(true);

    expect(runtimeEntityCssVariables(DEFAULT_RUNTIME_SETTINGS)).toMatchObject({
      '--entity-catalog-fg': '#8fc1e8',
      '--entity-catalog-bg': '#1b3049',
      '--entity-schema-bg': '#25323c',
      '--entity-table-bg': '#2e3337',
      '--entity-column-bg': '#1e2830',
      '--entity-quote-bg': '#181e23',
      '--entity-tag-bg': '#243746',
    });
  });

  it('upgrades leftover paper pairs and leaves a chosen pair alone', () => {
    expect(upgradePaperEntityStyles(PAPER_ENTITY_STYLES)).toEqual(DEFAULT_ENTITY_STYLES);

    const customTable = { foreground: '#112233', background: '#445566' };
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
