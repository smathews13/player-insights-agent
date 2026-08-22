import { z } from 'zod';

export const RuntimeEntityKindSchema = z.enum(['catalog', 'schema', 'table', 'column', 'quote', 'tag']);
export type RuntimeEntityKind = z.infer<typeof RuntimeEntityKindSchema>;

const EntityStyleSchema = z.strictObject({
  foreground: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.'),
  background: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.'),
});

export const RuntimeSettingsSchema = z.strictObject({
  loop: z.strictObject({
    maxSteps: z.number().int().min(1).max(20),
    maxToolCalls: z.number().int().min(1).max(40),
    maxRunSeconds: z.number().int().min(30).max(180),
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
    // Free-text guidance handed to the agent with the section it belongs to.
    // Defaulted so a row stored before these fields existed parses rather than
    // being dropped back to defaults on the next read. Empty ships nothing.
    takeawayGuidance: z.string().trim().max(2_000).default(''),
    narrativeGuidance: z.string().trim().max(2_000).default(''),
    // How the agent orders the figure cards it returns, and which chart shapes
    // it may draw. Both travel to the agent as part of runtime_settings.
    figuresOrder: z.enum(['as-ranked', 'totals-first', 'averages-first']).default('as-ranked'),
    chartsTypes: z.enum(['auto', 'bar', 'bar-line']).default('auto'),
  }),
  behavior: z.strictObject({
    clarification: z.enum(['strict', 'balanced', 'proceed-with-caveat']),
    timezone: z.string().trim().max(80),
    injectCurrentDate: z.boolean(),
  }),
  colorScheme: z.enum(['dark', 'light']).default('dark'),
  entityStyles: z.strictObject({
    catalog: EntityStyleSchema,
    schema: EntityStyleSchema,
    table: EntityStyleSchema,
    column: EntityStyleSchema,
    quote: EntityStyleSchema,
    tag: EntityStyleSchema,
  }).default({
    catalog: { foreground: '#ffffff', background: '#0e538b' },
    schema: { foreground: '#16324f', background: '#ddeaf4' },
    table: { foreground: '#3a3838', background: '#e8e8e8' },
    column: { foreground: '#3a3838', background: '#f4f4f4' },
    quote: { foreground: '#46596b', background: '#f7f7f7' },
    tag: { foreground: '#ffffff', background: '#243746' },
  }),
});

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

/** Current behavior. An empty store therefore changes no existing deployment. */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  loop: { maxSteps: 12, maxToolCalls: 12, maxRunSeconds: 90 },
  answer: {
    takeaway: true,
    narrative: true,
    charts: true,
    figures: true,
    caveats: true,
    maxCharts: 2,
    maxFigures: 6,
    maxCaveats: 0,
    narrativeMaxCharacters: 0,
    sources: 'standard',
    takeawayGuidance: '',
    narrativeGuidance: '',
    figuresOrder: 'as-ranked',
    chartsTypes: 'auto',
  },
  behavior: {
    clarification: 'balanced',
    timezone: '',
    injectCurrentDate: false,
  },
  colorScheme: 'dark',
  entityStyles: {
    catalog: { foreground: '#ffffff', background: '#0e538b' },
    schema: { foreground: '#16324f', background: '#ddeaf4' },
    table: { foreground: '#3a3838', background: '#e8e8e8' },
    column: { foreground: '#3a3838', background: '#f4f4f4' },
    quote: { foreground: '#46596b', background: '#f7f7f7' },
    tag: { foreground: '#ffffff', background: '#243746' },
  },
};

export type RuntimeEntityCssVariables = Record<`--entity-${RuntimeEntityKind}-${'fg' | 'bg'}`, string>;

/** Shared Ask/Run Explorer rendering tokens derived from the saved settings. */
export function runtimeEntityCssVariables(settings: RuntimeSettings): RuntimeEntityCssVariables {
  return Object.fromEntries(
    RuntimeEntityKindSchema.options.flatMap((kind) => [
      [`--entity-${kind}-fg`, settings.entityStyles[kind].foreground],
      [`--entity-${kind}-bg`, settings.entityStyles[kind].background],
    ]),
  ) as RuntimeEntityCssVariables;
}

export function parseRuntimeSettings(value: unknown): RuntimeSettings {
  return RuntimeSettingsSchema.parse(value);
}
