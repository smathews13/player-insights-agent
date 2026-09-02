import { describe, expect, it, vi } from 'vitest';

import {
  IDENTITY_SETTINGS_CHANGED_EVENT,
  listenForIdentitySettingsChanges,
  notifyIdentitySettingsChanged,
} from './identity-settings-events';

function fakeWindow(): { target: Window; setItem: ReturnType<typeof vi.fn> } {
  const target = new EventTarget();
  const setItem = vi.fn();
  Object.assign(target, { localStorage: { setItem } });
  return { target: target as Window, setItem };
}

describe('Identity settings cache invalidation', () => {
  it('invalidates this page immediately and publishes a cross-tab revision', () => {
    const { target, setItem } = fakeWindow();
    const listener = vi.fn();
    const stop = listenForIdentitySettingsChanges(listener, target);
    notifyIdentitySettingsChanged(target);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith('astrolabe.identity-settings.revision', expect.any(String));
    stop();
    target.dispatchEvent(new Event(IDENTITY_SETTINGS_CHANGED_EVENT));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
