/**
 * Whether Ask's two side rails start collapsed, remembered per browser.
 *
 * Both the conversation history (left) and the agent-path inspector (right)
 * open COLLAPSED by default, so the answer column is the widest thing on the
 * page on first open. A reader who opens one keeps it open across reloads and
 * navigations within this browser; that choice is all this module stores.
 *
 * localStorage and not session: the preference is "how I like Ask laid out",
 * which outlives a tab. Every access is guarded because a sandboxed iframe
 * throws on merely touching `window.localStorage`, and the safe direction is
 * the default (collapsed) rather than a thrown render.
 */
export type AskPane = 'rail' | 'inspector';

/** Namespaced so the two keys are recognisable in a devtools panel. */
const KEYS: Record<AskPane, string> = {
  rail: 'pia.ask.rail-collapsed',
  inspector: 'pia.ask.inspector-collapsed',
};

function store(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Collapsed unless the reader has explicitly expanded this pane before.
 *
 * Only the exact recorded `'false'` opens the pane; anything else — unset,
 * junk, or `'true'` — keeps the default-collapsed layout.
 */
export function paneStartsCollapsed(pane: AskPane): boolean {
  const s = store();
  if (!s) return true;
  try {
    return s.getItem(KEYS[pane]) !== 'false';
  } catch {
    return true;
  }
}

/** Record the reader's choice for this pane. Best effort against a store that can throw. */
export function rememberPaneCollapsed(pane: AskPane, collapsed: boolean): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(KEYS[pane], collapsed ? 'true' : 'false');
  } catch {
    // Deliberately nothing. The in-memory React state still reflects the choice
    // for this session; a browser that refuses storage simply re-collapses on
    // the next load.
  }
}
