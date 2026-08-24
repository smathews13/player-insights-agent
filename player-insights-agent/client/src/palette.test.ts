import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';

/**
 * Colour is rationed by meaning, and this is the only thing that checks it still is.
 *
 * The app used to be black on white with three accents. It is DuBois now, with five
 * meanings and five hues: blue for anything you press or that is currently active,
 * orange for the agent working, amber for evaluation, red for failure, green for
 * reachable. The hues changed; the discipline did not, and the discipline is the part
 * a stylesheet cannot state about itself.
 *
 * The failure this guards against is not a broken build. It is a plausible-looking
 * hover state, added months from now by someone who never read the token block, that
 * quietly makes one of the five ambient and takes the meaning of every genuine
 * instance with it. That is what happened to the brand red this palette replaced: it
 * was on the header rule, every eyebrow, the selected row, focus and the composer, and
 * red spent on the sixty-first thing on a screen signals nothing at all.
 *
 * Three rules do most of the work here, and they are the three a hand-restyle breaks
 * first:
 *
 *   - An accent may not be text. Orange is 3.62:1 on white and amber 1.90:1, so
 *     neither can be a label, and the deep rungs exist for when evaluation has to be
 *     type.
 *   - An accent may not be a lone hairline. Same arithmetic: a 1px edge nobody can
 *     see is not an edge, and it spends the colour where it cannot be read.
 *   - Evaluation may not appear on an action. Amber on a button says the button is
 *     being judged, which is the one thing it never means.
 *
 * The contrast figures the token block quotes are recomputed here rather than trusted.
 * A comment claiming 3.62:1 is worth nothing the day someone lightens the token to
 * make it pop and leaves the comment alone.
 *
 * The literal checks are about literals rather than about which selector uses which
 * token. Adding a red state on purpose is allowed -- .live-step.failed is one -- and
 * it should not need this file amended. Reaching past the tokens to write a colour by
 * hand is the move that has never once been correct here.
 */

const STYLESHEET = stylesheet();
const TOKENS = partial('tokens.css');
const ASTROLABE_TOKENS = partial('astrolabe-tokens.css');

/** Comments stripped, so a retired value named in prose is not read as one on screen. */
const SOURCE = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The tokens the ambient-red palette was built from. They are not coming back. */
const RETIRED_TOKENS = ['--pia-red', '--pia-red-action', '--pia-red-strong', '--pia-red-wash', '--pia-red-tint'];

/**
 * The literals of the palette this one replaced. The turquoise and its rungs, the two
 * brand reds, and the gold's deep rung and wash, which DuBois repitches rather than
 * keeps. Any of them reappearing means a rule was restyled by eye against the old
 * screenshot rather than against the token block.
 */
const RETIRED_LITERALS = [
  '#2ad5a5',
  '#0a7350',
  '#eefcf8',
  '#b20022',
  '#8f001b',
  '#e4002b',
  '#6b4600',
  '#fff5e3',
  '#f3d9a4',
];

/**
 * Every `--db-*` or `--ast-*: #hex` in the two token blocks: the whole of the
 * palette, as literals.
 *
 * There are two blocks because there are two palettes live at once for the length of
 * the astrolabe transition, and they are genuinely different colours rather than two
 * names for one -- the astrolabe green is #35706B where the DuBois green is #277C43.
 * astrolabe-tokens.css says at length why that is not a repeat of the mistake that
 * left `--pia-` and `--db-` both live.
 *
 * The check this feeds is unchanged in meaning: a saturated colour may be declared
 * in a token block and may not be written by hand at a call site. Widening it to a
 * second block keeps that, where leaving it narrow would have made every new palette
 * value a stray by construction.
 */
function paletteLiterals() {
  const blocks = TOKENS + ASTROLABE_TOKENS;
  return new Set(
    [...blocks.matchAll(/--(?:db|ast)-[\w-]+:\s*(#[0-9a-fA-F]{6})\b/g)].map((match) => match[1].toLowerCase())
  );
}

/** HSL saturation and hue, enough to answer "is this a colour or a neutral". */
function hsl(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const hue = 60 * (((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) + 6) % 6);
  // Saturation against the brighter half, so a pale wash reads as pale rather than as
  // a desaturated version of the hue it is mixed from. #fff5f7 is 2.0% by this
  // measure; #c82d4c is 78%.
  return { hue, saturation: max === 0 ? 0 : delta / max };
}

function isSaturated(hex: string) {
  return hsl(hex).saturation >= 0.4;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string) {
  const channels = [1, 3, 5]
    .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every rule in the stylesheet as a [selector, body] pair, at-rule wrappers skipped. */
function rules() {
  return [...SOURCE.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => [match[1].trim(), match[2]] as const)
    .filter(([selector]) => !selector.startsWith('@'));
}

/** Every declaration as a [property, value] pair. */
function declarations() {
  return [...SOURCE.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)].map((match) => [match[1], match[2].trim()] as const);
}

/**
 * The working colour, by every name it answers to: the DuBois token, the literal, and
 * the deprecated alias that still points at it. Deliberately not matching
 * `--db-orange-` prefixes, of which there are none, or the amber family, which has its
 * own rule.
 */
const ORANGE = /--db-orange\b|#ff3621|--pia-turquoise(?![\w-])/i;

/** The evaluation colour as a mass. Its deep rung and its line are excluded: those are
 *  the forms that ARE allowed to be type and a hairline. */
const AMBER = /--db-amber(?![\w-])|#ffab00|--pia-gold(?![\w-])/i;

/** Anything with a length of 2px or more in it, which is what makes an edge a rule. */
const THICK = /\b([2-9]|[1-9]\d+)(\.\d+)?px\b/;

const PALETTE = {
  blue: '#2272b4',
  blueHover: '#0e538b',
  orange: '#ff3621',
  amber: '#ffab00',
  amberDeep: '#93320b',
  red: '#c82d4c',
  green: '#277c43',
  warn: '#be501e',
  ink: '#161616',
  slate: '#6f6f6f',
  greyBlue: '#445461',
  chip: '#e8ecf0',
  white: '#ffffff',
  darkInk: '#f2f6fa',
  primaryControlFill: '#1b3049',
  primaryControlBorder: '#4a8cbf',
};

/** Every surface a foreground can find itself on, other than the neutral chip. */
const SURFACES = {
  white: '#ffffff',
  wash: '#f7f7f7',
  warm: '#f9f7f4',
  amber: '#fff9eb',
  red: '#fff5f7',
  green: '#f3fcf6',
};

describe('the palette is the palette, and nothing is painted beside it', () => {
  it('does not bring back the tokens the ambient red was built from', () => {
    expect(RETIRED_TOKENS.filter((token) => STYLESHEET.includes(token))).toEqual([]);
  });

  it('does not bring back the literals of the palette this one replaced', () => {
    expect(RETIRED_LITERALS.filter((hex) => SOURCE.toLowerCase().includes(hex))).toEqual([]);
  });

  it('declares the night-sky literals in the dark token block', () => {
    const dark = TOKENS.split("html[data-theme='dark']")[1] ?? '';
    const astDark = ASTROLABE_TOKENS.split("html[data-theme='dark']")[1] ?? '';
    expect(ASTROLABE_TOKENS).toMatch(/--ast-ice-accent:\s*#8fc1e8/i);
    expect(ASTROLABE_TOKENS).toMatch(/--ast-ink-on-dark:\s*#f2f6fa/i);
    expect(ASTROLABE_TOKENS).toMatch(/--ast-navy:\s*#11171c/i);
    expect(ASTROLABE_TOKENS).toMatch(/--ast-primary-control-fill:\s*#1b3049/i);
    expect(ASTROLABE_TOKENS).toMatch(/--ast-primary-control-border:\s*#4a8cbf/i);
    expect(dark).toContain('--background: var(--ast-navy)');
    expect(astDark).toContain('--ast-sky-fill: var(--ast-navy)');
  });

  it('writes every saturated colour as a token rather than by hand', () => {
    // The failure this catches is a second, slightly different orange. One hand-written
    // #ff3722 beside the token is invisible in a diff and reads on screen as a
    // rendering fault nobody can name. Adding a NEW primitive to the token block is
    // allowed and does not need this file amended -- the check reads the block for its
    // own answer -- but reaching past it at a call site never is.
    const palette = paletteLiterals();
    const strays = [...new Set((SOURCE.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((hex) => hex.toLowerCase()))]
      .filter(isSaturated)
      .filter((hex) => !palette.has(hex));
    expect(strays).toEqual([]);
  });

  it('writes no saturated colour as rgb(), where a hex search would not find it', () => {
    // The page wash, four box-shadows and the logo hairline were all rgba(228, 0, 43)
    // in the palette before last, which is why this looks past hex notation.
    const palette = paletteLiterals();
    const strays = (SOURCE.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g) ?? [])
      .map((call) => {
        const [r, g, b] = call.match(/\d+/g)!.map(Number);
        return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      })
      .filter(isSaturated)
      .filter((hex) => !palette.has(hex));
    expect([...new Set(strays)]).toEqual([]);
  });

  it('states all five families, each with the rungs that make it usable', () => {
    for (const token of [
      '--db-blue-600',
      '--db-blue-700',
      '--db-orange',
      '--db-amber',
      '--db-amber-deep',
      '--db-amber-wash',
      '--db-red-600',
      '--db-red-700',
      '--db-red-wash',
      '--db-red-line',
      '--db-green-600',
      '--db-green-wash',
      '--db-green-line',
    ]) {
      expect(TOKENS, `${token} is defined`).toContain(`${token}:`);
    }
  });

  it('keeps the deprecated --pia-* names pointing at the new palette, not at values', () => {
    // The compatibility layer is what stops a call site the sweep missed from painting
    // a colour that no longer exists anywhere else. It only works if every alias is an
    // alias: one of them redefined as a literal is a second palette in waiting.
    const aliases = [...TOKENS.matchAll(/(--pia-[\w-]+):\s*([^;]+);/g)];
    expect(aliases.length).toBeGreaterThan(10);
    for (const [, name, value] of aliases) {
      expect(value, `${name} is an alias`).toMatch(/^var\(--db-[\w-]+\)$/);
    }
  });

  it('keeps one green family rather than two a reader could not tell apart', () => {
    // --success used to be independently a 163-degree green sitting three degrees off
    // the mark's turquoise. Two of those on one screen is not a palette, it is a bug
    // report waiting to be filed, so the status token routes through the family.
    expect(TOKENS).toMatch(/--success:\s*var\(--db-green-600\)/);
    expect(TOKENS).toMatch(/--destructive:\s*var\(--db-red-600\)/);
  });
});

describe('an accent may not be text, and may not be a lone hairline', () => {
  /** Rules that paint an accent, other than as a custom-property definition. */
  function usesOf(pattern: RegExp) {
    return declarations()
      .filter(([property]) => !property.startsWith('--'))
      .filter(([, value]) => pattern.test(value));
  }

  it('never paints type in the working colour', () => {
    const asText = usesOf(ORANGE).filter(([property]) => property === 'color');
    expect(asText).toEqual([]);
  });

  it('never paints type in the evaluation colour, which has a deep rung for that', () => {
    const asText = usesOf(AMBER).filter(([property]) => property === 'color');
    expect(asText).toEqual([]);
  });

  it('never draws a one-pixel edge in either', () => {
    // A bare `border-color` is caught as well as a thin shorthand: the width is
    // somewhere else in that case, usually a hairline, and a rule that has to be read
    // in two places to be checked is a rule that will not be.
    const edges = [...usesOf(ORANGE), ...usesOf(AMBER)]
      .filter(([property]) => /^(border|outline)/.test(property))
      .filter(([, value]) => !THICK.test(value))
      .map(([property, value]) => `${property}: ${value}`);
    expect(edges).toEqual([]);
  });

  it('draws the pale evaluation edge only around the wash it belongs to', () => {
    // --db-amber-line is the one form of amber that IS allowed to be a hairline, which
    // is why the AMBER pattern above excludes it. That exclusion is only safe while the
    // line stays where it was measured: #f8d4a5 is about 1.4:1 on white, so as an edge
    // on a white surface it is not a faint border, it is an invisible one, and a panel
    // whose boundary cannot be seen has no boundary. On #fff9eb it separates the wash
    // from the page, which is the whole job.
    //
    // Every use satisfies this today — the caveats block, the drift and degraded pills,
    // the gate's limits panel, the plan card awaiting review — so this pins a property
    // the stylesheet already has rather than asking for a change. The failure it is
    // written against is a later reader reaching for the pale amber because a hairline
    // "looked too grey" somewhere it will never be seen at all.
    const unwashed = rules()
      .filter(([, body]) => /--db-amber-line/.test(body))
      // The token block, which declares the line rather than drawing with it.
      .filter(([, body]) => !/--db-amber-line\s*:/.test(body))
      .filter(([, body]) => !/background[^;]*(--db-amber-wash|--pia-gold-wash)/.test(body))
      .map(([selector]) => selector);
    expect(unwashed).toEqual([]);
  });

  it('does not put the evaluation colour on anything you press', () => {
    // Amber on a control says the control is being judged, which is the one thing it
    // never means. The whole family counts, washes included: an amber-tinted button is
    // the same claim made quietly.
    const onActions = rules()
      .filter(([selector]) => /button|\[aria-pressed|:focus-visible|nav a\b|-primary\b/.test(selector))
      .filter(([, body]) => /amber|--pia-gold/i.test(body))
      .map(([selector]) => selector);
    expect(onActions).toEqual([]);
  });

  it('does not put the working colour on anything you press either', () => {
    // Orange means "this is happening now", which is a report rather than an
    // affordance. Blue owns the things that can be pressed.
    const onActions = rules()
      .filter(([selector]) => /button|\[aria-pressed|:focus-visible|nav a\b|-primary\b/.test(selector))
      .filter(([, body]) => ORANGE.test(body))
      .map(([selector]) => selector);
    expect(onActions).toEqual([]);
  });
});

describe('the arithmetic the token block claims', () => {
  it('makes the action colour safe as type, which is why it could take ink’s job', () => {
    expect(contrast(PALETTE.blue, PALETTE.white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.blueHover, PALETTE.white)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the dark primary label readable while moving blue onto its edge', () => {
    /*
     * The dark control is deliberately not the action hue as a solid mass. The
     * deep panel still has to carry ordinary-size type at AA, and its blue edge
     * has to remain distinguishable from that panel rather than collapsing into
     * a decorative line nobody can see.
     */
    expect(contrast(PALETTE.darkInk, PALETTE.primaryControlFill)).toBeCloseTo(12.352, 3);
    expect(contrast(PALETTE.darkInk, PALETTE.primaryControlFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.primaryControlBorder, PALETTE.primaryControlFill)).toBeGreaterThanOrEqual(3);
  });

  it('leaves the working colour a mass colour and not a label colour', () => {
    // Both halves are asserted, because both are load-bearing. Under 4.5 is why orange
    // may not be text; at or over 3 is why it is allowed to be a bar, a tile or a 2px
    // rule. If a future retune moved it across either line the token block's
    // instructions would be wrong and nothing else would notice.
    expect(contrast(PALETTE.orange, PALETTE.white)).toBeLessThan(4.5);
    expect(contrast(PALETTE.orange, PALETTE.white)).toBeGreaterThanOrEqual(3);
    // The handoff asks for white on the solid-orange live pill, which is this same
    // figure and under AA. Recorded rather than quietly fixed: the pill is a per-screen
    // decision. Ink on orange clears AA if it is ever revisited.
    expect(contrast(PALETTE.white, PALETTE.orange)).toBeLessThan(4.5);
  });

  it('leaves the evaluation colour unusable even as an edge, exactly as it always was', () => {
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(contrast(PALETTE.amber, surface), `amber on ${name}`).toBeLessThan(3);
    }
  });

  it('carries an ink glyph legibly whenever either is a filled mass', () => {
    expect(contrast(PALETTE.ink, PALETTE.orange), 'ink on orange').toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.ink, PALETTE.amber), 'ink on amber').toBeGreaterThanOrEqual(4.5);
  });

  it('clears AA for every colour that is allowed to be type, on its own surface', () => {
    expect(contrast(PALETTE.amberDeep, SURFACES.amber), 'amber-deep on the amber wash').toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.red, SURFACES.red), 'red on the red wash').toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.green, SURFACES.green), 'green on the green wash').toBeGreaterThanOrEqual(4.5);
    expect(contrast(PALETTE.warn, SURFACES.white), 'the drift rung on white').toBeGreaterThanOrEqual(4.5);
  });

  it('pitches every wash so a foreground checked against one holds on all of them', () => {
    // This is what lets a rule move from the neutral wash onto the red one without
    // being rechecked, and it is the property the washes were chosen for rather than a
    // coincidence worth rediscovering.
    for (const [name, surface] of Object.entries(SURFACES)) {
      expect(contrast(PALETTE.slate, surface), `the secondary grey on the ${name} surface`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('knows the one surface that is the exception, and gives it its own foreground', () => {
    // The neutral chip fill is darker than the washes and the secondary grey does not
    // clear it. That is why chip text is a separate token, and why this is asserted
    // rather than left as a note somebody will contradict.
    expect(contrast(PALETTE.slate, PALETTE.chip), 'the secondary grey on the chip fill').toBeLessThan(4.5);
    expect(contrast(PALETTE.greyBlue, PALETTE.chip), 'chip text on the chip fill').toBeGreaterThanOrEqual(4.5);
  });
});

describe('the two washes of the action colour are the action colour', () => {
  // Selected and hovered are the same blue at two weights, and both were typed
  // out as `rgba(34, 114, 180, ...)` rather than derived. 34, 114, 180 is
  // #2272B4 is --db-blue-600, so the arithmetic is asserted here: move the blue
  // without moving these and the app grows a second one nothing points at.
  const channels = (token: string) => {
    const found = TOKENS.match(new RegExp(`${token}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`));
    expect(found, `${token} is declared as an rgba of the blue`).not.toBeNull();
    return found!.slice(1).map(Number);
  };

  it('declares a hover tint beside the selected one', () => {
    expect(TOKENS).toMatch(/--db-hover-tint:/);
    expect(channels('--db-selected-tint').slice(0, 3)).toEqual(channels('--db-hover-tint').slice(0, 3));
  });

  it('mixes both of them from --db-blue-600 and nothing else', () => {
    const blue = PALETTE.blue
      .replace('#', '')
      .match(/../g)!
      .map((pair) => parseInt(pair, 16));
    expect(channels('--db-selected-tint').slice(0, 3)).toEqual(blue);
    expect(channels('--db-hover-tint').slice(0, 3)).toEqual(blue);
    // Hover is the heavier of the two: a control under the pointer has to read as
    // more present than a row that merely happens to be selected.
    expect(channels('--db-hover-tint')[3]).toBeGreaterThan(channels('--db-selected-tint')[3]);
  });

  it('is named rather than retyped everywhere the pointer lands', () => {
    for (const name of ['gate.css', 'rail.css']) {
      const css = partial(name).replace(/\/\*[\s\S]*?\*\//g, ' ');
      expect(css, `${name} still types the hover wash out by hand`).not.toMatch(/rgba\(34,\s*114,\s*180/);
      expect(css, `${name} does not name the hover tint`).toMatch(/var\(--db-hover-tint\)/);
    }
  });
});

describe('the chart series say the same things the rest of the app does', () => {
  it('draws the primary series in the action colour', () => {
    // The bar and the button that produced it are the same colour on purpose.
    expect(TOKENS).toMatch(/--chart-1:\s*var\(--db-blue-600\)/);
  });

  it('reserves the emphasis series for the working colour and nothing else', () => {
    expect(TOKENS).toMatch(/--chart-emphasis:\s*var\(--db-orange\)/);
  });

  it('keeps evaluation out of the series, where it would judge a measurement', () => {
    // A slow or outlier bar separates by weight and by going to full-strength blue,
    // never by going amber: amber beside the score card would read as a verdict on the
    // run rather than a measurement of it.
    const series = [...TOKENS.matchAll(/--chart-[\w-]+:\s*([^;]+);/g)].map((match) => match[1]);
    expect(series.filter((value) => AMBER.test(value))).toEqual([]);
  });
});

describe('focus is one thing everywhere', () => {
  it('draws a solid two-pixel ring in the action colour, offset by two', () => {
    // AppKit draws its own ring from --ring at partial alpha, which on a white shell
    // was faint enough to lose. A focus ring that is sometimes visible is worse than
    // one that is always ugly.
    const base = partial('base.css');
    const rule = base.match(/(?:^|\n):focus-visible\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/outline:\s*2px solid var\(--ast-blue\)/);
    expect(rule).toMatch(/outline-offset:\s*2px/);
  });
});
