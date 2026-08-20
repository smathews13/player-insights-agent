import { useEffect } from 'react';
import {
  RuntimeSettingsSchema,
  runtimeEntityCssVariables,
  type RuntimeSettings,
} from '../../shared/runtime-settings';

let settingsRequest: Promise<RuntimeSettings | null> | null = null;

async function readRuntimeEntityStyles(): Promise<RuntimeSettings | null> {
  const response = await fetch('/api/runtime-settings');
  if (!response.ok) return null;
  const payload = (await response.json()) as { settings?: unknown };
  const parsed = RuntimeSettingsSchema.safeParse(payload.settings);
  return parsed.success ? parsed.data : null;
}

/** Apply the saved shared entity tokens once for every answer surface. */
export function useRuntimeEntityStyles(): void {
  useEffect(() => {
    let live = true;
    settingsRequest ??= readRuntimeEntityStyles().catch(() => null);
    void settingsRequest.then((settings) => {
      if (!live || !settings) return;
      for (const [name, value] of Object.entries(runtimeEntityCssVariables(settings))) {
        document.documentElement.style.setProperty(name, value);
      }
    });
    return () => {
      live = false;
    };
  }, []);
}
