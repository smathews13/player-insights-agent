import { useEffect } from 'react';
import {
  parseRuntimeSettings,
  runtimeAppearanceCssVariables,
  runtimeTypographyCssVariables,
  type RuntimeSettings,
} from '../../shared/runtime-settings';
import { applyColorScheme } from './color-scheme';
import {
  loadLiveRuntimeSettings,
  recalledLiveRuntimeSettings,
  rememberLiveRuntimeSettings,
  subscribeLiveRuntimeSettings,
} from './runtime-settings-live';

export const RUNTIME_APPEARANCE_CACHE_KEY = 'astrolabe.runtime-appearance.v1';

type AppearanceRoot = {
  style: Pick<CSSStyleDeclaration, 'setProperty'>;
  setAttribute(name: string, value: string): void;
};

function writeVariables(
  variables: Record<string, string>,
  target: Pick<CSSStyleDeclaration, 'setProperty'> | null
): void {
  if (!target) return;
  for (const [name, value] of Object.entries(variables)) {
    target.setProperty(name, value);
  }
}

export function writeRuntimeAppearanceAttributes(
  settings: RuntimeSettings,
  root: Pick<AppearanceRoot, 'setAttribute'> | null = typeof document === 'undefined' ? null : document.documentElement
): void {
  if (!root) return;
  root.setAttribute('data-background-graphics', settings.backgroundGraphics ? 'on' : 'off');
  root.setAttribute('data-animations', settings.animations ? 'on' : 'off');
  root.setAttribute('data-density', settings.density);
}

function paintRuntimeStyles(settings: RuntimeSettings, target: Pick<CSSStyleDeclaration, 'setProperty'> | null): void {
  writeVariables(runtimeAppearanceCssVariables(settings), target);
  writeRuntimeAppearanceAttributes(settings);
  applyColorScheme(settings.colorScheme);
}

export function cacheRuntimeAppearance(
  settings: RuntimeSettings,
  storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage
): void {
  try {
    storage?.setItem(RUNTIME_APPEARANCE_CACHE_KEY, JSON.stringify(settings));
  } catch {
    // Server settings stay canonical when private browsing blocks local storage.
  }
}

export function runtimeAppearanceFromCache(value: string | null): RuntimeSettings | null {
  if (!value) return null;
  try {
    return parseRuntimeSettings(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Paint a staged Appearance draft without publishing it as the saved row. */
export function previewRuntimeAppearance(
  settings: RuntimeSettings,
  target: Pick<CSSStyleDeclaration, 'setProperty'> | null = typeof document === 'undefined'
    ? null
    : document.documentElement.style
): void {
  paintRuntimeStyles(settings, target);
}

/**
 * Preview type on the document without treating the draft as saved.
 *
 * Theme already paints on the switch. Font colour, family and size have to do
 * the same or Appearance looks like it only restyles one sample label.
 */
export function previewRuntimeTypography(
  settings: RuntimeSettings,
  target: Pick<CSSStyleDeclaration, 'setProperty'> | null = typeof document === 'undefined'
    ? null
    : document.documentElement.style
): void {
  writeVariables(runtimeTypographyCssVariables(settings), target);
  applyColorScheme(settings.colorScheme);
}

/**
 * Put one saved Appearance result on every answer surface immediately.
 *
 * The request cache used to keep the pre-save settings for the lifetime of the
 * tab, so saving a new date or tag colour appeared to do nothing until reload.
 * Adopting the server's parsed response makes both the document and every later
 * mount agree on the value that actually landed — including Architecture's
 * loop tiles, which read the same remembered row.
 */
export function adoptRuntimeEntityStyles(
  settings: RuntimeSettings,
  target: Pick<CSSStyleDeclaration, 'setProperty'> | null = typeof document === 'undefined'
    ? null
    : document.documentElement.style
): void {
  paintRuntimeStyles(settings, target);
  cacheRuntimeAppearance(settings);
  rememberLiveRuntimeSettings(settings);
}

/** Apply the saved shared entity tokens once for every answer surface. */
export function useRuntimeEntityStyles(): void {
  useEffect(() => {
    let live = true;
    const paint = () => {
      const settings = recalledLiveRuntimeSettings();
      if (!live || !settings) return;
      paintRuntimeStyles(settings, typeof document === 'undefined' ? null : document.documentElement.style);
    };
    const stop = subscribeLiveRuntimeSettings(paint);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== RUNTIME_APPEARANCE_CACHE_KEY) return;
      const settings = runtimeAppearanceFromCache(event.newValue);
      if (!settings) return;
      paintRuntimeStyles(settings, typeof document === 'undefined' ? null : document.documentElement.style);
      rememberLiveRuntimeSettings(settings);
    };
    window.addEventListener('storage', onStorage);
    void loadLiveRuntimeSettings().then((settings) => {
      if (settings) cacheRuntimeAppearance(settings);
      paint();
    });
    return () => {
      live = false;
      stop();
      window.removeEventListener('storage', onStorage);
    };
  }, []);
}
