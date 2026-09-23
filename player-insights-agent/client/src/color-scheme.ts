/**
 * The app's light/dark paint after first load.
 *
 * `class="light"` stays on <html> forever: AppKit's stylesheet flips every token
 * under `@media (prefers-color-scheme: dark) { :root:not(.light) }`, and that is
 * not this theme. `data-theme` is ours. Light is the default first paint; a
 * cached or server-saved preference may replace it without AppKit consulting
 * the operating-system media query. index.html consults the OS only when no
 * cached preference exists; after that, data-theme remains authoritative.
 */

export type ColorScheme = 'dark' | 'light';

export const DEFAULT_COLOR_SCHEME: ColorScheme = 'light';
export const DARK_THEME_COLOR = '#0b1014';
export const LIGHT_THEME_COLOR = '#f4f7f9';

type ThemeRoot = {
  classList: Pick<DOMTokenList, 'add'>;
  getAttribute?(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'dark' || value === 'light';
}

function liveDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/** Read only the scheme this app painted, never the operating-system preference. */
export function appliedColorScheme(
  root: Pick<ThemeRoot, 'getAttribute'> | null = liveDocument()?.documentElement ?? null
): ColorScheme | null {
  const scheme = root?.getAttribute?.('data-theme');
  return isColorScheme(scheme) ? scheme : null;
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
