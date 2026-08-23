/**
 * The app's light/dark paint, independent of the OS.
 *
 * `class="light"` stays on <html> forever: AppKit's stylesheet flips every token
 * under `@media (prefers-color-scheme: dark) { :root:not(.light) }`, and that is
 * not this theme. `data-theme` is ours. Dark is the default so the first paint
 * is the night sky rather than a white flash while settings load.
 */

export type ColorScheme = 'dark' | 'light';

export const DEFAULT_COLOR_SCHEME: ColorScheme = 'dark';
export const DARK_THEME_COLOR = '#11171c';
export const LIGHT_THEME_COLOR = '#ffffff';

type ThemeRoot = {
  classList: Pick<DOMTokenList, 'add'>;
  setAttribute(name: string, value: string): void;
};

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'dark' || value === 'light';
}

function liveDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

export function applyColorScheme(
  scheme: ColorScheme,
  root: ThemeRoot | null = liveDocument()?.documentElement ?? null,
  themeColor: { setAttribute(name: string, value: string): void } | null = liveDocument()?.querySelector(
    'meta[name="theme-color"]'
  ) ?? null
): void {
  if (!root) return;
  root.classList.add('light');
  root.setAttribute('data-theme', scheme);
  themeColor?.setAttribute('content', scheme === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
}
