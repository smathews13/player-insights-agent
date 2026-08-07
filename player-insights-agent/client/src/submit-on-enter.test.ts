import { describe, expect, it } from 'vitest';
import { isComposingKeypress, submitsOnEnter } from './submit-on-enter';

function keypress(overrides: Partial<Parameters<typeof submitsOnEnter>[0]> = {}) {
  return { key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, ...overrides };
}

describe('Return submits the composer, and the exceptions that must not', () => {
  it('submits on a plain Return', () => {
    expect(submitsOnEnter(keypress())).toBe(true);
  });

  it('does not submit on Shift+Return, which inserts a newline', () => {
    expect(submitsOnEnter(keypress({ shiftKey: true }))).toBe(false);
  });

  it('does not submit while an IME composition is active', () => {
    // Return here chooses a candidate. Submitting sends a half-typed word.
    expect(submitsOnEnter(keypress({ nativeEvent: { isComposing: true, keyCode: 229 } }))).toBe(false);
  });

  it('does not submit on the legacy 229 signal alone', () => {
    // Some IMEs report the keyCode without setting isComposing.
    expect(submitsOnEnter(keypress({ nativeEvent: { keyCode: 229 } }))).toBe(false);
  });

  it('reads composition off the event itself when there is no nativeEvent', () => {
    expect(isComposingKeypress({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(true);
    expect(submitsOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });

  it('treats a missing nativeEvent as not composing', () => {
    expect(submitsOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(submitsOnEnter({ key: 'Enter', shiftKey: false, nativeEvent: null })).toBe(true);
  });

  it.each(['a', 'Escape', 'Tab', 'NumpadEnter', ' '])('ignores %j', (key) => {
    expect(submitsOnEnter(keypress({ key }))).toBe(false);
  });
});
