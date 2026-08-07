import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The palette is black and white, and red means something.
 *
 * This is a test rather than a comment because the rule it protects is one that a
 * stylesheet cannot state about itself. The app used to be red everywhere it wanted
 * attention (the header rule, every eyebrow, the selected row, focus, the composer,
 * the access gate's chrome), and red spent on the sixty-first thing on a screen is
 * not signalling anything. It is now spent on refusals, failures and deletes only.
 *
 * That is a claim about meaning, so the failure mode it guards against is not a
 * broken build. It is a plausible-looking hover state, added months from now by
 * someone who never read the palette comment, that quietly makes red ambient again
 * and takes the meaning of every genuine warning with it.
 *
 * Both checks are deliberately about literals rather than about which selectors use
 * --pia-danger. Adding a red state on purpose is allowed, .live-step.failed is one,
 * and it should not need this file amended. Reaching past the tokens to write a red
 * by hand is the thing that has never once been correct here.
 */

const STYLESHEET = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8');

/** The tokens the ambient-red palette was built from. They are not coming back. */
const RETIRED_TOKENS = ['--pia-red', '--pia-red-action', '--pia-red-strong', '--pia-red-wash', '--pia-red-tint'];

/**
 * The two saturated reds the stylesheet is allowed to name, both as token definitions
 * and nowhere else: the danger rung and the one hover state built on it.
 */
const DANGER_LITERALS = new Set(['#b20022', '#8f001b']);

/** HSL, enough of it to answer "is this a saturated red". */
function redness(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const hue = 60 * (((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) + 6) % 6);
  // Saturation against the brighter half, so a pale wash reads as pale rather than as
  // a desaturated red. #fef5f7 is 3.5% by this measure; #e4002b is 100%.
  const saturation = max === 0 ? 0 : delta / max;
  return { hue, saturation };
}

/** Saturated, and in the red wedge either side of 0°. Gold sits at 40° and is exempt. */
function isSaturatedRed(hex: string) {
  const { hue, saturation } = redness(hex);
  return saturation >= 0.4 && (hue >= 335 || hue <= 15);
}

describe('the stylesheet keeps red for the things that mean it', () => {
  it('does not bring back the tokens the ambient red was built from', () => {
    expect(RETIRED_TOKENS.filter((token) => STYLESHEET.includes(token))).toEqual([]);
  });

  it('names no saturated red the danger family does not own', () => {
    const hexes = STYLESHEET.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    const strays = [...new Set(hexes.map((hex) => hex.toLowerCase()))]
      .filter(isSaturatedRed)
      .filter((hex) => !DANGER_LITERALS.has(hex));
    expect(strays).toEqual([]);
  });

  it('writes no red as rgb(), where a hex search would not find it', () => {
    // The page wash, four box-shadows and the logo hairline were all rgba(228, 0, 43),
    // which is why this looks past hex notation: the grep that finds #e4002b misses
    // every one of them.
    const channels = STYLESHEET.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g) ?? [];
    const reds = channels.filter((call) => {
      const [r, g, b] = call.match(/\d+/g)!.map(Number);
      return isSaturatedRed(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
    });
    expect(reds).toEqual([]);
  });

  it('still states the danger family, so "no red" has not been read as "no warnings"', () => {
    for (const token of ['--pia-danger', '--pia-danger-deep', '--pia-danger-wash', '--pia-danger-tint']) {
      expect(STYLESHEET, `${token} is defined`).toContain(`${token}:`);
    }
    // The access gate's refusal is the load-bearing one: it is the first thing a
    // reader without the grant sees, and monochrome it reads as ordinary copy.
    expect(STYLESHEET).toMatch(/\.access-gate-result-bad\s*\{[^}]*--pia-danger-wash/);
  });
});
