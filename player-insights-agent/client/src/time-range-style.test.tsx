import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { TimeRangeControl } from './TimeRangeControl';
import { RANGE_SEGMENTS } from './time-range';
import { partial, stylesheet } from './styles/stylesheet';

/**
 * That the shared range control is actually styled.
 *
 * It shipped without a stylesheet. The component was correct: right markup,
 * right ARIA, right class names, and not one of those class names was defined
 * anywhere in the cascade. AppKit's preflight strips a button's border, padding
 * and background, so the four segments rendered as one word and the filter row
 * read "24h7 days30 daysCustom" on both Monitoring and Ops.
 *
 * Nothing caught it because every test asked whether the control rendered, and
 * it did. So these tests ask the question that was missing: is every class this
 * component puts in the DOM defined in the stylesheet the app actually ships?
 * That fails on a stylesheet that was never written, on a partial nobody
 * imported, and on a class name that drifted from its rule, which are three ways
 * of shipping the same unreadable row.
 *
 * PIXELS ARE NOT VERIFIED HERE. There is no browser and no layout engine. These
 * tests prove the rules exist and reach the class names; they cannot prove the
 * result looks right.
 */

/** Rules only, with comments stripped, so a class named in prose is not a hit. */
function rules(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const APP_CSS = rules(stylesheet());

const markup = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/monitoring?range=custom']}>
      <TimeRangeControl page="Monitoring" />
    </MemoryRouter>
  );

/** Every class the component puts in the DOM. */
function classesUsed(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) found.add(name);
  }
  return [...found];
}

describe('the shared range control reaches the stylesheet the app ships', () => {
  /**
   * The claim the missing partial would have failed. Read from `stylesheet()`,
   * which reassembles the partials in the order index.css imports them, so a
   * partial that exists and is not imported fails here as loudly as one that was
   * never written.
   */
  it('defines every class the control renders', () => {
    const undefinedClasses = classesUsed(markup()).filter((name) => !APP_CSS.includes(`.${name}`));

    expect(undefinedClasses).toEqual([]);
  });

  it('ships the partial through the import list rather than only on disk', () => {
    expect(APP_CSS).toContain('.time-range-segments');
    expect(APP_CSS).toContain('.time-range-segment');
  });
});

describe('the five labels are separated rather than run together', () => {
  const CSS = rules(partial('time-range.css'));

  /**
   * The rule that stops "24h7 days30 daysAll timeCustom". Horizontal padding on
   * the segment is what puts space between the labels, so it is asserted directly:
   * a segment with vertical padding only renders the same collision.
   *
   * This matters more with five segments than it did with four, and more for All
   * time than for any of the others: it is the only two-word label, so an unpadded
   * row would run it into both neighbours and into itself.
   */
  it('pads each segment horizontally', () => {
    const segment = /\.time-range-segment\s*\{([^}]*)\}/.exec(CSS);

    expect(segment).not.toBeNull();
    const padding = /padding:\s*([^;]+);/.exec(segment?.[1] ?? '');
    expect(padding).not.toBeNull();
    // "5px 10px" and "5px 10px 5px 10px" both carry a horizontal value; "5px"
    // alone does not, and neither does "5px 0".
    const parts = (padding?.[1] ?? '').trim().split(/\s+/);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[1]).not.toBe('0');
  });

  it('rules a line between neighbouring segments', () => {
    expect(CSS).toMatch(/\.time-range-segment\s*\+\s*\.time-range-segment\s*\{[^}]*border-left/);
  });

  /**
   * The active fill is selected on the ARIA attribute rather than on a second
   * class, so the painted state and the state a screen reader announces are one
   * attribute read twice and cannot disagree.
   */
  it('fills the active segment off the attribute it announces', () => {
    expect(CSS).toMatch(/\.time-range-segment\[aria-checked='true'\]\s*\{[^}]*background/);
  });

  it('puts an opaque tokenized surface behind inactive segments', () => {
    expect(CSS).toMatch(/\.time-range-segments\s*\{[^}]*background:\s*var\(--ast-surface-solid\)/);
    expect(CSS).toMatch(/\.time-range-segment\s*\{[^}]*background:\s*var\(--ast-surface-solid\)/);
  });

  it('leaves a focused segment a visible ring', () => {
    expect(CSS).toMatch(/\.time-range-segment:focus-visible\s*\{[^}]*outline/);
  });

  /** No hexes. The handoff's values are tokens, and a hex here is a fifth palette. */
  it('paints in tokens rather than in hexes', () => {
    expect(CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('the control offers the five ranges the design names', () => {
  /**
   * The order is asserted, not just the membership. All time sits after the three
   * fixed windows and before Custom so that the first four widen in one direction
   * and Custom is the escape from the sequence rather than a fifth step in it.
   */
  it('renders 24h, 7 days, 30 days, All time and Custom as five separate controls', () => {
    const html = markup();

    expect(RANGE_SEGMENTS.map((segment) => segment.label)).toEqual(['24h', '7 days', '30 days', 'All time', 'Custom']);
    for (const segment of RANGE_SEGMENTS) expect(html).toContain(`>${segment.label}<`);
    expect(html.match(/role="radio"/g)).toHaveLength(5);
  });
});
