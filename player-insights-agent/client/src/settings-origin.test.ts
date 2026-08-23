import { describe, expect, it } from 'vitest';

import { SETTINGS_FALLBACK_ORIGIN, settingsOriginPath } from './settings-origin';

/**
 * Where closing Settings puts the reader.
 *
 * WHAT THIS WAS WRITTEN AGAINST. Settings is a modal and a route at once, so
 * closing it navigates, and it navigated to Ask whatever brought the reader
 * there. That is correct for an address somebody typed and wrong for a link out
 * of a page: the Architecture tab now links each Optional badge on the answer
 * contract to the switches that set it, and closing the modal took the reader off
 * the diagram they were reading and onto a blank Ask tab.
 *
 * A truth table rather than a mounted navigation, because there is no browser in
 * this repository's test environment -- the same reason `gateOutcome` is a
 * function. Every branch below is a value the router can actually hand over:
 * router state is `unknown` at the type level and survives a reload, so a shape
 * this function has never seen is not hypothetical.
 */
describe('closing settings returns the reader to the page that sent them', () => {
  it('goes back to the page named in the link’s state', () => {
    expect(settingsOriginPath({ settingsFrom: '/architecture' })).toBe('/architecture');
  });

  it('keeps a query and a fragment, which are part of where the reader was', () => {
    // Architecture's rails are deep-linkable, so the badge that opened Settings
    // may have been on a page whose identity includes its query.
    expect(settingsOriginPath({ settingsFrom: '/monitoring?range=7d' })).toBe('/monitoring?range=7d');
  });

  it('goes to Ask when nothing sent the reader', () => {
    // The reader typed the address, or arrived from the gear, which sets no state.
    for (const state of [null, undefined, {}, 'architecture', 42, []]) {
      expect(settingsOriginPath(state), `state ${JSON.stringify(state) ?? 'undefined'}`).toBe(SETTINGS_FALLBACK_ORIGIN);
    }
  });

  it('refuses anything that is not one of this app’s own paths', () => {
    // `navigate` would treat all three as somewhere else entirely. A protocol-
    // relative `//host` is the one that looks like a path and is not.
    for (const from of ['https://example.com', '//example.com', 'architecture', '']) {
      expect(settingsOriginPath({ settingsFrom: from }), from || '(empty)').toBe(SETTINGS_FALLBACK_ORIGIN);
    }
  });

  it('never returns settings itself, which is not a page to close back to', () => {
    // Closing onto `/settings` would re-open the modal with nothing behind it.
    expect(settingsOriginPath({ settingsFrom: '/settings' })).toBe(SETTINGS_FALLBACK_ORIGIN);
  });
});
