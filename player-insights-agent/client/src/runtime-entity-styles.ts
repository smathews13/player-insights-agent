import { useEffect } from 'react';
import {
  RuntimeSettingsSchema,
  runtimeEntityCssVariables,
  type RuntimeSettings,
} from '../../shared/runtime-settings';
import { applyColorScheme } from './color-scheme';

let settingsRequest: Promise<RuntimeSettings | null> | null = null;

async function readRuntimeEntityStyles(): Promise<RuntimeSettings | null> {
  const response = await fetch('/api/runtime-settings');
  if (!response.ok) return null;
  const payload = (await response.json()) as { settings?: unknown };
  const parsed = RuntimeSettingsSchema.safeParse(payload.settings);
  return parsed.success ? parsed.data : null;
}

/**
 * Put one saved Appearance result on every answer surface immediately.
 *
 * The request cache used to keep the pre-save settings for the lifetime of the
 * tab, so saving a new date or tag colour appeared to do nothing until reload.
 * Adopting the server's parsed response makes both the document and every later
 * mount agree on the value that actually landed.
 */
export function adoptRuntimeEntityStyles(
  settings: RuntimeSettings,
  target: Pick<CSSStyleDeclaration, 'setProperty'> | null = typeof document === 'undefined'
    ? null
    : document.documentElement.style
): void {
  if (target) {
    for (const [name, value] of Object.entries(runtimeEntityCssVariables(settings))) {
      target.setProperty(name, value);
    }
  }
  applyColorScheme(settings.colorScheme);
  settingsRequest = Promise.resolve(settings);
}

/** Apply the saved shared entity tokens once for every answer surface. */
export function useRuntimeEntityStyles(): void {
  useEffect(() => {
    let live = true;
    settingsRequest ??= readRuntimeEntityStyles().catch(() => null);
    void settingsRequest.then((settings) => {
      if (!live || !settings) return;
      adoptRuntimeEntityStyles(settings);
    });
    return () => {
      live = false;
    };
  }, []);
}
