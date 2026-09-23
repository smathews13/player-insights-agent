import { describe, expect, it } from 'vitest';

import { partial, partialNames } from './styles/stylesheet';

/**
 * The astrolabe palette, checked against the things it is easiest to get wrong.
 *
 * palette.test.ts already guards the rule this block has to live under: a saturated
 * colour is declared in a token block or it is not written at all. What that file cannot
 * say is whether THIS block is the palette the design asked for, because it reads the
 * block for its own answer. So the values are pinned here, once, from the delivered
 * docs/design-handoff-astrolabe/tokens.css -- names included, since an earlier pass here
 * derived several of them by hand and the delivered file spells five differently.
 *
 * Two failures are worth the file on their own:
 *
 *   - Orange coming back. §2 makes #FF3621 not-a-UI-colour, and the app it is replacing
 *     has it in eleven partials. The likeliest way it returns is not a decision but a
 *     copy: someone builds an astrolabe surface by starting from the nearest DuBois rule.
 *   - Oat coming back, the same way. Ice replaces #F9F7F4 everywhere, and the two are
 *     near enough in a diff that a wrong one reads as right.
 *
 * The pill recipe's geometry is pinned too, because "never colour alone" is only true
 * while the border and the tint are there. A recipe that quietly loses its border still
 * looks fine on a screen where the reader can see all five hues.
 */

const TOKENS = partial('astrolabe-tokens.css');

/** Comments stripped: this file discusses #FF3621 and #F9F7F4 by name, at length. */
const SOURCE = TOKENS.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The delivered tokens.css, value for value and name for name. */
const PALETTE: Record<string, string> = {
  '--ast-canvas': '#f4f7f9',
  '--ast-surface': '#ffffff',
  '--ast-surface-sunken': '#f0f4f7',
  '--ast-surface-raised': '#ffffff',
  '--ast-surface-selected': '#edf3f9',
  '--ast-white': '#ffffff',
  '--ast-navy': '#11171c',
  '--ast-blue': '#1a62a8',
  '--ast-action': '#1a62a8',
  '--ast-action-hover': '#14507f',
  '--ast-action-ink-on-fill': '#ffffff',
  '--ast-action-tint': '#e8f1fa',
  '--ast-action-edge': '#bbd6f0',
  '--ast-blue-on-dark': '#6faedd',
  '--ast-icon-tint': '#b7d6ee',
  '--ast-ink': '#0e1720',
  '--ast-ink-secondary': '#4c5c68',
  '--ast-ink-tertiary': '#6b7a87',
  '--ast-ink-disabled': '#9aa7b2',
  '--ast-text-on-dark-secondary': '#8a9aa3',
  '--ast-hairline': '#e2e8ed',
  '--ast-hairline-strong': '#cfd9e0',
  '--ast-border-input': '#c9d3db',
  '--ast-border-dashed': '#b8c6d1',
  '--ast-pos-text': '#0f6257',
  '--ast-pos-border': '#a8d5cd',
  '--ast-pos-fill': '#eaf6f3',
  '--ast-neg-text': '#a21f35',
  '--ast-neg-border': '#edbfc8',
  '--ast-neg-fill': '#fcf1f3',
  '--ast-warn-text': '#8a5a00',
  '--ast-warn-border': '#e6ce9a',
  '--ast-warn-fill': '#fdf6e8',
  '--ast-warn-deep': '#7a5a11',
  '--ast-neutral-text': '#4c5c68',
  '--ast-neutral-border': '#dce3e9',
  '--ast-neutral-fill': '#f2f5f8',
  '--ast-info-text': '#1a5b8f',
  '--ast-info-border': '#bbd6f0',
  '--ast-info-fill': '#e8f1fa',
  '--ast-provenance-text': '#7a5a11',
  '--ast-provenance-border': '#e4d3a6',
  '--ast-provenance-fill': '#fbf5e6',
  '--ast-danger-fill': '#c2263f',
  '--ast-danger-hover': '#a61e34',
  '--ast-danger-ink': '#ffffff',
  '--ast-star': '#c3d0da',
  '--ast-constellation-line': '#dde5eb',
  '--ast-chart-track': '#e7ecf0',
  '--ast-chart-gridline': '#edf1f4',
};

function declared(name: string) {
  return SOURCE.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]
    ?.trim()
    .toLowerCase();
}

describe('the astrolabe palette is the palette the delivered tokens.css specifies', () => {
  for (const [name, value] of Object.entries(PALETTE)) {
    it(`${name} is ${value}`, () => {
      expect(declared(name)).toBe(value);
    });
  }

  it('keeps the names the design source uses, not the ones derived from the spec text', () => {
    // Five were derived by hand before the real tokens.css arrived, and every one of
    // them is a name four surface lanes would otherwise write from memory. Named here
    // so the wrong one fails loudly rather than resolving to nothing at a call site.
    for (const derived of [
      '--ast-blue-light',
      '--ast-text-on-navy',
      '--ast-control-border',
      '--ast-positive',
      '--ast-negative',
      '--ast-warning',
      '--ast-neutral:',
      '--ast-info:',
    ]) {
      expect(SOURCE, `${derived} was the derived name and is not the delivered one`).not.toContain(derived);
    }
  });

  it('carries no orange, in any notation', () => {
    // Hex and rgb() both, because the page wash and four box-shadows in the palette
    // before last were written as rgba() and a hex search found none of them.
    expect(SOURCE.toLowerCase()).not.toContain('ff3621');
    expect(SOURCE).not.toMatch(/rgba?\(\s*255\s*,\s*54\s*,\s*33/);
    expect(SOURCE).not.toContain('--db-orange');
  });

  it('carries no oat, because Ice replaces it', () => {
    expect(SOURCE.toLowerCase()).not.toContain('f9f7f4');
    expect(SOURCE).not.toContain('--db-warm');
  });

  it('states the eight steps of the scale, at the sizes §3 gives', () => {
    for (const [token, size] of [
      ['--ast-fs-11', '11px'],
      ['--ast-fs-12', '12px'],
      ['--ast-fs-13', '13px'],
      ['--ast-fs-14', '14px'],
      ['--ast-fs-16', '16px'],
      ['--ast-fs-18', '18px'],
      ['--ast-fs-22', '22px'],
      ['--ast-fs-32', '32px'],
    ]) {
      expect(declared(token), `${token} is ${size}`).toBe(size);
    }
  });

  it('states one unitless leading standard for proportional body copy', () => {
    expect(declared('--ast-lh-body')).toBe('1.5');
  });

  it('agrees with the scale tokens.css already declares, step for step', () => {
    // THE DUPLICATION IS DELIBERATE AND THIS IS WHAT MAKES IT SAFE. The delivered file
    // restates the eight sizes and the two radii under --ast-* names, and this app has
    // already declared all ten under --text-* and --radius-*. Aliasing would have left
    // the astrolabe set broken at the moment the DuBois set is retired, which is the
    // one moment it has to work. So both are literals, and this holds them equal while
    // both are live -- the --pia-*/--db-* defect was two names drifting apart, not two
    // names existing.
    const app = partial('tokens.css');
    for (const [ast, existing] of [
      ['--ast-fs-11', '--text-xs'],
      ['--ast-fs-12', '--text-sm'],
      ['--ast-fs-13', '--text-base'],
      ['--ast-fs-14', '--text-h-sub'],
      ['--ast-fs-16', '--text-h-section'],
      ['--ast-fs-18', '--text-h-card'],
      ['--ast-fs-22', '--text-h-page'],
      ['--ast-fs-32', '--text-hero'],
    ]) {
      const theirs = app.match(new RegExp(`${existing}:\\s*([^;]+);`))?.[1]?.trim();
      expect(theirs, `${existing} is declared`).toBeDefined();
      expect(declared(ast), `${ast} agrees with ${existing}`).toBe(theirs);
    }
    expect(app).toMatch(/--radius-sm:\s*var\(--ast-radius-control\)/);
    expect(app).toMatch(/--radius-md:\s*var\(--ast-radius-card\)/);
  });

  it('does not restate the two faces, which tokens.css already declares', () => {
    // --font-sans is DM Sans and --font-mono is DM Mono, both already declared and both
    // self-hosted. A second name for one of them is how a stylesheet ends up with two
    // answers to "which face is the mono one".
    expect(SOURCE).not.toMatch(/--ast-font-(sans|mono)/);
  });

  it('gives the eyebrow and heading letter-spacings the scale is set at', () => {
    expect(declared('--ast-tracking-eyebrow')).toBe('0.06em');
    expect(declared('--ast-tracking-tight')).toBe('-0.01em');
    expect(declared('--ast-tracking-hero')).toBe('-0.015em');
  });

  it('makes the separator a middot and not an em dash', () => {
    // §3 is a rule rather than a preference: the separator is " · " and there are no em
    // dashes anywhere. \00B7 is the middot; U+2014 is the one that is banned.
    expect(declared('--ast-separator')).toBe("' \\00b7 '");
    expect(SOURCE).not.toContain('\u2014');
  });

  it('brings in neither the handoff font faces nor the element rules beside them', () => {
    // The delivered file declares five .ttf faces from its own ./fonts/ and paints
    // `body`, `code` and `a`. This app self-hosts both families as woff2 already, and
    // the element rules would repaint the running app on the commit that lands them --
    // which is the one thing this pass must not do while three lanes are mid-edit.
    expect(SOURCE).not.toContain('@font-face');
    expect(SOURCE).not.toMatch(/\.ttf/);
    expect(SOURCE).not.toMatch(/(^|})\s*(body|a|code)\s*(,[^{]*)?\{/);
  });
});

describe('the pill recipe is one recipe, and it is never colour alone', () => {
  const RECIPE = SOURCE.match(/\.ast-pill\s*\{([^}]*)\}/)?.[1] ?? '';

  it('is 1px bordered, 6px radius, 13px at 500', () => {
    expect(RECIPE).toMatch(/border:\s*1px solid transparent/);
    expect(RECIPE).toMatch(/border-radius:\s*var\(--ast-radius-pill\)/);
    expect(RECIPE).toMatch(/font-size:\s*var\(--ast-fs-13\)/);
    expect(RECIPE).toMatch(/font-weight:\s*500/);
    expect(RECIPE).toMatch(/padding:\s*3px 10px/);
  });

  it('has six families and one outlined alternative', () => {
    // A family that is not one of the five meanings is a colour spent on the
    // sixty-first thing on a screen.
    const families = [...SOURCE.matchAll(/\.ast-pill--([a-z-]+)\s*\{/g)].map((match) => match[1]);
    expect([...new Set(families)].sort()).toEqual([
      'info',
      'neg',
      'neutral',
      'neutral-outline',
      'pos',
      'provenance',
      'warn',
    ]);
  });

  it('gives positive, negative and warning a visible edge as well as a tint', () => {
    for (const family of ['pos', 'neg', 'warn']) {
      const body = SOURCE.match(new RegExp(`\\.ast-pill--${family}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, `${family} sets a text colour`).toMatch(new RegExp(`color:\\s*var\\(--ast-${family}-text\\)`));
      expect(body, `${family} sets a tint`).toMatch(new RegExp(`background:\\s*var\\(--ast-${family}-fill\\)`));
      expect(body, `${family} sets an edge`).toMatch(new RegExp(`border-color:\\s*var\\(--ast-${family}-border\\)`));
    }
  });

  it('gives neutral and info the same visible edge contract as every state family', () => {
    for (const family of ['neutral', 'info']) {
      const body = SOURCE.match(new RegExp(`\\.ast-pill--${family}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(body, `${family} draws its family edge`).toMatch(
        new RegExp(`border-color:\\s*var\\(--ast-${family}-border\\)`)
      );
    }
  });

  it('offers the outlined neutral §2 gives as the alternative form', () => {
    const body = SOURCE.match(/\.ast-pill--neutral-outline\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toMatch(/border-color:\s*var\(--ast-border-input\)/);
    expect(body).not.toMatch(/background/);
  });
});

describe('numerals are mono because the shipped DM Sans cannot be tabular', () => {
  it('sets the mono face rather than relying on font-variant-numeric alone', () => {
    // DMSans-variable.woff2 declares no `tnum` feature -- its GSUB is calt, ccmp, dnom,
    // frac, liga, locl, numr -- and its digits are proportional: 656 units for a 0 and
    // 342 for a 1. So `font-variant-numeric: tabular-nums` has nothing to switch on and
    // silently does nothing there. DM Mono is 600 units for all ten. The delivered
    // tokens.css settled it this way, and it keeps the property so that a tnum-capable
    // DM Sans, if one is ever sourced, is a one-line change here.
    const rule = SOURCE.match(/\.ast-num\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('is called .ast-num, which is the name the design source and four lanes will use', () => {
    expect(SOURCE).toContain('.ast-num');
    expect(SOURCE).not.toContain('.ast-figure');
  });
});

describe('the partials are wired into the cascade', () => {
  it('imports both astrolabe partials, so a test of them is a test of the app', () => {
    // stylesheet() parses the import list out of index.css rather than restating it. A
    // partial on disk and absent from that list is a file the app does not have, and
    // every assertion about it passes for the wrong reason.
    expect(partialNames()).toContain('astrolabe-tokens.css');
    expect(partialNames()).toContain('astrolabe-animation.css');
    expect(partialNames()).toContain('light-mode.css');
    expect(partialNames()).toContain('dark-mode.css');
  });
});
