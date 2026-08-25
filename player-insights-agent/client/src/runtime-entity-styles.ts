import { useEffect } from 'react';
import { runtimeEntityCssVariables, type RuntimeSettings } from '../../shared/runtime-settings';
import { applyColorScheme } from './color-scheme';
import {
  loadLiveRuntimeSettings,
  recalledLiveRuntimeSettings,
  rememberLiveRuntimeSettings,
  subscribeLiveRuntimeSettings,
} from './runtime-settings-live';

function paintRuntimeEntityStyles(
  settings: RuntimeSettings,
  target: Pick<CSSStyleDeclaration, 'setProperty'> | null
): void {
  if (target) {
    for (const [name, value] of Object.entries(runtimeEntityCssVariables(settings))) {
      target.setProperty(name, value);
    }
  }
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
  paintRuntimeEntityStyles(settings, target);
  rememberLiveRuntimeSettings(settings);
}

/** Apply the saved shared entity tokens once for every answer surface. */
export function useRuntimeEntityStyles(): void {
  useEffect(() => {
    let live = true;
    const paint = () => {
      const settings = recalledLiveRuntimeSettings();
      if (!live || !settings) return;
      paintRuntimeEntityStyles(
        settings,
        typeof document === 'undefined' ? null : document.documentElement.style
      );
    };
    const stop = subscribeLiveRuntimeSettings(paint);
    void loadLiveRuntimeSettings().then(paint);
    return () => {
      live = false;
      stop();
    };
  }, []);
}
