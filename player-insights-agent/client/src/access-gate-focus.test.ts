import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GATE_FOCUSABLE, gateKeyIntent, gateTabTarget } from './access-gate-state';

/**
 * The focus trap the gate declared and did not have.
 *
 * `aria-modal="true"` is a promise to a screen reader that the rest of the page is
 * inert. The gate has made that promise since it was written and did none of the
 * work behind it: no initial focus, no Tab containment, no Escape, no restore. A
 * modal that lies about this is worse than one that never claimed it, because the
 * reader is told the page behind is unavailable while Tab walks straight out into
 * it -- and this is the one surface in the app where that matters most, since it
 * renders above the router and a keyboard user meets it before anything else.
 *
 * The trap is split into three exported decisions and one effect, so the decisions
 * can be tested here: what a keypress means, where Tab should go, and what counts
 * as focusable. The remaining part -- that calling `.focus()` on those elements
 * actually moves focus -- is the browser's, and this repo has no jsdom to stand in
 * for one. The Playwright spec is where a real Tab press meets a real layout; what
 * a human still has to confirm by hand is recorded in the handover.
 */

const SOURCE = readFileSync(new URL('./AccessGate.tsx', import.meta.url), 'utf8');

/** The three buttons, as the panel's own order has them. */
const BUTTONS = ['verify', 'fallback', 'skip'] as const;

describe('what a keypress inside the gate means', () => {
  it('reads Escape as Escape and Tab as a direction', () => {
    expect(gateKeyIntent({ key: 'Escape', shiftKey: false })).toBe('escape');
    expect(gateKeyIntent({ key: 'Tab', shiftKey: false })).toBe('forward');
    expect(gateKeyIntent({ key: 'Tab', shiftKey: true })).toBe('backward');
  });

  it('ignores every other key, so the trap cannot swallow ordinary typing', () => {
    // The panel holds a `<details>` and three buttons today and may hold an input
    // tomorrow. A handler that returned a verdict for Enter or a letter would take
    // keys away from the controls inside it.
    for (const key of ['Enter', ' ', 'a', 'ArrowDown', 'Home', 'Shift']) {
      expect(gateKeyIntent({ key, shiftKey: false }), key).toBeNull();
    }
  });
});

describe('where Tab goes', () => {
  it('wraps forward off the end and backward off the front', () => {
    expect(gateTabTarget(BUTTONS, 'skip', 'forward')).toBe('verify');
    expect(gateTabTarget(BUTTONS, 'verify', 'backward')).toBe('skip');
  });

  it('leaves the middle of the list to the browser', () => {
    // Containment is only ever needed at the two ends. Taking over the whole cycle
    // would mean re-implementing focus order for anything the selector does not
    // know about, and getting it subtly wrong in the one dialog nobody can skip.
    expect(gateTabTarget(BUTTONS, 'verify', 'forward')).toBeNull();
    expect(gateTabTarget(BUTTONS, 'fallback', 'forward')).toBeNull();
    expect(gateTabTarget(BUTTONS, 'fallback', 'backward')).toBeNull();
    expect(gateTabTarget(BUTTONS, 'skip', 'backward')).toBeNull();
  });

  it('enters the list from the dialog itself, which is where focus starts', () => {
    // On mount focus is on the container, which is not one of the focusables. The
    // first Tab has to go into the panel; without this it would leave the dialog
    // on the very first keystroke, which is the defect this whole file is about.
    expect(gateTabTarget(BUTTONS, null, 'forward')).toBe('verify');
    expect(gateTabTarget(BUTTONS, null, 'backward')).toBe('skip');
  });

  it('does nothing when there is nothing to focus', () => {
    // Reachable in practice: all three buttons disable themselves while a check is
    // in flight, and a disabled button is not focusable. Focus stays where it is
    // rather than being thrown at the document.
    expect(gateTabTarget([], null, 'forward')).toBeNull();
    expect(gateTabTarget([], 'verify', 'backward')).toBeNull();
  });
});

describe('what the trap considers focusable', () => {
  it('counts the buttons and the raw-message disclosure', () => {
    expect(GATE_FOCUSABLE).toContain('button');
    // The collapsed "what the service actually returned" block is a <details>, and
    // its <summary> is a real control. Leaving it out would make the trap skip the
    // one thing on a failure screen that shows the platform's own words.
    expect(GATE_FOCUSABLE).toContain('summary');
  });

  it('excludes a disabled control and the container itself', () => {
    expect(GATE_FOCUSABLE).toContain('button:not([disabled])');
    // The dialog is `tabIndex={-1}`: a focus target on mount, never a Tab stop.
    expect(GATE_FOCUSABLE).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe('the effect around those decisions', () => {
  it('moves focus into the dialog when the gate is really on screen', () => {
    // Guarded on `shown`, which is computed before the early returns. Most sessions
    // never see this dialog, and a component that rendered nothing must not take
    // focus off whatever the reader was using.
    expect(SOURCE).toMatch(/if \(!shown\) return;/);
    expect(SOURCE).toMatch(/panel\.focus\(\)/);
  });

  it('restores focus to whatever had it, and only if that is still there', () => {
    expect(SOURCE).toMatch(/const restoreTo = document\.activeElement/);
    expect(SOURCE).toMatch(/restoreTo instanceof HTMLElement && restoreTo\.isConnected/);
  });

  it('declares the container a dialog that focus can reach but Tab cannot', () => {
    expect(SOURCE).toMatch(/role="dialog"/);
    expect(SOURCE).toMatch(/aria-modal="true"/);
    expect(SOURCE).toMatch(/tabIndex=\{-1\}/);
  });

  it('does not let Escape record a governance decision', () => {
    // Every way out of this screen is a recorded decision about whose authority
    // answers are taken under. A keystroke people press to mean "get me out of this
    // dialog" must not make one. Escape moves focus to Skip this and stops; the
    // reader presses it.
    const handler = SOURCE.match(/const onKeyDown = useCallback\(([\s\S]*?)\n {2}\}, \[\]\);/)?.[1] ?? '';
    expect(handler).not.toBe('');
    expect(handler).not.toMatch(/declare\(/);
    expect(handler).toMatch(/skip\.current\?\.focus\(\)/);
  });
});
