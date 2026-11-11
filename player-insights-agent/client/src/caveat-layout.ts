/**
 * The "Above charts" answer setting, read from the live settings row.
 *
 * Listens only: `useRuntimeEntityStyles` at the app root does the load, so an
 * answer card never issues its own settings request. Until the row arrives the
 * card uses the default, which is on.
 */
import { useEffect, useState } from 'react';

import type { CaveatOrder } from './caveat-priority';
import { recalledLiveRuntimeSettings, subscribeLiveRuntimeSettings } from './runtime-settings-live';

export function useCaveatsFirst(): boolean {
  const [, bump] = useState(0);
  useEffect(() => subscribeLiveRuntimeSettings(() => bump((count) => count + 1)), []);
  return recalledLiveRuntimeSettings()?.answer.caveatsFirst ?? true;
}

export function caveatOrder(caveatsFirst: boolean): CaveatOrder {
  return caveatsFirst ? 'received' : 'risk';
}
