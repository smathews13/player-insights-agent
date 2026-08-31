import { z } from 'zod';

import {
  DEFAULT_ENTITY_STYLES,
  DENSITY_IDS,
  FONT_FAMILY_IDS,
  FONT_SIZE_IDS,
  RUNTIME_ENTITY_KINDS,
  THEME_FONT_COLORS,
  upgradePaperEntityStyles,
} from './runtime-settings-browser';

export {
  DEFAULT_ENTITY_STYLES,
  DEFAULT_RUNTIME_SETTINGS,
  DENSITY_IDS,
  FONT_FAMILY_IDS,
  FONT_FAMILY_STACKS,
  FONT_SIZE_IDS,
  FONT_SIZE_SCALE,
  PAPER_ENTITY_STYLES,
  RUNTIME_ANSWER_KEYS,
  RUNTIME_BEHAVIOR_KEYS,
  RUNTIME_ENTITY_KINDS,
  RUNTIME_ENTITY_STYLE_KEYS,
  RUNTIME_LOOP_KEYS,
  RUNTIME_SETTINGS_KEYS,
  THEME_FONT_COLORS,
  fontColorsForScheme,
  isHexColor,
  runtimeAppearanceCssVariables,
  runtimeEntityCssVariables,
  runtimeTypographyCssVariables,
  upgradePaperEntityStyles,
} from './runtime-settings-browser';
export type {
  DensityId,
  FontFamilyId,
  FontSizeId,
  RuntimeEntityCssVariables,
  RuntimeEntityKind,
  RuntimeEntityStyle,
  RuntimeEntityStyles,
} from './runtime-settings-browser';

export const RuntimeEntityKindSchema = z.enum(RUNTIME_ENTITY_KINDS);

const EntityStyleSchema = z.strictObject({
  foreground: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.'),
  background: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.'),
});

const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.');

export const RuntimeEntityStylesObjectSchema = z.strictObject(
  Object.fromEntries(RUNTIME_ENTITY_KINDS.map((kind) => [kind, EntityStyleSchema])) as Record<
    (typeof RUNTIME_ENTITY_KINDS)[number],
    typeof EntityStyleSchema
  >
);

/**
 * The authoritative boundary for API responses, server persistence, and the
 * Settings form. The localStorage cache has a browser-only parser in
 * runtime-settings-browser.ts; it grants no capability and never replaces this
 * schema at a network or persistence boundary.
 */
export const RuntimeSettingsObjectSchema = z.strictObject({
  loop: z.strictObject({
    maxSteps: z.number().int().min(1).max(20),
    maxToolCalls: z.number().int().min(1).max(40),
    maxRunSeconds: z.number().int().min(30).max(200),
  }),
  answer: z.strictObject({
    takeaway: z.boolean(),
    narrative: z.boolean(),
    charts: z.boolean(),
    figures: z.boolean(),
    caveats: z.boolean(),
    maxCharts: z.number().int().min(0).max(6),
    maxFigures: z.number().int().min(0).max(12),
    maxCaveats: z.number().int().min(0).max(20),
    narrativeMaxCharacters: z.number().int().min(0).max(12_000),
    sources: z.enum(['compact', 'standard', 'detailed']),
    // Defaulted so rows stored before these fields existed stay parseable.
    takeawayGuidance: z.string().trim().max(2_000).default(''),
    narrativeGuidance: z.string().trim().max(2_000).default(''),
    figuresOrder: z.enum(['as-ranked', 'totals-first', 'averages-first']).default('as-ranked'),
    chartsTypes: z.enum(['auto', 'bar', 'bar-line']).default('auto'),
  }),
  behavior: z.strictObject({
    clarification: z.enum(['strict', 'balanced', 'proceed-with-caveat']),
    timezone: z.string().trim().max(80),
    injectCurrentDate: z.boolean(),
  }),
  colorScheme: z.enum(['dark', 'light']).default('dark'),
  entityStyles: RuntimeEntityStylesObjectSchema.default(DEFAULT_ENTITY_STYLES).transform(upgradePaperEntityStyles),
  fontBodyColor: HexColorSchema.optional(),
  fontMutedColor: HexColorSchema.optional(),
  fontFamily: z.enum(FONT_FAMILY_IDS).default('dm-sans'),
  fontSize: z.enum(FONT_SIZE_IDS).default('m'),
  backgroundGraphics: z.boolean().default(true),
  animations: z.boolean().default(true),
  density: z.enum(DENSITY_IDS).default('comfortable'),
});

export const RuntimeSettingsSchema = RuntimeSettingsObjectSchema.transform((settings) => ({
  ...settings,
  fontBodyColor: settings.fontBodyColor ?? THEME_FONT_COLORS[settings.colorScheme].body,
  fontMutedColor: settings.fontMutedColor ?? THEME_FONT_COLORS[settings.colorScheme].muted,
}));

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

export function parseRuntimeSettings(value: unknown): RuntimeSettings {
  return RuntimeSettingsSchema.parse(value);
}
