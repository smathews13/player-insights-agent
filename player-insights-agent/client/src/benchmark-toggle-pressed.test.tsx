/**
 * The Benchmark Lab switch in the state it was reported in: pressed.
 *
 * REPORTED TWICE AS "STILL NOT FIXED" AFTER THREE FIXES, and benchmark-toggle.test.ts
 * says plainly why it could be: it reads settings.css as text and reasons about
 * the arithmetic in it, and it says so in its own header -- "nothing below
 * presses the switch". That leaves one join unchecked, and it is the join every
 * one of those rules depends on. The switch is a library control. Its geometry
 * is written here as three selectors keyed on `data-slot`, `data-state` and an
 * ancestor class, none of which this repository owns. If AppKit renames a slot,
 * or Radix stops writing `data-state` on the root, or the page wrapper loses
 * `settings-page`, then all of that arithmetic is correct and applies to
 * nothing: the knob reverts to the library's own 16px inside a 14px box and the
 * control looks exactly as reported, while every assertion about the stylesheet
 * stays green. That is the shape of a fault that survives three fixes.
 *
 * So this file renders the real control from the real page, in both states, and
 * asks whether the rules match what came out. It still runs in node with no
 * browser: what it cannot do is say the result is handsome. What it can do, and
 * what the file beside it cannot, is fail when the stylesheet stops being about
 * the control.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { SettingsPage } from './SettingsPage';
import { partial } from './styles/stylesheet';

const SETTINGS = partial('settings.css');

/**
 * The page as an administrator meets it, with the egress switch in one state.
 *
 * Egress is the switch this file drives, and Benchmarking is held off in the
 * context beside it so the two rows are told apart by name rather than by
 * position on the card. The role is in the context because the page reads
 * it, not because anything below asks about it: the settings page decides
 * whether to draw the roster from `useRole()`, which is the outlet's own
 * `role`, so a context without one makes the page throw before a switch is
 * rendered. Admin rather than super admin keeps the roster out and this file
 * about the control it is named for.
 */
function settingsMarkup(egressControls: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features: { benchmarkLab: false, egressControls, spIdentities: false },
                setFeature: () => {},
                role: { state: 'admin', addedAdminsReadable: true },
              }}
            />
          }
        >
          <Route
            path="/settings"
            element={
              <SettingsPage
                initialSection="experimental"
                features={{ benchmarkLab: false, egressControls, spIdentities: false }}
                setFeature={() => {}}
                role={{ state: 'admin', addedAdminsReadable: true }}
              />
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

interface Element {
  attributes: Map<string, string>;
  ancestors: Element[];
}

/** The last index satisfying a predicate, which the project's lib target lacks. */
function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let at = items.length - 1; at >= 0; at -= 1) if (predicate(items[at])) return at;
  return -1;
}

/** HTML's void elements, and only those: the page's icons are SVG and nest. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * Every element in a fragment of static markup, each carrying its own ancestors.
 *
 * A tag scanner rather than a parser: the markup is one render of one page, it
 * is well-formed by construction, and the only question asked of it below is
 * which elements enclose which.
 *
 * The stack is popped by NAME rather than by one step per closing tag, which is
 * not fussiness. The first draft treated `path` as void, the icons in the cards
 * close theirs, and each stray pop lifted a whole card out of the tree -- so the
 * switch came back with no `.settings-page` above it and this file reported the
 * page as broken. A parse bug that reads as a product bug is worth the four
 * extra lines.
 */
function elements(markup: string): Element[] {
  const open: { tag: string; element: Element }[] = [];
  const all: Element[] = [];
  for (const match of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, closing, rawTag, rawAttributes, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = lastIndexWhere(open, (entry) => entry.tag === tag);
      if (at !== -1) open.length = at;
      continue;
    }
    const attributes = new Map(
      [...rawAttributes.matchAll(/([\w:-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]])
    );
    const element: Element = { attributes, ancestors: open.map((entry) => entry.element) };
    all.push(element);
    if (!selfClosing && !VOID.has(tag)) open.push({ tag, element });
  }
  return all;
}

/** Whether one element satisfies one compound selector -- classes and attributes. */
function satisfies(element: Element, compound: string): boolean {
  const classes = (element.attributes.get('class') ?? '').split(/\s+/);
  for (const name of compound.matchAll(/\.([\w-]+)/g)) {
    if (!classes.includes(name[1])) return false;
  }
  for (const attribute of compound.matchAll(/\[([\w-]+)='([^']*)'\]/g)) {
    if (element.attributes.get(attribute[1]) !== attribute[2]) return false;
  }
  return true;
}

/**
 * Whether a descendant selector matches any element in the markup.
 *
 * Descendant combinators only, which is all three of the rules in question. Read
 * right to left: the subject first, then each ancestor step against whatever is
 * still above the last one matched.
 */
function matched(markup: string, selector: string): boolean {
  const steps = selector.trim().split(/\s+/).reverse();
  return elements(markup).some((element) => {
    if (!satisfies(element, steps[0])) return false;
    let above = [...element.ancestors];
    for (const step of steps.slice(1)) {
      const at = lastIndexWhere(above, (ancestor) => satisfies(ancestor, step));
      if (at === -1) return false;
      above = above.slice(0, at);
    }
    return true;
  });
}

/** Every selector settings.css writes for the switch, as declared. */
function switchSelectors(): string[] {
  return [...SETTINGS.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .map((rule) => rule[1].trim())
    .filter((selector) => selector.includes("data-slot='switch"));
}

const PRESSED = settingsMarkup(true);
const RESTING = settingsMarkup(false);

/** The switch's knob, in one rendered state. */
function thumb(markup: string): Element {
  const found = elements(markup).find((element) => element.attributes.get('data-slot') === 'switch-thumb');
  expect(found, 'the page renders a switch thumb').toBeDefined();
  return found as Element;
}

/**
 * The egress switch specifically, by its accessible name.
 *
 * The page carries more than one switch now: the runtime-settings card sits
 * above the experimental card and draws a toggle per answer section, each of
 * which defaults to on. So "the first switch" and "any checked switch" no
 * longer name the control this stylesheet is written for. This picks it out by
 * the accessible name the experimental card gives it, which is stable and is
 * the thing a reader would use to find it too.
 */
function egressSwitch(markup: string): Element {
  const found = elements(markup).find(
    (element) =>
      element.attributes.get('data-slot') === 'switch' &&
      element.attributes.get('aria-label') === 'Show the egress controls on this page'
  );
  expect(found, 'the page renders the egress switch').toBeDefined();
  return found as Element;
}

describe('the switch this stylesheet is written for is the one on the page', () => {
  it('matches every rule settings.css writes for it, in the state it writes it for', () => {
    // THE ASSERTION THE OTHER FILE CANNOT MAKE. Each of those rules is keyed on
    // three things this repository does not own -- AppKit's `data-slot`, Radix's
    // `data-state`, and the page's own wrapper class -- and any one of them
    // moving turns a correct rule into a rule about nothing. The knob then
    // reverts to the library's 16px in a 14px box, which is the reported
    // control, with the arithmetic beside it still passing.
    const selectors = switchSelectors();
    expect(selectors.length, 'settings.css styles the switch').toBeGreaterThanOrEqual(3);
    for (const selector of selectors) {
      expect(matched(PRESSED, selector) || matched(RESTING, selector), `${selector} matches the rendered control`).toBe(
        true
      );
    }
  });

  it('reaches the checked rule only when the control says it is checked', () => {
    // The two halves of the same claim: the offset applies when pressed, and it
    // does not apply when it is not. `data-state` is exactly what the checked
    // selector keys on, so the egress switch carrying 'checked' when pressed and
    // 'unchecked' when resting is the claim, scoped to this one control -- the
    // runtime toggles above it default to on and are not what this rule is for.
    expect(egressSwitch(PRESSED).attributes.get('data-state')).toBe('checked');
    expect(egressSwitch(RESTING).attributes.get('data-state')).toBe('unchecked');
  });

  it('says it is pressed in the attribute the stylesheet reads and the one a reader is told', () => {
    // `data-state` is what the CSS keys on and `aria-checked` is what a screen
    // reader is told, and they are written by different code paths. A control
    // that painted as on while announcing itself as off would be a worse fault
    // than the one reported, and nothing else in this repository looks at both.
    const track = egressSwitch(PRESSED);
    expect(track.attributes.get('data-state')).toBe('checked');
    expect(track.attributes.get('aria-checked')).toBe('true');
    expect(track.attributes.get('role')).toBe('switch');
    const resting = egressSwitch(RESTING);
    expect(resting.attributes.get('data-state')).toBe('unchecked');
    expect(resting.attributes.get('aria-checked')).toBe('false');
  });

  it('still has a knob to see against the blue the pressed track takes', () => {
    // The photograph attached to the third report was a blue pill with nothing
    // in it. Two things have to hold for that not to be what is on screen: the
    // track takes a fill when checked, and the knob carries one of its own. The
    // knob is white on a card that is also white, so it is only ever visible
    // against the track -- which is exactly why losing it looked like a smear
    // rather than like a missing element.
    const track = elements(PRESSED).find((element) => element.attributes.get('data-slot') === 'switch');
    expect(track?.attributes.get('class')).toMatch(/data-\[state=checked\]:bg-\S+/);
    expect(thumb(PRESSED).attributes.get('class')).toMatch(/(?:^|\s)bg-\S+/);
  });

  it('overrides every upstream utility that sizes or moves the knob', () => {
    // The library's own geometry, read off the control rather than out of a
    // changelog. `size-4` is a 16px knob and the track's inner box is 14px, so
    // an override that stopped applying would overflow it above and below --
    // "mis-shapen while held down", which is how the second report put it. The
    // offset utilities are the third report: `translate` and `transform` are
    // separate properties that both apply, so each has to be pinned rather than
    // replaced. This reads which properties are upstream and insists the
    // stylesheet names them; benchmark-toggle.test.ts checks what it names them.
    const utilities = (thumb(PRESSED).attributes.get('class') ?? '').split(/\s+/);
    const pinned = SETTINGS.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const properties = new Set<string>();
    for (const utility of utilities) {
      if (/(?:^|:)size-\d/.test(utility)) properties.add('width').add('height');
      if (/(?:^|:)translate-/.test(utility)) properties.add('translate').add('transform');
    }
    expect(properties.size, 'the library sizes and moves the knob').toBeGreaterThan(0);
    for (const property of properties) {
      expect(pinned, `settings.css pins ${property}`).toMatch(new RegExp(`(?:^|[;{\\s])${property}:`));
    }
  });

  it('keeps the scope every one of those rules hangs off', () => {
    // `.settings-page` is the ancestor step in all three selectors, and it is a
    // class on one div in one file. The rules were scoped rather than written
    // against `[data-slot='switch']` on purpose -- the control is shared and
    // three other screens would move with it -- so the scope is load-bearing
    // and its loss is silent everywhere except on screen.
    expect(thumb(PRESSED).ancestors.some((ancestor) => satisfies(ancestor, '.settings-page'))).toBe(true);
    const source = readFileSync(new URL('SettingsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('settings-page');
  });
});
