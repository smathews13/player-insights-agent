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
