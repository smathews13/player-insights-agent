import {
  DEFAULT_ENTITY_STYLES,
  RuntimeEntityKindSchema,
  THEME_FONT_COLORS,
  isHexColor,
  type RuntimeSettings,
} from '../../shared/runtime-settings';

export const WCAG_AA_NORMAL_TEXT_RATIO = 4.5;

export const APPEARANCE_SURFACES = {
  dark: '#11171c',
  light: '#ffffff',
} as const;

export type AppearanceContrastCheck = {
  id: string;
  label: string;
  foreground: string;
  background: string;
  ratio: number | null;
  passes: boolean;
};

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number | null {
  if (!isHexColor(hex)) return null;
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((value) =>
    linearChannel(Number.parseInt(value, 16))
  );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number | null {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function check(id: string, label: string, foreground: string, background: string): AppearanceContrastCheck {
  const ratio = contrastRatio(foreground, background);
  return {
    id,
    label,
    foreground,
    background,
    ratio,
    passes: ratio !== null && ratio >= WCAG_AA_NORMAL_TEXT_RATIO,
  };
}

export function appearanceContrastChecks(
  settings: Pick<RuntimeSettings, 'colorScheme' | 'fontBodyColor' | 'fontMutedColor' | 'entityStyles'>
): AppearanceContrastCheck[] {
  const surface = APPEARANCE_SURFACES[settings.colorScheme];
  const schemeLabel = `${settings.colorScheme} app surface`;
  return [
    check('body', `Body text / ${schemeLabel}`, settings.fontBodyColor, surface),
    check('secondary', `Secondary text / ${schemeLabel}`, settings.fontMutedColor, surface),
    ...RuntimeEntityKindSchema.options.map((kind) =>
      check(
        `entity-${kind}`,
        `${kind[0].toUpperCase()}${kind.slice(1)} text / highlight`,
        settings.entityStyles[kind].foreground,
        settings.entityStyles[kind].background
      )
    ),
  ];
}

/** Restore every editable colour in one state transition, without touching other settings. */
export function restoreSafeAppearancePalette(settings: RuntimeSettings): RuntimeSettings {
  return {
    ...settings,
    fontBodyColor: THEME_FONT_COLORS[settings.colorScheme].body,
    fontMutedColor: THEME_FONT_COLORS[settings.colorScheme].muted,
    entityStyles: Object.fromEntries(
      RuntimeEntityKindSchema.options.map((kind) => [kind, { ...DEFAULT_ENTITY_STYLES[kind] }])
    ) as RuntimeSettings['entityStyles'],
  };
}
