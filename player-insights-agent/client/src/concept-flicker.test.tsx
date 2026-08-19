import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConceptFlicker } from './ConceptFlicker';
import { partial, stylesheet } from './styles/stylesheet';
import { FLICKER_SIZES } from './astrolabe-mark';

/**
 * The pre-plan splash flicker is drawn, sized and visible -- not a blank square.
 *
 * The reported failure was a band of white above "Working on it" where the four
 * marks should cycle. The mechanism is right in the source and in the shipped
 * bundle, so the guards here pin the three ways it could still render as nothing:
 * a slot with no size, marks in an ink that vanishes on the white card, or a
 * suppression that hides the slot outside the one place it is allowed to (the
 * reduced-motion freeze, which must then show ONE still mark rather than none).
 */

const LOADERS = partial('astrolabe-loaders.css');
const ANIMATION = partial('astrolabe-animation.css');
const SHEET = stylesheet();

function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

describe('the splash flicker renders four sized, visible marks', () => {
  const markup = renderToStaticMarkup(<ConceptFlicker seat="splash" />);

  it('sizes the slot so it cannot collapse to nothing', () => {
    // The slot carries the seat size inline; a zero-sized slot is the blank
    // square the report described. 72px is the splash seating.
    expect(FLICKER_SIZES.splash).toBeGreaterThan(0);
    expect(markup).toMatch(
      new RegExp(`width:\\s*${FLICKER_SIZES.splash}px`),
    );
    expect(markup).toMatch(new RegExp(`height:\\s*${FLICKER_SIZES.splash}px`));
  });

  it('stacks exactly the four concept marks', () => {
    const marks = markup.match(/class="ast-mark[^"]*ast-anim-flick"/g) ?? [];
    expect(marks).toHaveLength(4);
  });

  it('paints them in the light ink, which is navy on the white card', () => {
    // ink "light" resolves to --ast-mark-ink: var(--ast-navy) in
    // astrolabe-mark.css. The white/mono inks would be invisible here, which is
    // one of the ways a present flicker reads as blank.
    expect(markup).toMatch(/ast-mark--light/);
    expect(markup).not.toMatch(/ast-mark--mono/);
    expect(markup).not.toMatch(/ast-mark--dark/);
    // And the ink actually resolves to a dark value against white.
    expect(withoutComments(partial('astrolabe-mark.css'))).toMatch(
      /\.ast-mark--light\s*\{[^}]*--ast-mark-ink:\s*var\(--ast-navy\)/,
    );
  });

  it('marks exactly one still frame for the frozen state', () => {
    const rest = markup.match(/data-ast-rest/g) ?? [];
    expect(rest).toHaveLength(1);
  });

  it('is decorative to a screen reader', () => {
    expect(markup).toMatch(/aria-hidden="true"/);
  });
});

describe('the flicker is only ever hidden by its own animation or the freeze', () => {
  const loaders = withoutComments(LOADERS);
  const animation = withoutComments(ANIMATION);

  it('starts each mark invisible and animates it in, rather than hiding it', () => {
    // opacity 0 as the base is deliberate: ast-flick brings each mark in and out
    // so exactly one shows at a time. This is the ONE opacity:0 the slot has.
    expect(loaders).toMatch(/\.ast-flick-slot > \*\s*\{[^}]*opacity:\s*0/);
    expect(loaders).toMatch(/\.ast-anim-flick\s*\{[^}]*animation-name:\s*ast-flick/);
    // The keyframe actually reaches full opacity, so the "in" half exists.
    expect(animation).toMatch(/@keyframes ast-flick\s*\{[\s\S]*?opacity:\s*1/);
  });

  it('never display:none or visibility:hidden the splash flicker', () => {
    // A suppression here would blank the slot at every width, which is the bug.
    for (const selector of ['.ast-flick-splash', '.ast-flick-slot', '.ast-flick-slot--splash']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rules = withoutComments(SHEET).match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, 'g')) ?? [];
      for (const rule of rules) {
        expect(rule).not.toMatch(/display:\s*none/);
        expect(rule).not.toMatch(/visibility:\s*hidden/);
      }
    }
  });

  it('freezes to a single still mark under reduced motion, never to nothing', () => {
    // The freeze hides the animating siblings and restores the one carrying
    // data-ast-rest, so a reader who asked for no motion sees the app mark
    // rather than an empty square.
    const reduced = animation.slice(animation.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/\.ast-flick-slot > \*\s*\{\s*opacity:\s*0/);
    expect(reduced).toMatch(/\.ast-flick-slot > \[data-ast-rest\]\s*\{[^}]*opacity:\s*1/);
  });
});
