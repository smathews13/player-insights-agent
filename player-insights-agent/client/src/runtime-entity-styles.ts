import { useEffect } from 'react';
import {
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

function writeVariables(
  variables: Record<string, string>,
  target: Pick<CSSStyleDeclaration, 'setProperty'> | null
): void {
  if (!target) return;
  for (const [name, value] of Object.entries(variables)) {
    target.setProperty(name, value);
  }
}

function paintRuntimeStyles(settings: RuntimeSettings, target: Pick<CSSStyleDeclaration, 'setProperty'> | null): void {
  writeVariables(runtimeAppearanceCssVariables(settings), target);
  applyColorScheme(settings.colorScheme);
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
    void loadLiveRuntimeSettings().then(paint);
    return () => {
      live = false;
      stop();
    };
  }, []);
}
