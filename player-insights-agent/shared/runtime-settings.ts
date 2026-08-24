import { z } from 'zod';

export const RuntimeEntityKindSchema = z.enum(['catalog', 'schema', 'table', 'column', 'quote', 'tag']);
export type RuntimeEntityKind = z.infer<typeof RuntimeEntityKindSchema>;

const EntityStyleSchema = z.strictObject({
  foreground: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.'),
  background: z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.'),
});

export type RuntimeEntityStyle = z.infer<typeof EntityStyleSchema>;
export type RuntimeEntityStyles = Record<RuntimeEntityKind, RuntimeEntityStyle>;

/**
 * Paper-era chips. A stored pair that still equals these was never chosen —
 * it rode along when someone saved loop or answer settings — so read upgrades
 * that pair to the night-sky default. A pair that differs is a choice and stays.
 */
export const PAPER_ENTITY_STYLES: RuntimeEntityStyles = {
  catalog: { foreground: '#ffffff', background: '#0e538b' },
  schema: { foreground: '#16324f', background: '#ddeaf4' },
  table: { foreground: '#3a3838', background: '#e8e8e8' },
  column: { foreground: '#3a3838', background: '#f4f4f4' },
  quote: { foreground: '#46596b', background: '#f7f7f7' },
  tag: { foreground: '#ffffff', background: '#243746' },
};

/**
 * Night-sky chips. Hex composites of the ice/navy washes already on the dark
 * tokens, so the Settings colour fields, the CSS fallbacks, and an empty store
 * all paint the same quiet pills.
 *
 *   catalog  ice on raised navy-blue   --ast-ice-accent / --ast-primary-control-fill
 *   schema   ink on ice 16%            --ast-ink-on-dark / info-fill over navy
 *   table    ink on white 12%          --ast-ink-on-dark / neutral-fill over navy
 *   column   ghost on ice 10%          --ast-ghost-text / catalog wash over navy
 *   quote    icon-tint on surface      --ast-icon-tint / --ast-surface-solid
 *   tag      ink on the existing slate --ast-ink-on-dark / the tag fill that already sat
 */
export const DEFAULT_ENTITY_STYLES: RuntimeEntityStyles = {
  catalog: { foreground: '#8fc1e8', background: '#1b3049' },
  schema: { foreground: '#f2f6fa', background: '#25323c' },
  table: { foreground: '#f2f6fa', background: '#2e3337' },
  column: { foreground: '#e8f2fa', background: '#1e2830' },
  quote: { foreground: '#b7d6ee', background: '#181e23' },
  tag: { foreground: '#f2f6fa', background: '#243746' },
};

function sameHexStyle(left: RuntimeEntityStyle, right: RuntimeEntityStyle): boolean {
  return (
    left.foreground.toLowerCase() === right.foreground.toLowerCase() &&
    left.background.toLowerCase() === right.background.toLowerCase()
  );
}

/** Replace leftover paper pairs; leave any pair someone actually set. */
export function upgradePaperEntityStyles(styles: RuntimeEntityStyles): RuntimeEntityStyles {
  return Object.fromEntries(
    RuntimeEntityKindSchema.options.map((kind) => [
      kind,
      sameHexStyle(styles[kind], PAPER_ENTITY_STYLES[kind]) ? DEFAULT_ENTITY_STYLES[kind] : styles[kind],
    ])
  ) as RuntimeEntityStyles;
}

export const RuntimeSettingsSchema = z.strictObject({
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
  entityStyles: z
    .strictObject({
      catalog: EntityStyleSchema,
      schema: EntityStyleSchema,
      table: EntityStyleSchema,
      column: EntityStyleSchema,
      quote: EntityStyleSchema,
      tag: EntityStyleSchema,
    })
    .default(DEFAULT_ENTITY_STYLES)
    .transform(upgradePaperEntityStyles),
});

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

/** Current behavior. An empty store therefore changes no existing deployment. */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  loop: { maxSteps: 12, maxToolCalls: 12, maxRunSeconds: 150 },
  answer: {
    takeaway: true,
    narrative: true,
    charts: true,
    figures: true,
    caveats: true,
    maxCharts: 1,
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
  entityStyles: DEFAULT_ENTITY_STYLES,
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
