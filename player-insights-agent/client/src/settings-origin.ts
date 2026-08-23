/**
 * Where closing Settings puts the reader.
 *
 * `/settings` is a route as well as a modal, so closing it is a navigation, and
 * the destination is not always Ask. A page that links INTO settings -- the
 * Architecture tab links each Optional badge on the answer contract to the
 * switches that set it -- sends the path it was on in the link's router state,
 * and the reader lands back on it. Everybody else, including a reader who typed
 * the address, gets Ask.
 *
 * A FUNCTION RATHER THAN A TERNARY IN THE LAYOUT, for the reason the gate's own
 * outcome is one: there is no browser in this repository's test environment, so a
 * decision made inline in a component can only be asserted by mounting it and
 * driving a navigation. As a function it is a truth table.
 *
 * IT ONLY EVER RETURNS AN IN-APP PATH. Router state is written by this app, so a
 * hostile value is not the threat being modelled here; a wrong one is. `//host`
 * and `https://host` are both things `navigate` would treat as somewhere else
 * entirely, and a single leading slash is the whole of what an in-app path looks
 * like. Anything else is not a page of this app and falls back to Ask.
 */
export const SETTINGS_FALLBACK_ORIGIN = '/';

export function settingsOriginPath(state: unknown): string {
  if (!state || typeof state !== 'object') return SETTINGS_FALLBACK_ORIGIN;
  const from = (state as { settingsFrom?: unknown }).settingsFrom;
  if (typeof from !== 'string') return SETTINGS_FALLBACK_ORIGIN;
  if (!from.startsWith('/') || from.startsWith('//')) return SETTINGS_FALLBACK_ORIGIN;
  // Settings is not a page to be returned to, and a link that says it is would
  // leave the modal on screen with nothing behind it to close back to.
  if (from === '/settings') return SETTINGS_FALLBACK_ORIGIN;
  return from;
}
