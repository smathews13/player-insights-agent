/**
 * The mark is the delivered drawing, not a redrawing of it.
 *
 * `astrolabe-rebuild-spec.md` §1 and `assets/logo/README.md` both say "never
 * redraw, never restroke", and that instruction is worth nothing unless
 * something reads the delivered files. So this reads all four of them off disk
 * and compares every coordinate, radius, stroke width and dash pattern against
 * `astrolabe-mark.ts`. A well-meant rounding of 21.5 to 22, or a rim taken from
 * a screenshot rather than from the file, fails here.
 *
 * WHAT IS DELIBERATELY NOT COMPARED IS COLOUR AND OPACITY. The delivered pairs
 * differ in both -- `astrolabe-rete.svg` sets its web lines at 0.5 and
 * `-white.svg` at 0.45, because a hairline needs a little more presence on navy
 * -- and the whole reason the geometry lives in TypeScript is that the app needs
 * inks the two files do not carry (see the header of astrolabe-mark.ts). Colour
 * is the stylesheet's, and opacity is a property of the seating. Geometry is the
 * part that may not move, and geometry is what this file holds.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FLICKER_CYCLE_SECONDS,
  FLICKER_ORDER,
  FLICKER_REST,
  FLICKER_SIZES,
  GRADUATION_FLOOR,
  MARK_CONCEPTS,
  MARK_VIEWBOX,
  SMALL_CUT,
  flickerDelay,
  markElements,
  type MarkConcept,
  type MarkElement,
} from './astrolabe-mark';

function delivered(concept: MarkConcept): string {
  return readFileSync(new URL(`assets/logo/astrolabe-${concept}.svg`, import.meta.url), 'utf8');
}

/**
 * Every geometry attribute in a delivered file, in document order, as strings.
 *
 * Strings rather than numbers so that `21.5` and `21.50` are different -- the
 * point is that nobody retyped the file, and a retyped file is exactly where a
 * trailing zero comes from.
 */
function geometryOf(svg: string): string[] {
  const found: string[] = [];
  for (const [, tag, attrs] of svg.matchAll(/<(circle|rect|path)\b([^>]*)>/g)) {
    const attr = (name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    if (tag === 'circle') {
      found.push(`circle ${attr('cx')} ${attr('cy')} ${attr('r')} ${attr('stroke-width') ?? ''} ${attr('stroke-dasharray') ?? ''}`.trim());
    } else if (tag === 'rect') {
      found.push(`rect ${attr('x')} ${attr('y')} ${attr('width')} ${attr('height')} ${attr('rx')}`);
    } else {
      found.push(`path ${attr('d')} ${attr('stroke-width') ?? ''}`.trim());
    }
  }
  return found;
}

/** The same, from the module, flattening groups exactly as the file nests them. */
function geometryFrom(elements: readonly MarkElement[]): string[] {
  const found: string[] = [];
  // A group's children inherit its stroke in the delivered file exactly as they
  // inherit it in the module, so neither side states one and the comparison is
  // about what is written rather than about what is resolved.
  const visit = (element: MarkElement) => {
    if (element.kind === 'group') {
      for (const child of element.children) visit(child);
      return;
    }
    if (element.kind === 'circle') {
      found.push(
        `circle ${element.cx} ${element.cy} ${element.r} ${element.strokeWidth ?? ''} ${element.dash ?? ''}`.trim()
      );
    } else if (element.kind === 'rect') {
      found.push(`rect ${element.x} ${element.y} ${element.width} ${element.height} ${element.rx}`);
    } else {
      found.push(`path ${element.d} ${element.strokeWidth ?? ''}`.trim());
    }
  };
  for (const element of elements) visit(element);
  return found;
}

describe('the four concepts are the files in assets/logo, to the decimal', () => {
  for (const concept of ['dpad', 'rete', 'reticle', 'horizon'] as const) {
    it(`draws ${concept} exactly as astrolabe-${concept}.svg draws it`, () => {
      expect(geometryFrom(MARK_CONCEPTS[concept])).toEqual(geometryOf(delivered(concept)));
    });
  }

  it('keeps every concept on the one 64-unit grid the family is drawn on', () => {
    // A mark on a different grid is a mark that arrives a different size in a
    // slot sized for its sibling, which is what a stacked flicker slot is.
    for (const concept of ['dpad', 'rete', 'reticle', 'horizon'] as const) {
      expect(delivered(concept)).toContain(`viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}"`);
    }
  });

  it('names the d-pad as the identity mark and the other three as the flicker’s', () => {
    // §1: the d-pad is the mark; rete, reticle and horizon are archive and are
    // used "only by the flicker loaders and the opening sequence".
    expect(markElements(22)).toBe(SMALL_CUT);
    expect(FLICKER_ORDER).toContain('dpad');
    expect(FLICKER_ORDER.length).toBe(4);
  });
});

describe('the small cut, which is a drawing and not a shrink', () => {
  it('drops the graduation ring, which is what makes it legible small', () => {
    // The dashed ring is the second element of the full mark and the first thing
    // §1 takes off. Nothing in the small cut carries a dash.
    expect(SMALL_CUT.some((element) => element.kind === 'circle' && element.dash)).toBe(false);
    expect(MARK_CONCEPTS.dpad.some((element) => element.kind === 'circle' && element.dash)).toBe(true);
  });

  it('is what any seating below 32px gets, and the full mark what any above does', () => {
    // §1: "No graduation below 32px". The size decides, not the caller.
    expect(markElements(GRADUATION_FLOOR - 1)).toBe(SMALL_CUT);
    expect(markElements(GRADUATION_FLOOR)).toBe(MARK_CONCEPTS.dpad);
    expect(markElements(72)).toBe(MARK_CONCEPTS.dpad);
  });

  it('carries §1’s numbers: a bold rim, 9×34 rx4.5 cross, r5.5 centre, r3.5 dots', () => {
    const rim = SMALL_CUT[0];
    expect(rim).toMatchObject({ kind: 'circle', r: 27, strokeWidth: 6 });
    expect(SMALL_CUT).toContainEqual({ kind: 'rect', x: 27.5, y: 15, width: 9, height: 34, rx: 4.5, fill: 'ink' });
    expect(SMALL_CUT).toContainEqual({ kind: 'rect', x: 15, y: 27.5, width: 34, height: 9, rx: 4.5, fill: 'ink' });
    expect(SMALL_CUT).toContainEqual({ kind: 'circle', cx: 32, cy: 32, r: 5.5, fill: 'accent' });
    expect(SMALL_CUT.filter((element) => element.kind === 'circle' && element.r === 3.5)).toHaveLength(4);
  });

  it('still clears the grid with the thicker rim, so nothing is clipped', () => {
    // r27 plus half of a 6-wide stroke reaches 30 of the 32 available. A rim any
    // bolder would be cut off by the viewBox at every size at once.
    const rim = SMALL_CUT[0];
    if (rim.kind !== 'circle') throw new Error('the rim is the first element');
    expect(rim.r + (rim.strokeWidth ?? 0) / 2).toBeLessThanOrEqual(MARK_VIEWBOX / 2);
  });

  it('keeps the cross centred, so the mark does not lean in a chip', () => {
    for (const element of SMALL_CUT) {
      if (element.kind !== 'rect') continue;
      expect(element.x + element.width / 2).toBe(MARK_VIEWBOX / 2);
      expect(element.y + element.height / 2).toBe(MARK_VIEWBOX / 2);
    }
  });
});

describe('the concept flicker’s timing', () => {
  it('gives each concept a quarter of the 3.2s cycle', () => {
    // loading-suite.md #17a: 0.8s each, delays 0 / 0.8 / 1.6 / 2.4.
    expect(FLICKER_CYCLE_SECONDS).toBe(3.2);
    expect(FLICKER_ORDER.map(flickerDelay)).toEqual([0, 0.8, 1.6, 2.4]);
  });

  it('rests on the identity mark, because that is the one a still frame should show', () => {
    // The reduced-motion guard hides every child of a slot but the one marked
    // `data-ast-rest`. Resting on an archive concept would show a reader who
    // asked for no motion a mark the app never uses.
    expect(FLICKER_REST).toBe('dpad');
    expect(FLICKER_ORDER[FLICKER_ORDER.length - 1]).toBe('dpad');
  });

  it('seats the sizes the loaders are actually painted at, and no others', () => {
    // The four `loading-suite.md` names, plus the agent path's status slot. That
    // fifth one is later than the document -- the band outliving its run is -- and
    // its 11px is read off the slot rather than chosen: `.ast-sky-status-mark svg`
    // has painted that mark at 11px since the band was drawn. The guard is against
    // a size that exists only in this record, which is why it stays an equality.
    expect(FLICKER_SIZES).toEqual({ splash: 72, inline: 20, button: 14, strip: 18, status: 11 });
  });

  it('draws the small cut in every seating but the splash', () => {
    // Every seating but the splash is under 32px, so every one of them gets the
    // cut and the ring is only ever drawn where it can be seen.
    const graduated = Object.values(FLICKER_SIZES).filter((size) => size >= GRADUATION_FLOOR);
    expect(graduated).toEqual([FLICKER_SIZES.splash]);
  });
});
