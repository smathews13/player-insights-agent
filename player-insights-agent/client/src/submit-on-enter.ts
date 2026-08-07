/**
 * When a Return keypress in a text field means "send" rather than "newline".
 *
 * A `<textarea>` never submits its form implicitly (that behaviour is defined
 * for single-line inputs only), so the composer needs this even though it sits
 * in a `<form>` with a `type="submit"` button.
 */

/** The parts of a React or DOM keyboard event this decision reads. */
export interface EnterKeypress {
  key: string;
  shiftKey: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number } | null;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * `isComposing` is the specified signal; `keyCode === 229` is the older one that
 * some IMEs still report alone. Both are checked because a false negative here
 * is the bug this guard exists to prevent.
 */
export function isComposingKeypress(event: EnterKeypress): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229;
}

/** True only for a plain Return. Shift+Return is a newline and is left alone. */
export function submitsOnEnter(event: EnterKeypress): boolean {
  if (event.key !== 'Enter') return false;
  if (event.shiftKey) return false;
  return !isComposingKeypress(event);
}
