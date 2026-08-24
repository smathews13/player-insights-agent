import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { partial } from './styles/stylesheet';

/**
 * That the first-open card is reachable at every window height.
 *
 * THE FAULT THIS EXISTS FOR, so nobody restores the rule that caused it. The
 * overlay was a fixed, full-viewport flex container with `align-items: center`
 * and `overflow-y: auto`, and the card inside it is a fixed-width column of a
 * title, an identity block, one row per declared scope, a footer, a disclaimer
 * and a button. At nine scopes and a five-line footer that column is taller
 * than a laptop viewport, and a flex item taller than its scrolling container
 * does not centre and then scroll: it overflows BOTH ends, and the overflow
 * past the START edge cannot be scrolled to, because scroll position cannot go
 * below zero. The reader lost the top of the card and the bottom of it at once,
 * and the Continue button with them, which is why it was reported as "cut off"
 * rather than as "needs scrolling".
 *
 * A render test cannot see this. `renderToStaticMarkup` has no layout, no
 * viewport and no scrollbars, so the assertions are made against the stylesheet
 * in the pattern `explorer-geometry.test.ts` established, and against the shape
 * of the fix rather than against a measured pixel.
 */

const CSS = partial('first-open.css');

/** The declarations of one rule, by selector, so a claim is about one block. */
function rule(selector: string): string {
  const start = CSS.indexOf(`\n${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return CSS.slice(start, CSS.indexOf('}', start));
}

describe('the first-open overlay', () => {
  it('does not centre a card it may be shorter than', () => {
    const overlay = rule('.first-open');
    // The whole of the defect in one declaration. `center` here puts the top of
    // an over-tall card above the scroll origin, where nothing can reach it.
    expect(overlay).not.toContain('align-items: center');
    expect(overlay).toContain('align-items: flex-start');
  });

  it('still centres the card while there is room for it', () => {
    // `margin: auto` on the item does what `align-items: center` did, in the one
    // way that degrades correctly: auto margins take the FREE space, and there is
    // none to take once the card is the taller of the two, so it lands at the top
    // rather than above it.
    expect(rule('.first-open-card')).toContain('margin: auto');
  });

  it('keeps the overlay scrollable as the outer safety net', () => {
    expect(rule('.first-open')).toContain('overflow-y: auto');
  });
});

describe('the first-open card', () => {
  it('is bounded by the viewport and scrolls itself', () => {
    const card = rule('.first-open-card');
    // Bounded, so the card's own edges stay visible and the reader can see that
    // there is more of it to reach. 32px is the overlay's 16px padding, doubled.
    expect(card).toMatch(/max-height:\s*calc\(100vh - 32px\)/);
    // And the two have to stay in step: a cap that does not equal the overlay's
    // own padding either wastes room the card needed or lets it run under the
    // edge of the screen. Read off the stylesheet rather than restated.
    const overlayPadding = Number(rule('.first-open').match(/padding:\s*(\d+)px/)?.[1] ?? 0);
    const cap = Number(card.match(/max-height:\s*calc\(100vh - (\d+)px\)/)?.[1] ?? 0);
    expect(cap).toBe(overlayPadding * 2);
    expect(card).toContain('overflow-y: auto');
  });

  it('does not let its blocks shrink instead of scrolling', () => {
    // A column flex item shrinks on the main axis by default. Capping the card's
    // height without this would compress the scope rows, the disclaimer and the
    // button into each other and never produce a scrollbar at all -- content
    // present, unreadable, and no indication that anything was wrong.
    expect(rule('.first-open-card > *')).toContain('flex: none');
  });

  /*
   * 720px, NOT the spec's 440px, and the change is the fix for the height rather
   * than a preference about width. At 440px the nine-scope target drew nine
   * full-width rows under an identity block and a four-sentence disclaimer, which
   * came to more than a laptop viewport holds: the card that opens the app opened
   * already scrolled, with the button below the fold. The extra width is what pays
   * for two columns of scopes, and two columns is what halves the tallest block.
   */
  it('is wide enough to run the scope rows in two columns', () => {
    const card = rule('.first-open-card');
    expect(card).toContain('width: 720px');
    // Narrow windows are the other way this card leaves the screen.
    expect(card).toContain('max-width: 100%');
  });

  it('gives the scope list two tracks that a long scope name cannot collapse', () => {
    // `minmax(0, 1fr)` and never a bare `1fr`: a scope name is one long
    // unbreakable-looking token, and `1fr`'s floor is its min-content width, so
    // the longest declared scope would push its own column past the card and be
    // clipped by the box's `overflow: hidden` rather than wrapping inside it.
    const list = rule('.fo-scope-list');
    expect(list).toContain('display: grid');
    expect(list).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  });

  /*
   * Two columns need the row rules ABOVE each row, and that is a correctness
   * property rather than a preference: the first row is the first two cells at
   * either count, so clearing `:nth-child(-n + 2)` never doubles the header band's
   * border and no row carries a trailing rule to hang under a half-filled last
   * row. Written as `border-bottom` it has to know whether the scope count is odd,
   * and comes out wrong on one of the two.
   */
  it('draws the row hairlines so they cannot double or dangle at either count', () => {
    expect(rule('.fo-scope-row')).toContain('border-top');
    expect(rule('.fo-scope-row')).not.toContain('border-bottom');
    expect(rule('.fo-scope-row:nth-child(-n + 2)')).toContain('border-top: none');
  });

  /*
   * The fallback lives in responsive.css because `breakpoints.test.ts` fails on a
   * width query in a page partial. Asserted from this end too, so a reader
   * auditing the card's geometry finds the narrow arrangement rather than
   * concluding it has none.
   */
  it('falls back to one column at the app narrow breakpoint', () => {
    const narrow = partial('responsive.css').match(/@media \(max-width: 800px\)\s*\{([\s\S]*?)\n\}/)![1];
    expect(narrow).toMatch(/\.fo-scope-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(narrow).toMatch(/\.fo-scope-row:nth-child\(even\)\s*\{[^}]*border-left:\s*none/);
    expect(CSS).not.toMatch(/@media\s*\((?:max|min)-width/);
  });
});

describe('the card fits one viewport without scrolling', () => {
  /*
   * Reported twice: once against 28/18 and again against 22/14, both times as
   * "the login screen should fit in one view". The cap on the card is a backstop
   * for an unforeseen height, NOT the plan -- if it is ever reached, the reader
   * is being asked to scroll the one screen they must read before continuing.
   *
   * Pinned as ceilings rather than exact values so a later trim is free, and
   * because what matters is that nothing grows back.
   */
  const vertical = (block: string) => {
    const padding = block.match(/padding:\s*(\d+)px/)?.[1];
    return Number(padding ?? Number.NaN);
  };

  it('keeps the frame and the seams tight', () => {
    const card = rule('.first-open-card');
    expect(vertical(card), 'card padding').toBeLessThanOrEqual(18);
    expect(Number(card.match(/gap:\s*(\d+)px/)?.[1]), 'card gap').toBeLessThanOrEqual(12);
  });

  it('spends its smallest padding where the card repeats it most', () => {
    // Nine scopes are five row-lines, so a pixel here is a pixel five times.
    // This is the trim that cleared the scrollbar and the one most likely to be
    // undone by somebody restyling a single row in isolation.
    const row = rule('.fo-scope-row').match(/padding:\s*(\d+)px\s+(\d+)px/);
    expect(Number(row?.[1]), 'scope row vertical padding').toBeLessThanOrEqual(7);
    // The horizontal inset lines the names up with the header band above them.
    expect(Number(row?.[2]), 'scope row horizontal padding').toBe(14);
  });

  it('does not buy the space back out of the disclaimer type', () => {
    // The block that says the app is not official Databricks software. Its
    // leading gave up a few pixels; its SIZE is not a candidate.
    expect(rule('.fo-disc-body')).toMatch(/font-size:\s*12px/);
  });
});

describe('the card is painted from the astrolabe palette', () => {
  const GATE = readFileSync(new URL('FirstOpenGate.tsx', import.meta.url), 'utf8');

  it('sits on Ice, which is what replaced oat everywhere', () => {
    // The two specs in one bundle disagree here. `login-gate.md` says "#F9F7F4
    // (Oat Light) backdrop"; `astrolabe-rebuild-spec.md` §2 says Ice "replaces
    // oat everywhere" and §9 lists oat under Retire. The per-surface spec's
    // anchors are #13a/#13b, from before the palette turn, so the app-wide rule
    // is the later one -- and the delivered screenshot of this card is drawn on
    // Ice, which settles it.
    expect(rule('.first-open')).toContain('background: var(--ast-ice)');
    expect(CSS).not.toContain('--db-warm');
  });

  it('reaches past no token to write a colour by hand', () => {
    // The whole file, not one rule: the failure this catches is a hex typed into
    // a state added months from now, which is invisible in a diff and reads on
    // screen as a rendering fault nobody can name.
    const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutComments).not.toMatch(/var\(--db-/);
  });

  it('spends the one pill recipe rather than three of its own', () => {
    // This card wrote its own green, red and neutral chips, three of the 21
    // hand-written chip recipes docs/astrolabe-migration-inventory.md counted
    // across the app. §2 has one recipe and five families.
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, ' ')).not.toContain('.fo-pill');
    expect(GATE).toContain('ast-pill ast-pill--pos');
    expect(GATE).toContain('ast-pill ast-pill--neg');
    expect(GATE).toContain('ast-pill ast-pill--neutral');
  });

  it('says each verdict in words, so no pill is telling the reader in colour alone', () => {
    // §2's "never colour alone" is a requirement about these strings rather than
    // about the rules: a reader who cannot separate green from red still has to
    // read three different verdicts.
    for (const verdict of ['Granted', 'Missing', 'Not checked']) {
      expect(GATE, verdict).toContain(`>${verdict}<`);
    }
  });

  it('draws the two corporate marks and inks neither of them', () => {
    // §2 makes this card's logo and the top bar's bricks symbol the only
    // full-colour Databricks artwork in the product. A `fill` on either would be
    // the app recolouring a trademark on the one surface that exists to
    // attribute it. The logo is a wordmark, so it is sized by height and its
    // width follows; boxed, it is either squashed or cropped.
    expect(GATE).toContain('DATABRICKS_LOGO');
    expect(GATE).toContain('DATABRICKS_SYMBOL');
    const logo = rule('.fo-databricks-logo svg');
    expect(logo).toContain('height: 18px');
    expect(logo).toContain('width: auto');
    for (const selector of ['.fo-databricks-logo svg', '.fo-disc-symbol svg']) {
      expect(rule(selector), selector).not.toMatch(/(?:^|[;{\s])(?:color|fill|stroke|background)\s*:/);
    }
  });
});
