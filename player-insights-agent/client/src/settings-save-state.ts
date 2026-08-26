/**
 * What Save is doing, said where the reader is looking.
 *
 * THE OUTCOME USED TO BE DRAWN AT THE BOTTOM OF THE FORM. `.settings-modal-content`
 * scrolls and the Runtime form is about a thousand pixels tall, so "Saved. The
 * next ask uses these settings." and every save error rendered below the fold
 * while the footer holding the button stayed on screen. Pressing Save therefore
 * looked like it did nothing whether it had worked, been refused by the server,
 * or never fired at all -- three different events with one appearance, which is
 * exactly the report this module exists to answer.
 *
 * A state rather than a boolean because those three outcomes need three
 * sentences, and kept out of the components so the wording can be asserted
 * without a browser.
 */

export type SettingsSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'failed'; message: string };

export const SETTINGS_SAVE_IDLE: SettingsSaveState = { kind: 'idle' };

export const SETTINGS_UNREADABLE =
  'These settings could not be read, so there is nothing to save yet.';

/** What a settings pane load just did. Save-as-retry must read this value. */
export type SettingsLoadResult = { ok: true } | { ok: false; message: string };

/**
 * Footer state after Save has retried a failed load.
 *
 * MUST take the reload's own result. `failure` and `state` from when Save
 * started stay stale after `await load()`, so a successful retry used to keep
 * saying there was nothing to save.
 */
export function saveRetryAfterLoad(result: SettingsLoadResult): SettingsSaveState {
  if (result.ok) return SETTINGS_SAVE_IDLE;
  const message = result.message.trim();
  return { kind: 'failed', message: message || SETTINGS_UNREADABLE };
}

/**
 * How long Save holds its pressed paint, and how long the modal waits after a
 * save lands before it closes.
 *
 * ONE NUMBER BECAUSE IT IS ONE GESTURE. The press and the close are the whole of
 * the confirmation now: the "Saved." line used to be it, and it is gone from the
 * footer at Sam's request. If the modal closed on the same frame as the click,
 * there would be nothing at all to see -- the button would never visibly press,
 * because the element drawing the press would already have been unmounted.
 */
export const SAVE_PRESS_MS = 180;

/**
 * Whether a save has landed, which is when the modal may close.
 *
 * A REFUSAL IS DELIBERATELY NOT THIS. The only place a refusal is drawn is the
 * footer, so closing on `failed` would take the message off screen at the moment
 * it was written and report a refused save as a successful one.
 */
export function saveLanded(state: SettingsSaveState): boolean {
  return state.kind === 'saved';
}

/** The word on the button, so a click is visibly in progress. */
export function saveButtonLabel(state: SettingsSaveState): string {
  return state.kind === 'saving' ? 'Saving...' : 'Save';
}

/** Whether the button refuses a second click while the first is in flight. */
export function saveInFlight(state: SettingsSaveState): boolean {
  return state.kind === 'saving';
}

/**
 * The line beside the button, or null when there is nothing to say.
 *
 * `alert` for a refusal and `status` for a success, because one interrupts a
 * screen reader and the other should not.
 */
export function saveNotice(state: SettingsSaveState): { tone: 'ok' | 'error'; text: string } | null {
  if (state.kind === 'saved') return { tone: 'ok', text: 'Saved. The next ask uses these settings.' };
  if (state.kind === 'failed') return { tone: 'error', text: state.message };
  return null;
}
