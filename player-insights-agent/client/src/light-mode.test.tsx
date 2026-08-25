import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentPathConstellation } from './AgentConstellation';
import { partial } from './styles/stylesheet';
import type { TraceStage } from './answer-shape';

/**
 * LIGHT MODE IS DAYLIGHT ALL THE WAY THROUGH.
 *
 * The reported fault, in the reader's words: the night sky was still there in
 * light mode -- behind the answer cards, and down the whole of the Active steps
 * column -- and the answer card itself read as a grey pane on it. Three separate
 * causes, one appearance:
 *
 *   1. `.app-sky`, the app-wide starfield, was hidden outside dark by an
 *      unconditional default in the DARK theme's own stylesheet, which is a ban
 *      expressed as the absence of an opt-in.
 *   2. `.ask-layout` and `.trace-inspector` paint `--ast-sky-fill` and the
 *      starfield UNCONDITIONALLY. `--ast-sky-fill` is navy at `:root` (dark
 *      reads it) and remaps to Ice outside dark, so a leftover use cannot
 *      keep a charcoal page.
 *   3. `--ast-pane`, which is what the answer card, the question bubble and the
 *      composer are all drawn on, is 94% white -- so whatever was behind them
 *      showed through, and in light mode what was behind them was (2).
 *
 * And one thing that is not a bug and had to be replaced rather than hidden: the
 * live agent band IS a night sky, by design (`#18a`), so there is no daylight
 * version of it. `StepRail` is the same run as a list of rows on white, and the
 * theme picks between the two in CSS.
 *
 * WHY THESE ARE TESTS. Every claim below is invisible on the surface it governs.
 * A theme that has quietly gone back to painting stars behind an opaque card looks
 * completely correct until the card's alpha changes; a second copy of the step list
 * in the accessibility tree is silent to everybody who can see the screen; and the
 * whole arrangement is decided by CSS selectors, which no rendering test in this
 * suite can observe. So the checks are split the way the implementation is: the
 * stylesheet claims are read back out of the stylesheet, and the markup claims are
 * rendered.
 *
 * THE CONDITION IS ALWAYS `:not([data-theme='dark'])`. Every light rule in the app
 * is written that way rather than as `[data-theme='light']`, so the two halves of
 * each pair are exhaustive: there is no attribute value, including none at all,
 * that leaves a surface with neither treatment. `dark` gets the sky and everything
 * else gets daylight.
 */

const NOT_DARK = ":not([data-theme='dark'])";
const BASE = partial('base.css');
const DARK = partial('dark-mode.css');
const RAIL = partial('rail.css');
const ASK = partial('ask.css');
const ANSWER = partial('answer.css');
const CONSTELLATION = partial('constellation.css');
const TOKENS = partial('astrolabe-tokens.css');
const LOADERS = partial('astrolabe-loaders.css');
const STAR = partial('star-motion.css');
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** A stylesheet with its commentary removed, so a claim reads only declarations. */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * One selector's declaration block, including when it shares a grouped rule.
 *
 * The same reader dark-mode-audit.test.ts uses, for the same reason: a claim about
 * a rule should fail when the rule is deleted rather than pass because some other
 * rule in the file happens to contain the string.
 */
function rule(css: string, selector: string): string {
  return rules(css, selector).join('');
}

/**
 * Every block a selector appears in, for the two seatings that have more than one.
 *
 * `.trace-inspector` is written twice in rail.css -- once grouped with the
 * conversation rail for the geometry both columns share, once on its own for the
 * sky -- so a reader that stopped at the first would report the second missing.
 */
function rules(css: string, selector: string): string[] {
  return [...declarations(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((candidate) => candidate.trim() === selector))
    .map((match) => match[2]);
}

/** A TypeScript source with its commentary removed, so a claim reads only code. */
function code(name: string): string {
  return source(name)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** Every declaration block whose selector is conditional on not being dark. */
function lightRules(css: string): { selector: string; body: string }[] {
  return [...declarations(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes(NOT_DARK))
    .map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

function stage(overrides: Partial<TraceStage> & Pick<TraceStage, 'id'>): TraceStage {
  return {
    name: 'Chose the next step',
    kind: 'agent',
    start: 0,
    duration: 1829,
    status: 'complete',
    calls: 1,
    input: '',
    output: '',
    startMeasured: true,
    ...overrides,
  };
}

/** A run of six steps with its last one still going. */
const inFlight: TraceStage[] = [
  stage({ id: 'step-1', name: 'Chose the next step' }),
  stage({ id: 'step-1-1-search_semantics', name: 'Searched the semantic layer', kind: 'tool', duration: 604 }),
  stage({ id: 'step-2', name: 'Chose the next step' }),
  stage({ id: 'step-2-1-dictionary_genie', name: 'Checked a field definition', kind: 'tool', duration: 13_400 }),
  stage({ id: 'step-3', name: 'Chose the next step' }),
  stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', kind: 'tool', status: 'running', duration: 0 }),
];

const RAIL_OPEN = '<div class="step-rail">';

/** The daylight list alone, with the dark band that precedes it cut off. */
function railOf(stages: TraceStage[], activeIndex: number, elapsedMs: number | null = null): string {
  const markup = renderToStaticMarkup(
    <AgentPathConstellation stages={stages} activeIndex={activeIndex} elapsedMs={elapsedMs} />
  );
  const open = markup.indexOf(RAIL_OPEN);
  expect(open, 'the live path renders a daylight list').toBeGreaterThan(-1);
  return markup.slice(open);
}

/** The dark band alone. */
function bandOf(stages: TraceStage[], activeIndex: number, elapsedMs: number | null = null): string {
  const markup = renderToStaticMarkup(
    <AgentPathConstellation stages={stages} activeIndex={activeIndex} elapsedMs={elapsedMs} />
  );
  return markup.slice(0, markup.indexOf(RAIL_OPEN));
}

/** Every attribute value for one attribute, so a count can be asserted. */
function attrs(markup: string, name: string): string[] {
  return [...markup.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((found) => found[1]);
}

describe('the night sky belongs to dark mode alone', () => {
  it('bans the app-wide starfield outside dark, positively and in the app stylesheet', () => {
    /*
     * dark-mode.css declares `.app-sky { display: none }` and then turns it on
     * under its own theme, which is where the layer's geometry belongs. As a
     * GUARANTEE that is the wrong shape twice: it is an unconditional default any
     * later rule could raise, and it lives in the one file whose subject is the
     * dark theme. base.css states the ban itself, so anything switching the sky on
     * outside dark has to out-specify a rule that names the condition.
     */
    expect(rule(BASE, `html${NOT_DARK} .app-sky`)).toMatch(/display:\s*none/);
    expect(rule(DARK, "html[data-theme='dark'] .app-sky")).toMatch(/display:\s*block/);
    expect(rule(STAR, `html${NOT_DARK} .app-sky.gate-star-motion`)).toMatch(/display:\s*none/);
  });

  it('decides that in the stylesheet rather than at render time', () => {
    /*
     * The alternative was reading `data-theme` and returning null in daylight, and
     * what rules it out is how the theme is applied: `applyColorScheme` writes the
     * attribute straight onto <html> and nothing in React holds the value, so a
     * conditional mount follows no state change. The Appearance toggle previews a
     * switch by repainting the page without re-rendering this tree -- the sky would
     * stay up over a daylight page until something unrelated caused a render.
     *
     * So neither file reads the attribute. This is the assertion that keeps a
     * later "improvement" from reintroducing exactly that flash.
     */
    expect(code('AppSky.tsx')).not.toMatch(/data-theme|appliedColorScheme|matchMedia/);
    expect(source('Layout.tsx')).toContain('<AppSky />');
    expect(code('Layout.tsx')).not.toMatch(/data-theme|appliedColorScheme/);
  });

  it('paints neither navy nor spackle on the two surfaces that carry the sky in dark', () => {
    /*
     * THE BASE RULES KEEP THE SKY, because dark mode reads them: `.ask-layout` is
     * overpainted transparent in dark so `.app-sky` shows through it, and the
     * harness column keeps the fill and the field. What is asserted here is the
     * light half -- and that it is a FIELD rather than a fainter starfield, because
     * there is no daylight weight at which a star is not a star.
     */
    expect(rule(RAIL, '.ask-layout')).toMatch(/background-image:\s*var\(--ast-sky-spackle\)/);
    expect(rule(RAIL, '.trace-inspector')).toMatch(/background-image:\s*var\(--ast-sky-spackle\)/);

    const layout = rule(RAIL, `html${NOT_DARK} .ask-layout`);
    expect(layout).toMatch(/background-color:\s*var\(--db-wash\)/);
    expect(layout).toMatch(/background-image:\s*none/);

    const inspector = rule(RAIL, `html${NOT_DARK} .trace-inspector`);
    expect(inspector).toMatch(/background:\s*var\(--card\)/);
    expect(inspector).toMatch(/background-image:\s*none/);
    /* A hairline where the navy used to be its own edge, or a white column on a
       #F7F7F7 field reads as a gap in the page rather than as a boundary. */
    expect(inspector).toMatch(/border-left:\s*1px solid var\(--db-line\)/);

    for (const body of [layout, inspector]) expect(body).not.toMatch(/--ast-sky-fill|--ast-sky-spackle|--ast-navy/);
  });

  it('returns the Ask hero headline to daylight ink', () => {
    expect(rule(ASK, '.ask-hero h2')).toMatch(/color:\s*var\(--ast-white\)/);
    expect(rule(ASK, `html${NOT_DARK} .ask-hero h2`)).toMatch(/color:\s*var\(--ast-text\)/);
  });

  it('recolours everything in the harness column that was white on the navy', () => {
    /*
     * A surface going from navy to white is not one declaration. Every ink inside
     * this column was chosen against the navy -- the heading and the metric figures
     * are `--ast-white`, the dividers and row borders are white at 12% and 18% --
     * and each is invisible or unreadable the moment the panel behind it is white.
     * These are the ones the column actually draws; the rest of it already reads
     * from theme-aware tokens.
     */
    for (const selector of [
      '.trace-title',
      '.trace-inspector .metric-row strong',
      '.trace-inspector .ast-flick-row-say',
    ]) {
      expect(rule(RAIL, `html${NOT_DARK} ${selector}`), `${selector} is still on-dark ink`).toMatch(
        /color:\s*var\(--ast-text\)/
      );
    }
    for (const selector of ['.trace-inspector .ast-flick-row', '.trace-inspector .trace-divider']) {
      expect(rule(RAIL, `html${NOT_DARK} ${selector}`), `${selector} keeps a white hairline`).toMatch(
        /var\(--ast-hairline\)/
      );
    }
    const emptyMark = rule(RAIL, `html${NOT_DARK} .trace-empty-mark`);
    expect(emptyMark).toMatch(/background:\s*var\(--ast-ice\)/);
    expect(emptyMark).toMatch(/color:\s*var\(--ast-blue\)/);
  });

  it('hands the run status pill back to its light families', () => {
    /*
     * The four `run-status--dark` rules mix each tone toward white for the navy,
     * which on white is a pale word on a paler wash -- the live one measured under
     * 2:1. The `--ast-*-text/-border/-fill` triples are the same tones' light rungs
     * and are what `.ast-pill` itself draws from, so this is the chip going back to
     * the shared recipe rather than getting a light treatment of its own.
     */
    expect(rule(RAIL, `html${NOT_DARK} .trace-inspector .run-status--dark.ast-pill--pos`)).toMatch(
      /color:\s*var\(--ast-pos-text\)/
    );
    expect(rule(RAIL, `html${NOT_DARK} .trace-inspector .run-status--dark.ast-pill--neg`)).toMatch(
      /color:\s*var\(--ast-neg-text\)/
    );
    expect(rule(RAIL, `html${NOT_DARK} .trace-inspector .run-status--dark.ast-pill--neutral-outline`)).toMatch(
      /color:\s*var\(--ast-neutral-text\)/
    );
    /* Live matches the outline family in daylight too — not a solid blue slab. */
    const live = rule(RAIL, `html${NOT_DARK} .trace-inspector .run-status--dark.is-live`);
    expect(live).toMatch(/background:\s*var\(--ast-fill-band\)/);
    expect(live).toMatch(/color:\s*var\(--ast-neutral-text\)/);
    expect(live).not.toMatch(/--ast-blue/);
  });
});

describe('the light answer sits on an opaque card', () => {
  it('remaps the pane token rather than restating a surface per partial', () => {
    /*
     * `--ast-pane` is 94% white at `:root` and the 6% is deliberate: the starfield
     * stays faintly present across whole panels. In daylight there is no sky behind
     * it, so those 6% let through whatever happens to be painted underneath -- which
     * is how the answer card came to look grey, and how a stale sky came to be
     * visible THROUGH it.
     *
     * One token rather than a rule per surface: the answer card, the question
     * bubble, the composer and the run-process panel all draw from it, so the remap
     * makes every one of them solid -- and a surface added to that set later is
     * solid in light mode without anybody remembering this file.
     */
    expect(rule(TOKENS, `html${NOT_DARK}`)).toMatch(/--ast-pane:\s*var\(--ast-white\)/);
    expect(rule(TOKENS, `html${NOT_DARK}`)).toMatch(/--ast-sky-fill:\s*var\(--ast-ice\)/);
    expect(rule(TOKENS, `html${NOT_DARK}`)).toMatch(/--ast-sky-spackle:\s*none/);
    expect(rule(TOKENS, ':root')).toMatch(/--ast-pane:\s*rgba\(255,\s*255,\s*255,\s*0\.94\)/);
    /* The card keeps reading the token -- answer.css is not ours to edit, and the
       point of doing this in a token is that it does not need to be. */
    expect(rule(ANSWER, '.answer-card')).toMatch(/background:\s*var\(--ast-pane\)/);
    /* No alpha anywhere in the light value, or a mis-mounted sky is visible again. */
    expect(rule(TOKENS, `html${NOT_DARK}`)).not.toMatch(/rgba|hsla|color-mix/);
  });

  it('leaves the dark answer frosted on the night sky', () => {
    /* The frost is the point in dark: the card is ON the sky and the sky is meant
       to be faintly present through it. Reduced transparency is answered in
       dark-mode.css, which is where that fallback belongs. */
    expect(rule(TOKENS, "html[data-theme='dark']")).toMatch(/--ast-pane:\s*rgba\(255,\s*255,\s*255,\s*0\.05\)/);
    expect(DARK).toMatch(/--ast-pane:\s*var\(--ast-surface-solid\)/);
  });
});

describe('one account of the run per theme, chosen in CSS', () => {
  it('shows the band in dark and the list everywhere else, with no third state', () => {
    /*
     * The pair has to be EXHAUSTIVE rather than merely disjoint. Written as
     * `[data-theme='light']` there would be an attribute value -- including none at
     * all -- that hid the band and never showed the list, and that state is the one
     * a reader would report as "the steps are gone".
     */
    expect(rule(CONSTELLATION, `html${NOT_DARK} .ast-sky-path`)).toMatch(/display:\s*none/);
    expect(rule(CONSTELLATION, `html${NOT_DARK} .ast-sky-map`)).toMatch(/display:\s*none/);
    expect(rule(CONSTELLATION, '.step-rail')).toMatch(/display:\s*none/);
    expect(rule(CONSTELLATION, `html${NOT_DARK} .step-rail`)).toMatch(/display:\s*flex/);
    expect(declarations(CONSTELLATION)).not.toContain("[data-theme='light']");
  });

  it('is the only mechanism: neither view is mounted conditionally', () => {
    /*
     * `display: none` is what keeps the hidden view out of the accessibility tree,
     * so the duplicate step buttons and the second live region are not merely
     * invisible -- they are not there. That is only true while BOTH views are
     * always rendered, which is the whole reason this is a CSS contract: a JS theme
     * read has a first frame to be wrong on, and Appearance previews the switch
     * without re-rendering this tree.
     */
    expect(code('AgentConstellation.tsx')).not.toMatch(/data-theme|appliedColorScheme|matchMedia/);
    expect(source('AgentConstellation.tsx')).toContain('<StepRail');
  });

  it('leaves the Run Explorer rail with one list rather than two', () => {
    /*
     * TraceDag draws the band above its own operable stage tiles, so in daylight
     * the tiles ARE the list and this one would be the same run printed twice in a
     * 264px column. Ask's harness has no tiles under the band, which is why it is
     * the surface that needed a light view at all.
     */
    expect(rule(CONSTELLATION, `html${NOT_DARK} .agent-path > .step-rail`)).toMatch(/display:\s*none/);
    expect(source('TraceDag.tsx')).toContain('className="agent-path"');
  });

  it('drops the login sky and the working constellation in daylight', () => {
    expect(rule(LOADERS, `html${NOT_DARK} .first-open.on-sky`)).toMatch(/background:\s*var\(--ast-ice\)/);
    expect(rule(LOADERS, `html${NOT_DARK} .ast-opening-wordmark`)).toMatch(/color:\s*var\(--ast-text\)/);
    expect(rule(LOADERS, `html${NOT_DARK} .ast-working-say`)).toMatch(/color:\s*var\(--ast-text\)/);
    expect(rule(LOADERS, `html${NOT_DARK} .ast-opening-sky`)).toMatch(/display:\s*none/);
    expect(rule(LOADERS, `html${NOT_DARK} .ast-working .ast-constellation`)).toMatch(/display:\s*none/);
  });

  it('writes every light rule in tokens rather than in colour', () => {
    /*
     * §7's rule, applied to the rules this change adds: a saturated value is
     * declared in a token block or it is not written at all. Asserted over every
     * light-conditional rule in all three files rather than over a list of the ones
     * that exist today, so a hex added to the next one fails here.
     */
    const rules = [
      ...lightRules(BASE),
      ...lightRules(RAIL),
      ...lightRules(CONSTELLATION),
      ...lightRules(TOKENS),
      ...lightRules(LOADERS),
      ...lightRules(STAR),
    ];
    expect(rules.length).toBeGreaterThan(10);
    for (const { selector, body } of rules) {
      expect(body, `${selector} writes a raw colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(body, `${selector} writes a raw colour`).not.toMatch(/\brgba?\(|\bhsla?\(/);
    }
  });
});

describe('the daylight list is the whole run, without a star in it', () => {
  it('gives every stage a row, by the same numbers the band draws', () => {
    const markup = railOf(inFlight, 5, 12_000);
    const labels = attrs(markup, 'aria-label').filter((label) => label.startsWith('Select step '));
    expect(labels).toHaveLength(inFlight.length);
    expect(labels[0]).toBe('Select step 01: Chose the next step');
    expect(labels[5]).toBe('Select step 06: Queried governed data');
    for (const stageRow of inFlight) expect(markup).toContain(stageRow.name);
  });

  it('marks the step the band is following, once, and says so to a screen reader', () => {
    /*
     * The same `shownIndex` the band rings, so the two views cannot disagree about
     * which step a reader has open. Two visible marks -- the blue edge and the ice
     * tint -- because selection may not be carried by colour alone, and
     * `aria-current` for the reader who has neither.
     */
    const markup = railOf(inFlight, 5, 12_000);
    expect(attrs(markup, 'aria-current')).toEqual(['step']);
    expect(markup).toContain('class="step-rail-pick selected current"');
  });

  it('prints the state and the figure a star could only carry as a colour', () => {
    /*
     * This is what "no stars in light" may not cost. On the band a step's state is
     * a glyph that beats, a ring, or a tint; a list has to say it. A completed step
     * says nothing, because "complete" beside a duration is a word spent saying the
     * row is an ordinary row.
     */
    const live = railOf(inFlight, 5, 12_000);
    expect(live).toContain('>running<');
    /* The caller's live elapsed on the step being worked on, and each finished
       step's own recorded duration -- never the browser's count printed beside a
       settled measurement. `railTiming` refuses the same substitution. */
    expect(live).toContain('>12s<');
    expect(live).toContain('>1.83s<');
    expect(live).toContain('>604ms<');
    expect(live).not.toContain('>complete<');

    const failed = railOf(
      [...inFlight.slice(0, 5), stage({ id: 'step-3-1-data_genie', name: 'Queried governed data', status: 'failed' })],
      -1
    );
    expect(failed).toContain('>failed<');
    expect(failed).toMatch(/class="step-rail-state neg"/);

    /* A run killed mid-step leaves a `running` stage nothing will ever complete,
       and printing "running" on it would be the list claiming a dead run is alive.
       The band's status line makes exactly this distinction. */
    const killed = railOf(inFlight, -1);
    expect(killed).toContain('>never reported<');
    expect(killed).not.toContain('>running<');
  });

  it('is operable as a list of buttons, with no role or tabindex written by hand', () => {
    /*
     * The band has to build its keyboard access out of `role="button"`, `tabIndex`
     * and a keydown handler, because a star is an SVG group. A row is an element
     * that already is a button: the tab order, the space and enter keys and the
     * focus ring all arrive with it, and none of them can drift out of step with
     * the click handler.
     */
    const markup = railOf(inFlight, 5, 12_000);
    expect([...markup.matchAll(/<button type="button"/g)]).toHaveLength(inFlight.length);
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('tabindex');
    /* The whole row is the target, not a glyph inside it. */
    expect(markup).toMatch(/<button type="button" class="step-rail-pick/);
  });

  it('draws no sky, no star, no connector and no sparkle', () => {
    /*
     * The requirement, read back off the markup rather than off the stylesheet. A
     * sparkle in daylight is a decoration that has lost its subject: there is no
     * night for a star to be a star on.
     *
     * `<image` is what the band uses for a product star -- a recoloured mark as a
     * data URL, drawn INTO the drawing. The list uses `BrandIcon`, which is the
     * same product's mark as an ordinary inline icon beside text, so the product
     * identity survives without the star that carried it.
     */
    const markup = railOf(inFlight, 5, 12_000);
    for (const star of [
      'ast-sky',
      'ast-star',
      'ast-link',
      'ast-anim',
      'ast-sky-dust',
      'ast-sky-canvas',
      'ast-sky-num',
      '<image',
      'viewBox="0 0 300',
    ]) {
      expect(markup, `the daylight list draws ${star}`).not.toContain(star);
    }
    expect(markup).toContain('class="brand-icon"');
  });

  it('says the same sentence about the run as the band, from the same string', () => {
    /*
     * One live region per view and one sentence behind both, so a light-mode reader
     * and a dark-mode reader are told the same thing about the step that just
     * landed. The list's copy is offscreen because its rows already carry the
     * sentence between them; the band's is visible because on the sky it is the
     * only text there is.
     */
    const sentence = 'Step 06 · Queried governed data';
    // AND THE FIGURE, which is the half the list's live region used to leave out.
    // The row a light reader can see carries the elapsed, and the band's own live
    // region announces it, so a list that announced only the sentence told a screen
    // reader less than its own page said and less than the dark view says.
    const elapsed = '12s';
    const rail = railOf(inFlight, 5, 12_000);
    const band = bandOf(inFlight, 5, 12_000);
    expect(rail).toContain(`<p class="sr-only" aria-live="polite">${sentence} · ${elapsed}</p>`);
    expect(band).toContain(`<span class="ast-sky-status-text">${sentence}</span>`);
    expect(band).toContain(`>${elapsed}</span>`);
  });

  it('leaves the dark band exactly as it was', () => {
    /*
     * The other half of the requirement. Nothing about the night sky changes: the
     * dust, the connectors, the stars, the numbers and the named group are all
     * still drawn, and the list is a sibling of that band rather than anything
     * nested in it.
     */
    const markup = bandOf(inFlight, 5, 12_000);
    expect(markup).toContain('<div class="ast-sky ast-sky-path">');
    expect(markup).toContain('<svg role="group" aria-label="Agent steps"');
    for (const part of ['ast-sky-dust', 'ast-links', 'ast-star-select', 'ast-sky-num', 'ast-star-ring']) {
      expect(markup, `the band lost ${part}`).toContain(part);
    }
    expect(markup).not.toContain('step-rail');
  });
});
