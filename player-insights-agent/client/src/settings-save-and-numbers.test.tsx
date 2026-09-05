/**
 * The two Runtime defects Sam reported once the modal opened.
 *
 * 1. The numeric fields forced a leading zero. Clearing one set it to zero
 *    (`Number('') === 0`), and react-dom's LOOSE comparison for a number input
 *    (`'0180' != 180` is false) meant no re-render could ever take the padding
 *    off again.
 * 2. Save looked dead. Its outcome was drawn at the end of a form about a
 *    thousand pixels tall inside a pane that scrolls, so every "Saved" and every
 *    error landed below the fold while the button stayed still.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { wholeNumberFrom } from './runtime-number';
import {
  SETTINGS_SAVE_IDLE,
  SETTINGS_UNREADABLE,
  changedSettingKeys,
  saveButtonLabel,
  saveInFlight,
  saveNotice,
  saveRetryAfterLoad,
} from './settings-save-state';

const PANEL = readFileSync(new URL('RuntimeSettingsPanel.tsx', import.meta.url), 'utf8');
const BENCHMARK = readFileSync(new URL('BenchmarkSettingsPanel.tsx', import.meta.url), 'utf8');

describe('Runtime numeric fields', () => {
  it('keeps the last good value when the box is emptied, rather than snapping to zero', () => {
    // The defect: `Number('')` is 0, so clearing "Run budget" to retype it made
    // the value 0 and drew a "0" the next digits landed after.
    expect(wholeNumberFrom('', 30, 200, 150)).toBe(150);
    expect(wholeNumberFrom('   ', 1, 20, 8)).toBe(8);
  });

  it('reads a padded entry as the number it looks like', () => {
    expect(wholeNumberFrom('0200', 30, 200, 150)).toBe(200);
    expect(wholeNumberFrom('010', 1, 20, 8)).toBe(10);
    expect(wholeNumberFrom('200', 30, 200, 150)).toBe(200);
  });

  it('holds the value inside the range the server enforces', () => {
    // The schema is min(30).max(200) for the run budget and min(1).max(20) for
    // steps, so an unclamped 0 was a 400 the reader could not see.
    expect(wholeNumberFrom('0', 30, 200, 150)).toBe(30);
    expect(wholeNumberFrom('9999', 30, 200, 150)).toBe(200);
    expect(wholeNumberFrom('0', 1, 20, 8)).toBe(1);
    expect(wholeNumberFrom('25', 1, 20, 8)).toBe(20);
  });

  it('ignores anything that is not a digit', () => {
    expect(wholeNumberFrom('1e5', 1, 20, 8)).toBe(15);
    expect(wholeNumberFrom('abc', 1, 20, 8)).toBe(8);
    expect(wholeNumberFrom('-5', 1, 20, 8)).toBe(5);
  });

  it('stops using a number input, which is what made the padding permanent', () => {
    // react-dom compares a number input's DOM value with the prop using loose
    // equality, so '0180' and 180 are treated as equal and the box is left
    // alone. A text input with a numeric keypad compares strictly.
    expect(PANEL).not.toContain('type="number"');
    expect(PANEL).toContain('inputMode="numeric"');
    // And the arithmetic that turned an empty box into zero is gone.
    expect(PANEL).not.toContain('Number(event.target.value)');
  });
});

describe('Save feedback', () => {
  it('says what it is doing on the button', () => {
    expect(saveButtonLabel(SETTINGS_SAVE_IDLE)).toBe('Save');
    expect(saveButtonLabel({ kind: 'saving' })).toBe('Saving...');
    expect(saveInFlight({ kind: 'saving' })).toBe(true);
    expect(saveInFlight(SETTINGS_SAVE_IDLE)).toBe(false);
  });

  it('confirms a success and surfaces the refusal the server sent', () => {
    expect(saveNotice(SETTINGS_SAVE_IDLE)).toBeNull();
    expect(saveNotice({ kind: 'saving' })).toBeNull();
    expect(saveNotice({ kind: 'saved', count: 3 })).toEqual({
      tone: 'ok',
      text: '3 changes saved',
    });
    expect(saveNotice({ kind: 'saved', count: 1 })?.text).toBe('1 change saved');
    expect(saveNotice({ kind: 'failed', message: 'The endpoint answered 503.' })).toEqual({
      tone: 'error',
      text: 'The endpoint answered 503.',
    });
  });

  it('reports its progress up to the footer instead of only to itself', () => {
    expect(PANEL).toContain('onSaveState');
    expect(PANEL).toContain("onSaveState({ kind: 'saving' })");
    expect(PANEL).toContain("onSaveState({ kind: 'saved', count: changed })");
    expect(PANEL).toContain("onSaveState({ kind: 'failed'");
  });

  it('counts changed setting keys once and removes reverted values', () => {
    const saved = { forecasting: false, loop: { maxSteps: 10, maxToolCalls: 15 }, judges: ['a'] };
    expect(
      changedSettingKeys(saved, {
        forecasting: true,
        loop: { maxSteps: 12, maxToolCalls: 15 },
        judges: ['a', 'b'],
      })
    ).toEqual(['forecasting', 'loop.maxSteps', 'judges']);
    expect(changedSettingKeys(saved, { ...saved, forecasting: false })).toEqual([]);
  });

  it('uses the reload result after Save retries a failed load, not the stale failure', () => {
    // The defect: Save awaited load(), then read `failure`/`state` captured when
    // the click started. A successful retry still said there was nothing to save.
    expect(saveRetryAfterLoad({ ok: true })).toEqual(SETTINGS_SAVE_IDLE);
    expect(saveNotice(saveRetryAfterLoad({ ok: true }))).toBeNull();
    expect(saveRetryAfterLoad({ ok: false, message: 'The endpoint answered 503.' })).toEqual({
      kind: 'failed',
      message: 'The endpoint answered 503.',
    });
    expect(saveRetryAfterLoad({ ok: false, message: '  ' })).toEqual({
      kind: 'failed',
      message: SETTINGS_UNREADABLE,
    });
    for (const source of [PANEL, BENCHMARK]) {
      expect(source).toContain('const result = await load()');
      expect(source).toContain('onSaveState(saveRetryAfterLoad(result))');
      expect(source).not.toContain("state === 'failed'");
    }
  });

  it('draws the button in the footer, which does not scroll', () => {
    const markup = renderToStaticMarkup(<SettingsPage initialSection="runtime" />);
    expect(markup).toContain('settings-modal-footer');
    expect(markup).toContain('class="sr-only">Save</span>');
    // Idle, so no outcome is claimed before anything has been pressed.
    expect(markup).not.toContain('settings-save-notice');
    expect(markup).not.toContain('Saved. The next ask uses these settings.');
  });
});
