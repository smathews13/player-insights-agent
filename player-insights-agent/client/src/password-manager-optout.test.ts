import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input, Textarea } from './ui';
import { PASSWORD_MANAGER_OPT_OUT, withPasswordManagerOptOut } from './password-manager-optout';
import type { PasswordManagerOptOutProps } from './password-manager-optout';

/** What the primitives pass the helper: a field's own props, plus the flag. */
type FieldProps = ComponentProps<'input'> & PasswordManagerOptOutProps;

/**
 * A customer hit this in POC testing: 1Password read the composer question box
 * as an identity field, so it injected its glyph into the box and put a "Save
 * identity" prompt over the header after every question the user asked.
 *
 * These assertions name each vendor attribute literally rather than comparing
 * against the exported object, so that dropping one fails here instead of
 * quietly agreeing with itself. The rendering cases go through the shared
 * primitives, because a refactor that unwraps them is the specific regression
 * worth catching: the popup returns silently, and nobody sees it until the
 * next demo.
 *
 * Rendered to static markup rather than to a DOM: this repo has no jsdom, and
 * attributes are all that is under test. Whether the popup is actually gone
 * needs a human with 1Password installed.
 */

/** Rendered attribute names, as they appear in HTML rather than in JSX. */
const RENDERED = [
  'autocomplete="off"',
  'data-1p-ignore', // 1Password
  'data-lpignore="true"', // LastPass
  'data-form-type="other"', // Dashlane
  'data-bwignore="true"', // Bitwarden
];

/**
 * React's static renderer writes `autoComplete` with the casing of the prop it
 * was given. Attribute names are case-insensitive to an HTML parser, and on the
 * client React goes through `setAttribute`, which lowercases them, so a browser
 * sees `autocomplete` either way. Lower-cased here so this test is about the
 * attributes rather than about that.
 */
function html(element: ReactElement): string {
  return renderToStaticMarkup(element).toLowerCase();
}

describe('the attributes that keep password managers off this app', () => {
  it('names the attribute each vendor actually reads', () => {
    expect(PASSWORD_MANAGER_OPT_OUT.autoComplete).toBe('off');
    expect(PASSWORD_MANAGER_OPT_OUT['data-1p-ignore']).toBe('');
    expect(PASSWORD_MANAGER_OPT_OUT['data-lpignore']).toBe('true');
    expect(PASSWORD_MANAGER_OPT_OUT['data-form-type']).toBe('other');
    expect(PASSWORD_MANAGER_OPT_OUT['data-bwignore']).toBe('true');
  });

  it('applies them to props that do not ask for anything else', () => {
    const field: FieldProps = { name: 'question' };
    expect(withPasswordManagerOptOut(field)).toMatchObject({
      name: 'question',
      autoComplete: 'off',
      'data-1p-ignore': '',
    });
  });

  it('lets a caller override one attribute without losing the others', () => {
    const field: FieldProps = { autoComplete: 'one-time-code' };
    const merged = withPasswordManagerOptOut(field);
    expect(merged.autoComplete).toBe('one-time-code');
    expect(merged).toMatchObject({ 'data-lpignore': 'true', 'data-form-type': 'other' });
  });
});

describe('the shared field primitives', () => {
  it('opts the question box out of every manager, without being asked to', () => {
    const markup = html(createElement(Textarea, { rows: 2 }));
    for (const attribute of RENDERED) expect(markup).toContain(attribute);
  });

  it('opts single-line inputs out too, so the next field added is covered', () => {
    const markup = html(createElement(Input, { type: 'text' }));
    for (const attribute of RENDERED) expect(markup).toContain(attribute);
  });

  it('still renders what it was given', () => {
    const markup = html(createElement(Textarea, { placeholder: 'Ask about player behavior', rows: 2 }));
    expect(markup).toContain('placeholder="ask about player behavior"');
    expect(markup).toContain('rows="2"');
  });
});

describe('the escape hatch, for a credential field this app does not have yet', () => {
  it('drops the opt-out when a field genuinely wants a password manager', () => {
    const markup = html(createElement(Input, { type: 'password', allowPasswordManager: true }));
    for (const attribute of RENDERED) expect(markup).not.toContain(attribute);
  });

  it('keeps its own prop out of the DOM', () => {
    expect(html(createElement(Textarea, { allowPasswordManager: true }))).not.toContain('allowpasswordmanager');
  });

  it('is off unless it is asked for, including when it is asked for falsely', () => {
    const markup = html(createElement(Input, { allowPasswordManager: false }));
    for (const attribute of RENDERED) expect(markup).toContain(attribute);
  });
});

/**
 * The composer is a real `<form>` with an `onSubmit`, and submitting is what
 * prompts a manager to offer to save. The field opt-out alone did not cover
 * that, so the form carries the same attributes, which is a call site, and so
 * is asserted against the source rather than through a render.
 */
describe('the composer form', () => {
  const APP_SOURCE = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

  it('spreads the shared opt-out onto the form, not a hand-copied list', () => {
    expect(APP_SOURCE).toContain('{...PASSWORD_MANAGER_OPT_OUT}');
  });

  /**
   * Return submits and Shift+Return inserts a newline, wired by hand because a
   * textarea does not submit its form implicitly. That was itself a
   * customer-reported fix; submit-on-enter.test.ts covers the decision, and
   * this covers the composer still calling it.
   */
  it('leaves Return-to-send wired to the textarea', () => {
    expect(APP_SOURCE).toContain('if (!submitsOnEnter(event)) return;');
  });
});
