/**
 * Browser-safe runtime settings contract.
 *
 * The server and Settings form validate untrusted API payloads with the
 * authoritative Zod schema in runtime-settings.ts. The explicit parser here is
 * only for the same-origin localStorage appearance cache: rejecting a cache row
 * falls back to server settings, and accepting one grants no capability.
 */

export const RUNTIME_ENTITY_KINDS = ['catalog', 'schema', 'table', 'column', 'quote', 'tag'] as const;
export type RuntimeEntityKind = (typeof RUNTIME_ENTITY_KINDS)[number];

export type RuntimeEntityStyle = {
  foreground: string;
  background: string;
};
export type RuntimeEntityStyles = Record<RuntimeEntityKind, RuntimeEntityStyle>;

export const RUNTIME_SETTINGS_KEYS = [
  'loop',
  'answer',
  'behavior',
  'colorScheme',
  'entityStyles',
  'fontBodyColor',
  'fontMutedColor',
  'fontFamily',
  'fontSize',
  'backgroundGraphics',
  'animations',
  'density',
] as const;
export const RUNTIME_LOOP_KEYS = ['maxSteps', 'maxToolCalls', 'maxRunSeconds'] as const;
export const RUNTIME_ANSWER_KEYS = [
  'takeaway',
  'narrative',
  'charts',
  'figures',
  'caveats',
  'maxCharts',
  'maxFigures',
  'maxCaveats',
  'narrativeMaxCharacters',
  'sources',
  'takeawayGuidance',
  'narrativeGuidance',
  'figuresOrder',
  'chartsTypes',
] as const;
export const RUNTIME_BEHAVIOR_KEYS = ['clarification', 'timezone', 'injectCurrentDate'] as const;
export const RUNTIME_ENTITY_STYLE_KEYS = ['foreground', 'background'] as const;

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

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const FONT_FAMILY_IDS = ['dm-sans', 'system', 'dm-mono'] as const;
export type FontFamilyId = (typeof FONT_FAMILY_IDS)[number];

export const FONT_SIZE_IDS = ['s', 'm', 'l'] as const;
export type FontSizeId = (typeof FONT_SIZE_IDS)[number];

export const DENSITY_IDS = ['comfortable', 'compact'] as const;
export type DensityId = (typeof DENSITY_IDS)[number];

export const THEME_FONT_COLORS: Record<'dark' | 'light', { body: string; muted: string }> = {
  dark: { body: '#ffffff', muted: '#c5ccd4' },
  light: { body: '#161616', muted: '#6f6f6f' },
};

export const FONT_FAMILY_STACKS: Record<FontFamilyId, string> = {
  'dm-sans': "'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  'dm-mono': "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

export const FONT_SIZE_SCALE: Record<FontSizeId, number> = {
  s: 0.92,
  m: 1,
  l: 1.15,
};

const TYPE_TOKEN_PX = [
  ['--text-xs', 11],
  ['--text-sm', 12],
  ['--text-base', 13],
  ['--text-h-sub', 14],
  ['--text-h-section', 16],
  ['--text-h-card', 18],
  ['--text-h-page', 22],
  ['--text-kpi', 22],
  ['--text-hero', 32],
  ['--ast-fs-11', 11],
  ['--ast-fs-12', 12],
  ['--ast-fs-13', 13],
  ['--ast-fs-14', 14],
  ['--ast-fs-16', 16],
  ['--ast-fs-18', 18],
  ['--ast-fs-22', 22],
  ['--ast-fs-32', 32],
] as const;

export type RuntimeSettings = {
  loop: {
    maxSteps: number;
    maxToolCalls: number;
    maxRunSeconds: number;
  };
  answer: {
    takeaway: boolean;
    narrative: boolean;
    charts: boolean;
    figures: boolean;
    caveats: boolean;
    maxCharts: number;
    maxFigures: number;
    maxCaveats: number;
    narrativeMaxCharacters: number;
    sources: 'compact' | 'standard' | 'detailed';
    takeawayGuidance: string;
    narrativeGuidance: string;
    figuresOrder: 'as-ranked' | 'totals-first' | 'averages-first';
    chartsTypes: 'auto' | 'bar' | 'bar-line';
  };
  behavior: {
    clarification: 'strict' | 'balanced' | 'proceed-with-caveat';
    timezone: string;
    injectCurrentDate: boolean;
  };
  colorScheme: 'dark' | 'light';
  entityStyles: RuntimeEntityStyles;
  fontBodyColor: string;
  fontMutedColor: string;
  fontFamily: FontFamilyId;
  fontSize: FontSizeId;
  backgroundGraphics: boolean;
  animations: boolean;
  density: DensityId;
};

/** Replace leftover paper pairs; leave any pair someone actually set. */
export function upgradePaperEntityStyles(styles: RuntimeEntityStyles): RuntimeEntityStyles {
  return Object.fromEntries(
    RUNTIME_ENTITY_KINDS.map((kind) => [
      kind,
      sameHexStyle(styles[kind], PAPER_ENTITY_STYLES[kind]) ? DEFAULT_ENTITY_STYLES[kind] : styles[kind],
    ])
  ) as RuntimeEntityStyles;
}

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
  fontBodyColor: THEME_FONT_COLORS.dark.body,
  fontMutedColor: THEME_FONT_COLORS.dark.muted,
  fontFamily: 'dm-sans',
  fontSize: 'm',
  backgroundGraphics: true,
  animations: true,
  density: 'comfortable',
};

type JsonObject = Record<string, unknown>;

function strictObject(value: unknown, keys: readonly string[]): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as JsonObject;
  return Object.keys(object).every((key) => keys.includes(key)) ? object : null;
}

function owns(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : null;
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] | null {
  return typeof value === 'string' && values.includes(value) ? (value as Values[number]) : null;
}

function trimmedString(value: unknown, maximum: number, fallback?: string): string | null {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : null;
}

function parseEntityStyles(value: unknown): RuntimeEntityStyles | null {
  if (value === undefined) {
    return Object.fromEntries(
      RUNTIME_ENTITY_KINDS.map((kind) => [kind, { ...DEFAULT_ENTITY_STYLES[kind] }])
    ) as RuntimeEntityStyles;
  }
  const object = strictObject(value, RUNTIME_ENTITY_KINDS);
  if (!object || !RUNTIME_ENTITY_KINDS.every((kind) => owns(object, kind))) return null;

  const entries = RUNTIME_ENTITY_KINDS.map((kind) => {
    const style = strictObject(object[kind], RUNTIME_ENTITY_STYLE_KEYS);
    if (
      !style ||
      !RUNTIME_ENTITY_STYLE_KEYS.every((key) => owns(style, key)) ||
      typeof style.foreground !== 'string' ||
      typeof style.background !== 'string' ||
      !isHexColor(style.foreground) ||
      !isHexColor(style.background)
    ) {
      return null;
    }
    return [kind, { foreground: style.foreground, background: style.background }] as const;
  });
  if (entries.some((entry) => entry === null)) return null;
  return upgradePaperEntityStyles(
    Object.fromEntries(entries as [RuntimeEntityKind, RuntimeEntityStyle][]) as RuntimeEntityStyles
  );
}

/**
 * Parse the non-authoritative localStorage cache without pulling Zod into Ask.
 *
 * This intentionally mirrors RuntimeSettingsSchema's strict keys, ranges,
 * normalization, and legacy defaults. It is not exported through the
 * authoritative schema module so server code cannot accidentally adopt it.
 */
export function parsePersistedRuntimeSettings(value: unknown): RuntimeSettings | null {
  const root = strictObject(value, RUNTIME_SETTINGS_KEYS);
  if (!root) return null;
  const loop = strictObject(root.loop, RUNTIME_LOOP_KEYS);
  const answer = strictObject(root.answer, RUNTIME_ANSWER_KEYS);
  const behavior = strictObject(root.behavior, RUNTIME_BEHAVIOR_KEYS);
  if (
    !loop ||
    !answer ||
    !behavior ||
    !RUNTIME_LOOP_KEYS.every((key) => owns(loop, key)) ||
    ![
      'takeaway',
      'narrative',
      'charts',
      'figures',
      'caveats',
      'maxCharts',
      'maxFigures',
      'maxCaveats',
      'narrativeMaxCharacters',
      'sources',
    ].every((key) => owns(answer, key)) ||
    !RUNTIME_BEHAVIOR_KEYS.every((key) => owns(behavior, key))
  ) {
    return null;
  }

  const maxSteps = integer(loop.maxSteps, 1, 20);
  const maxToolCalls = integer(loop.maxToolCalls, 1, 40);
  const maxRunSeconds = integer(loop.maxRunSeconds, 30, 200);
  const maxCharts = integer(answer.maxCharts, 0, 6);
  const maxFigures = integer(answer.maxFigures, 0, 12);
  const maxCaveats = integer(answer.maxCaveats, 0, 20);
  const narrativeMaxCharacters = integer(answer.narrativeMaxCharacters, 0, 12_000);
  const sources = oneOf(answer.sources, ['compact', 'standard', 'detailed'] as const);
  const takeawayGuidance = trimmedString(answer.takeawayGuidance, 2_000, '');
  const narrativeGuidance = trimmedString(answer.narrativeGuidance, 2_000, '');
  const figuresOrder = oneOf(answer.figuresOrder === undefined ? 'as-ranked' : answer.figuresOrder, [
    'as-ranked',
    'totals-first',
    'averages-first',
  ] as const);
  const chartsTypes = oneOf(answer.chartsTypes === undefined ? 'auto' : answer.chartsTypes, [
    'auto',
    'bar',
    'bar-line',
  ] as const);
  const clarification = oneOf(behavior.clarification, ['strict', 'balanced', 'proceed-with-caveat'] as const);
  const timezone = trimmedString(behavior.timezone, 80);
  const colorScheme = oneOf(root.colorScheme === undefined ? 'dark' : root.colorScheme, ['dark', 'light'] as const);
  const entityStyles = parseEntityStyles(root.entityStyles);
  const fontFamily = oneOf(root.fontFamily === undefined ? 'dm-sans' : root.fontFamily, FONT_FAMILY_IDS);
  const fontSize = oneOf(root.fontSize === undefined ? 'm' : root.fontSize, FONT_SIZE_IDS);
  const density = oneOf(root.density === undefined ? 'comfortable' : root.density, DENSITY_IDS);
  const fontBodyColor =
    root.fontBodyColor === undefined && colorScheme
      ? THEME_FONT_COLORS[colorScheme].body
      : typeof root.fontBodyColor === 'string' && isHexColor(root.fontBodyColor)
        ? root.fontBodyColor
        : null;
  const fontMutedColor =
    root.fontMutedColor === undefined && colorScheme
      ? THEME_FONT_COLORS[colorScheme].muted
      : typeof root.fontMutedColor === 'string' && isHexColor(root.fontMutedColor)
        ? root.fontMutedColor
        : null;

  if (
    maxSteps === null ||
    maxToolCalls === null ||
    maxRunSeconds === null ||
    maxCharts === null ||
    maxFigures === null ||
    maxCaveats === null ||
    narrativeMaxCharacters === null ||
    sources === null ||
    takeawayGuidance === null ||
    narrativeGuidance === null ||
    figuresOrder === null ||
    chartsTypes === null ||
    clarification === null ||
    timezone === null ||
    colorScheme === null ||
    entityStyles === null ||
    fontBodyColor === null ||
    fontMutedColor === null ||
    fontFamily === null ||
    fontSize === null ||
    density === null ||
    typeof answer.takeaway !== 'boolean' ||
    typeof answer.narrative !== 'boolean' ||
    typeof answer.charts !== 'boolean' ||
    typeof answer.figures !== 'boolean' ||
    typeof answer.caveats !== 'boolean' ||
    typeof behavior.injectCurrentDate !== 'boolean' ||
    (root.backgroundGraphics !== undefined && typeof root.backgroundGraphics !== 'boolean') ||
    (root.animations !== undefined && typeof root.animations !== 'boolean')
  ) {
    return null;
  }

  return {
    loop: { maxSteps, maxToolCalls, maxRunSeconds },
    answer: {
      takeaway: answer.takeaway,
      narrative: answer.narrative,
      charts: answer.charts,
      figures: answer.figures,
      caveats: answer.caveats,
      maxCharts,
      maxFigures,
      maxCaveats,
      narrativeMaxCharacters,
      sources,
      takeawayGuidance,
      narrativeGuidance,
      figuresOrder,
      chartsTypes,
    },
    behavior: {
      clarification,
      timezone,
      injectCurrentDate: behavior.injectCurrentDate,
    },
    colorScheme,
    entityStyles,
    fontBodyColor,
    fontMutedColor,
    fontFamily,
    fontSize,
    backgroundGraphics: root.backgroundGraphics === undefined ? true : root.backgroundGraphics,
    animations: root.animations === undefined ? true : root.animations,
    density,
  };
}

export type RuntimeEntityCssVariables = Record<`--entity-${RuntimeEntityKind}-${'fg' | 'bg'}`, string>;

/** Shared Ask/Run Explorer rendering tokens derived from the saved settings. */
export function runtimeEntityCssVariables(settings: RuntimeSettings): RuntimeEntityCssVariables {
  return Object.fromEntries(
    RUNTIME_ENTITY_KINDS.flatMap((kind) => [
      [`--entity-${kind}-fg`, settings.entityStyles[kind].foreground],
      [`--entity-${kind}-bg`, settings.entityStyles[kind].background],
    ])
  ) as RuntimeEntityCssVariables;
}

/** Type tokens written onto the document so every surface reads one choice. */
export function runtimeTypographyCssVariables(settings: RuntimeSettings): Record<string, string> {
  const scale = FONT_SIZE_SCALE[settings.fontSize];
  const sizes = Object.fromEntries(TYPE_TOKEN_PX.map(([name, px]) => [name, `${Math.round(px * scale)}px`]));
  return {
    '--ast-text': settings.fontBodyColor,
    '--ast-text-long': settings.fontBodyColor,
    '--foreground': settings.fontBodyColor,
    '--card-foreground': settings.fontBodyColor,
    '--popover-foreground': settings.fontBodyColor,
    '--secondary-foreground': settings.fontBodyColor,
    '--accent-foreground': settings.fontBodyColor,
    '--db-ink': settings.fontBodyColor,
    '--db-body': settings.fontBodyColor,
    '--ast-text-secondary': settings.fontMutedColor,
    '--ast-caption': settings.fontMutedColor,
    '--muted-foreground': settings.fontMutedColor,
    '--db-slate': settings.fontMutedColor,
    '--font-sans': FONT_FAMILY_STACKS[settings.fontFamily],
    ...sizes,
  };
}

/** Entity chips plus type — the full Appearance result on the app root. */
export function runtimeAppearanceCssVariables(settings: RuntimeSettings): Record<string, string> {
  return {
    ...runtimeEntityCssVariables(settings),
    ...runtimeTypographyCssVariables(settings),
  };
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

/** Keep a custom colour; follow the new theme when the reader was still on defaults. */
export function fontColorsForScheme(
  settings: Pick<RuntimeSettings, 'colorScheme' | 'fontBodyColor' | 'fontMutedColor'>,
  nextScheme: 'dark' | 'light'
): Pick<RuntimeSettings, 'fontBodyColor' | 'fontMutedColor'> {
  const from = THEME_FONT_COLORS[settings.colorScheme];
  const to = THEME_FONT_COLORS[nextScheme];
  return {
    fontBodyColor: sameHex(settings.fontBodyColor, from.body) ? to.body : settings.fontBodyColor,
    fontMutedColor: sameHex(settings.fontMutedColor, from.muted) ? to.muted : settings.fontMutedColor,
  };
}
