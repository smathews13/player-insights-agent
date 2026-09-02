export const IDENTITY_SETTINGS_CHANGED_EVENT = 'astrolabe:identity-settings-changed';
const STORAGE_KEY = 'astrolabe.identity-settings.revision';

export function notifyIdentitySettingsChanged(target: Window = window): void {
  target.dispatchEvent(new Event(IDENTITY_SETTINGS_CHANGED_EVENT));
  try {
    target.localStorage.setItem(STORAGE_KEY, `${Date.now()}`);
  } catch {
    // The in-page event still invalidates this app when storage is unavailable.
  }
}

export function listenForIdentitySettingsChanges(listener: () => void, target: Window = window): () => void {
  const onIdentity = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  target.addEventListener(IDENTITY_SETTINGS_CHANGED_EVENT, onIdentity);
  target.addEventListener('storage', onStorage);
  return () => {
    target.removeEventListener(IDENTITY_SETTINGS_CHANGED_EVENT, onIdentity);
    target.removeEventListener('storage', onStorage);
  };
}
