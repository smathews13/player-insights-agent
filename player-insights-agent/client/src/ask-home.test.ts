import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';
import { RUN_TONE_FAMILY } from './run-status';

/**
 * The ask home, the shell it sits in, and the two widths where the page reshapes.
 *
 * Asserted against the stylesheet and the component source rather than against a
 * rendered tree, because every claim below is a default rather than a calculation:
 * a column width, a breakpoint, whether a rule is present at all. None of it shows
 * up in a test of any function this page calls, and all of it is the kind of thing
 * a later restyle changes by eye without noticing what it was load-bearing for.
 *
 * The responsive half is the part worth having. Two of these rules exist because
 * the behaviour they describe was missing entirely: below 800px the conversation
 * rail was hidden with nothing in its place, and below 1180px so was the trace
 * inspector, taking the only route to the finished run with it. Both are one
 * `display: none` away from coming back, and neither would fail anything else.
 */

const STYLESHEET = stylesheet();
const RESPONSIVE = partial('responsive.css');
const RAIL = partial('rail.css');
const COMPOSER = partial('composer.css');
const HOME_PAGE = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const RUN_STATUS = readFileSync(new URL('run-status.ts', import.meta.url), 'utf8');

describe('the harness column stays reserved when there is no run', () => {
  it('does not collapse the shared track at idle', () => {
    expect(withoutComments(RAIL)).not.toMatch(
      /\.ask-layout\[data-inspector=['"]idle['"]\]\s*\{[^}]*--trace-width:\s*0px/
    );
    expect(withoutComments(COMPOSER)).toMatch(/right:\s*calc\(var\(--trace-width\)/);
  });

  it('does not hide the inspector at idle', () => {
    expect(withoutComments(RAIL)).not.toMatch(
      /\.ask-layout\[data-inspector=['"]idle['"]\] \.trace-inspector\s*\{[^}]*display:\s*none/
    );
  });

  it('is driven by the same condition the column draws its idle silhouette from', () => {
    expect(HOME_PAGE).toContain("const inspectorIdle = railStages.length === 0 && !loading;");
    expect(HOME_PAGE).toContain("data-inspector={inspectorIdle ? 'idle' : 'run'}");
  });
});

/** Comments stripped, so a width named in prose is not read as one in a query. */
function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * One rule's body, by exact selector.
 *
 * Matched on the whole selector rather than as a substring, so `.run-status` does
 * not answer for `.run-status.is-live`, which is the pair this file is about.
 */
function body(selector: string, css: string = STYLESHEET) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(css).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

/**
 * One rule's body when the selector may share a grouped rule.
 *
 * `body` above matches a rule of its own, which is the stricter claim and the
 * right one for the widths this file is mostly about. The dark surfaces below
 * are deliberately written as groups -- the whole point of them is that several
 * surfaces take one paint -- so they need the looser lookup.
 */
function groupedBody(selector: string, css: string) {
  for (const rule of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1].split(',').some((candidate) => candidate.trim() === selector)) return rule[2];
  }
  return '';
}

describe('dark transcript surfaces do not stack frosted panes', () => {
  const dark = partial('dark-mode.css');

  /*
   * A translucent pane inside a translucent pane is a lighter pane, and the run
   * process sits inside the answer card. Painting its timeline with the generic
   * 5% card fill was what put white slabs on the sky; only the tiles a reader
   * actually reads down keep a fill of their own.
   *
   * The rules are matched on the timeline's own classes rather than under
   * `.run-process`, because the same component is also drawn bare on the Run
   * Explorer's Timeline tab and a wrapper-scoped de-stack left that surface
   * stacking. Ask is still the surface this file is about, so what it asserts is
   * that Ask's nested timeline is covered by the shared rule.
   */
  it('lets the run timeline inherit the answer card surface', () => {
    for (const selector of [
      "html[data-theme='dark'] .trace-timeline",
      "html[data-theme='dark'] .trace-gantt",
    ]) {
      expect(groupedBody(selector, dark), `${selector} still paints its own pane`).toMatch(
        /background:\s*transparent[\s\S]*backdrop-filter:\s*none/
      );
    }
    expect(groupedBody("html[data-theme='dark'] .trace-kpi", dark)).toMatch(
      /background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)/
    );
    // The wrapper Ask draws it in, and the absence of a wrapper-scoped twin that
    // would quietly stop covering the second surface.
    expect(readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8')).toContain(
      'className="run-process"'
    );
    expect(withoutComments(dark)).not.toMatch(/\.run-process \.trace-(?:timeline|gantt|kpi)/);
  });

  it('draws a source table name as a tint rather than a white box', () => {
    // The neutral fill is white at 12% here, which around one word in a sentence
    // reads as a slab. The entity chips beside it are on 7%.
    expect(
      groupedBody("html[data-theme='dark'] .source-name-pill[data-tone='neutral'] .source-name-short", dark)
    ).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.07\)/);
  });
});

/** The contents of one `@media (max-width: Npx)` block. */
function atWidth(px: number, css: string = RESPONSIVE) {
  const source = withoutComments(css);
  const opened = source.indexOf(`@media (max-width: ${px}px)`);
  if (opened === -1) return '';
  let depth = 0;
  for (let at = source.indexOf('{', opened); at < source.length; at += 1) {
    if (source[at] === '{') depth += 1;
    if (source[at] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', opened) + 1, at);
    }
  }
  return '';
}

describe('the app shell measures what every sticky offset thinks it measures', () => {
  it('is the height the token names, rather than the sum of what is inside it', () => {
    // --app-header-h used to be `--logo-mark-size + 22px`, describing a stack of a
    // 3px brand rule, 9px of padding twice, a 30px mark and the bottom hairline.
    // That made the token a claim somebody had to keep true by hand against the
    // header's contents, and it was wrong once: the header stood at 58px while
    // every offset derived from the token said 52, and six pixels of the
    // transcript sat underneath it.
    //
    // §1 gives the bar as 52px, so the height is stated and the element is set to
    // it. The two cannot disagree, because they are one number.
    //
    // The horizontal inset is read through --app-header-pad-x rather than as a
    // literal 20px, because the header is not the only rule that depends on it:
    // the brand column is the rail's width less this inset, so the two are one
    // number.
    const tokens = partial('tokens.css');
    expect(tokens).toMatch(/--app-header-h:\s*52px/);
    expect(tokens).toMatch(/--app-header-pad-x:\s*20px/);
    const header = body('.app-header');
    expect(header).toMatch(/height:\s*var\(--app-header-h\)/);
    expect(header).toMatch(/padding:\s*0 var\(--app-header-pad-x\)/);
    // The blue rule across the top went with the arithmetic it was three pixels
    // of. The design reference's chrome has one border and it is the hairline
    // under the bar.
    expect(header).not.toMatch(/border-top:/);
  });

  it('draws the nav as tabs whose active state cannot move the label it marks', () => {
    // The underline is 2px, and it is reserved as transparent on the inactive tab
    // for the same reason the filter chips keep their border: becoming active must
    // not lift the row by two pixels.
    expect(body('.app-nav-tab')).toMatch(/border-bottom:\s*2px solid transparent/);
    expect(body(".app-nav-tab[aria-current='page']")).toMatch(/border-bottom-color:/);
  });

  it('reaches the header hairline by stretching to it rather than by being pulled back', () => {
    // The underline has to land on the header's bottom edge or it reads as a
    // misalignment rather than as a tab. It used to get there through a
    // `margin-block: -9px` that pulled the row back out through the header's own
    // padding; the header has no vertical padding now, so the row simply stretches
    // to the height the header states. One rule instead of two that had to agree.
    expect(body('.app-nav')).toMatch(/align-self:\s*stretch/);
    expect(body('.app-nav')).not.toMatch(/margin-block/);
  });
});

describe('the ask home is the geometry the mockup gives it', () => {
  it('gives the harness the width it is read at, and the mockup’s below that', () => {
    // The mockup is 264 / fluid / 264 and this used to require both, because two
    // equal columns put the hero and the composer -- centred in the middle column
    // -- on the window's own centre line. That is still true and it is no longer
    // the deciding fact: the inspector holds a constellation of the run, a tile per
    // step and a panel of what a step recorded, and at 264px its eyebrow wrapped
    // mid-phrase and its status line could not print a step's name. 340px on a wide
    // window, the mockup's 264px in the tight band, where the middle column is the
    // one with nothing to spare.
    //
    // The conversation column has MOVED into tokens.css and the inspector has not,
    // which looks inconsistent and is deliberate. This test used to require both on
    // .ask-layout, on the reasoning that tokens.css is shared and a page should
    // state what it uses. That reasoning assumed the rail's width was the ask
    // page's business alone. It is not any more: the header's brand column is sized
    // from it so the first nav tab begins on the rail's edge, and the header is not
    // inside .ask-layout, so it read the token while the rail read the override and
    // the two disagreed by 44px. The inspector's width is still nobody else's, so
    // it stays here.
    expect(partial('tokens.css')).toMatch(/--conversation-width:\s*340px/);
    expect(body('.ask-layout')).toMatch(/--trace-width:\s*340px/);
    expect(atWidth(1365)).toMatch(/--trace-width:\s*264px/);
  });

  it('changes column width at a width somebody chose, not continuously', () => {
    // The token was a clamp -- `clamp(220px, 15vw, 264px)` -- so the columns slid
    // with the window and reached the design's widths only past 1760px. That is a
    // third breakpoint system, invisible, disagreeing with the two this document was
    // just reduced to one of. Flat, and narrowed once, at 1180px.
    //
    // Asserted against tokens.css now rather than against .ask-layout, because that
    // is where the declaration lives; against .ask-layout it would pass by there
    // being no declaration there at all, which is a test that cannot fail.
    expect(partial('tokens.css')).not.toMatch(/--conversation-width:\s*clamp/);
    expect(atWidth(1180)).toMatch(/--conversation-width:\s*220px/);
  });

  it('holds the transcript off the rails by a token rather than by a retyped clamp', () => {
    // The reported defect was that the transcript's cards sat close enough to the
    // rail's hairline to read as touching it. The reason it was not a one-line
    // fix is the point of this test: `clamp(28px, 3.5vw, 64px)` was written out
    // five times across three partials -- the transcript's padding, the fixed
    // composer's two insets, and the composer's two again in the narrow band --
    // so the box a reader types into and the column it appears in lined up only
    // by having been retyped identically. That is the failure --app-header-pad-x
    // was made a token to prevent, one page over.
    expect(partial('tokens.css')).toMatch(/--conversation-inset:\s*clamp\(/);
    expect(body('.conversation-main')).toMatch(/padding:\s*56px var\(--conversation-inset\) var\(--composer-reserve\)/);
    expect(body('.composer')).toMatch(/left:\s*calc\(var\(--conversation-width\) \+ var\(--conversation-inset\)\)/);
    expect(body('.composer')).toMatch(/right:\s*calc\(var\(--trace-width\) \+ var\(--conversation-inset\)\)/);
    // And the narrow band's restatement, which is where a second literal would
    // most easily survive: the inspector is gone there, so only one of the two
    // insets is arithmetic on a rail and the other is bare.
    expect(atWidth(1180)).toMatch(/right:\s*var\(--conversation-inset\)/);
    // No copy of the old literal left anywhere. A single survivor is worse than
    // none of this, because it would be the one rule that stopped moving.
    expect(withoutComments(STYLESHEET)).not.toMatch(/clamp\(28px,\s*3\.5vw,\s*64px\)/);
  });

  it('reserves the composer its room from a token, and lets a scroll read the same one', () => {
    /*
     * The reported defect was that answer cards "clip behind various surfaces".
     * Nothing clipped. Two separate faults put an answer under a bar:
     *
     * The transcript reserved a flat 180px for a `position: fixed` composer,
     * which covers the composer at rest -- 105px of box floating 20px up -- and
     * not the composer holding an attachment chip and a parse notice.
     *
     * Worse, the reserve was a padding only, and `padding` is invisible to
     * `scrollIntoView`. HomePage ends a turn with `block: 'end'`, aligning the
     * transcript's end with the bottom of the scrollport, which is behind the
     * composer -- so the arithmetic being right would not have helped.
     *
     * One token, read by the padding and by `scroll-padding-bottom`, is what
     * makes the two agree by construction.
     */
    expect(partial('tokens.css')).toMatch(/--composer-reserve:\s*\d+px/);
    expect(body('html')).toMatch(/scroll-padding-bottom:\s*var\(--composer-reserve\)/);
    // And the top half of the same fault: an answer is scrolled in with
    // `block: 'start'`, which aligns its top edge with a scrollport that begins
    // behind the 52px sticky header. Every answer opened with its provenance
    // chip and the first line of its takeaway covered by the nav tabs.
    expect(body('html')).toMatch(/scroll-padding-top:\s*var\(--app-header-h\)/);
    expect(HOME_PAGE).toContain("block: 'start'");
    // The reserve has to clear the composer's own occupied height. It floats
    // 20px up and stands 105px tall at rest, so anything at or under that is a
    // reserve that hides the last rows of an answer at the end of every scroll.
    const reserve = Number(partial('tokens.css').match(/--composer-reserve:\s*(\d+)px/)?.[1] ?? 0);
    expect(reserve).toBeGreaterThan(125);
  });

  it('keeps the chrome translucent, and blurs it enough that prose cannot read through', () => {
    /*
     * Two faults, and the fix for the first caused the second.
     *
     * FIRST: in dark the header and the composer were `rgba(255, 255, 255, 0.03)`
     * with `backdrop-filter: blur(2px)`. Three percent of white is a tint and a
     * two-pixel Gaussian does not turn 13px type into a wash, so a reader could
     * READ the answer card through the nav tabs and through the box they type in.
     *
     * SECOND: making them `--ast-surface-solid` fixed that and put two
     * Settings-coloured slabs across the one screen the reader is always looking
     * at. That token belongs to surfaces that sit ON TOP of the app and have to
     * occlude it -- Settings, the drawers, a popover -- not to the chrome.
     *
     * So the fill is the rail's, exactly, and the BLUR is what does the
     * occluding. That keeps the chrome part of the night sky while still
     * destroying any type that passes behind it.
     *
     * THIRD, and the one that kept the report alive after both of the above
     * were fixed: the pair also carried `saturate(140%)`. What a reader sees
     * through a backdrop filter is the FILTER'S OUTPUT, so a correct
     * translucent fill bought nothing -- an 18px Gaussian flattens the stars
     * out of the #16202E sky and a 40% saturation boost turns that flat field
     * into a saturated blue band. The bar was a different colour from the page
     * behind it, which is exactly what "still solid blue" describes.
     */
    const dark = partial('dark-mode.css');
    for (const selector of ["html[data-theme='dark'] .app-header", "html[data-theme='dark'] .composer"]) {
      const rule = body(selector, dark);
      expect(rule, `${selector} shares the rail’s fill`).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)/);
      expect(rule, `${selector} is not the overlay slab`).not.toMatch(/var\(--ast-surface-solid\)/);
      // The number is the claim: 2px was the smear, and anything in this range
      // is past the point 13px type survives it.
      const blur = Number(rule.match(/backdrop-filter:\s*blur\((\d+)px\)/)?.[1] ?? 0);
      expect(blur, `${selector} blurs hard enough to occlude`).toBeGreaterThanOrEqual(12);
      // Blur softens what is behind the chrome. Any other filter function
      // RECOLOURS it, and the chrome's whole job is to be the same surface as
      // the page it sits on.
      expect(rule, `${selector} does not recolour the sky it sits on`).not.toMatch(/saturate|contrast|brightness|hue-rotate/);
    }
    // The panes beside the transcript are deliberately untouched. Asserted so
    // that "make the chrome opaque" is not later applied to the whole group,
    // which would flatten the night sky the design is built on.
    // Read off the grouped rule the three of them share, which `body()` cannot
    // address: it matches a selector standing alone before its brace.
    const group = withoutComments(dark).match(/([^{}]*\.conversation-rail[^{]*)\{([^{}]*)\}/);
    const [selectors, declarations] = [group?.[1] ?? '', group?.[2] ?? ''];
    expect(selectors, 'the inspector shares the rail’s rule').toContain('.trace-inspector');
    expect(selectors, 'and the composer no longer does').not.toContain('.composer');
    expect(declarations, 'the side panes stay frosted').toMatch(/backdrop-filter:\s*blur\(2px\)/);
  });

  it('spends less of the middle column on empty side gutters', () => {
    const inset = partial('tokens.css').match(/--conversation-inset:\s*clamp\(([^)]*)\)/)?.[1] ?? '';
    expect(inset, 'tokens.css declares --conversation-inset as a clamp').not.toEqual('');
    const [floor, rate, cap] = inset.split(',').map((part) => part.trim());
    expect(Number.parseInt(floor, 10)).toBe(16);
    expect(rate).toBe('1.25vw');
    // THE CAP IS THE PART THAT MATTERS. The floor and the rate only bind on a
    // narrow window; on the 1440px laptop most readers are on, the clamp resolves
    // near its top and that is where 72px of the middle column was going. The
    // answer card was reported as too narrow through two rounds of this token
    // being trimmed, so the cap is asserted as a ceiling rather than a literal:
    // anything above this and a decorative margin is beating the transcript for
    // width again.
    expect(Number.parseInt(cap, 10)).toBeLessThanOrEqual(24);
  });

  it('lets the transcript track fill, and centres the cards inside it', () => {
    expect(body('.conversation-main')).toMatch(/max-width:\s*none/);
    expect(body('.conversation-main')).toMatch(/width:\s*100%/);
    expect(withoutComments(partial('ask.css'))).toMatch(
      /\.conversation-main \.answer-card,\s*\.conversation-main \.plan-card\s*\{[^}]*max-width:\s*var\(--conversation-measure\)/
    );
  });

  it('lets the answer keep more measure than the box that prompts it', () => {
    // An answer carries tables, charts and a source list; a prompt is one line of
    // somebody's question. Capping them together at 720px would have been the
    // tidier-looking rule and it would have taken width off the thing being read.
    const measure = Number.parseInt(partial('tokens.css').match(/--conversation-measure:\s*(\d+)px/)?.[1] ?? '0', 10);
    expect(measure).toBeGreaterThan(720);
    // Wide enough for result tables; prose still lives inside surfaced cards and
    // truly wide tables retain their own horizontal scroller.
    expect(measure).toBeGreaterThanOrEqual(1100);
  });

  it('gives the headline and the empty-state composer one width to share', () => {
    // The in-conversation composer stretches between the rails. The empty state
    // still needs one centre line with the hero, so the 720px cap lives only
    // there — otherwise the first-ask box would become a second island.
    expect(body('.ask-hero')).toMatch(/max-width:\s*720px/);
    expect(body('.composer')).toMatch(/max-width:\s*none/);
    expect(body('.conversation-main.is-empty .composer')).toMatch(/max-width:\s*720px/);
    expect(body('.conversation-main.is-empty .composer')).toMatch(/margin-inline:\s*auto/);
  });

  it('makes the empty state a headline followed by an in-flow composer, with no suggestion cards', () => {
    /*
     * THE CARDS WERE NOT REPLACED BY BLANK SPACE. Their removal changes the
     * empty-state geometry: while there is no transcript and no load in flight,
     * the page marks the main column `is-empty` and returns the composer from its
     * fixed seat to normal flow directly under the headline. Once a question is
     * appended, that class leaves and the fixed transcript control comes back.
     *
     * Comments are stripped from both sources because ask.css deliberately keeps
     * the retired selector's name in the explanation of why it must stay gone.
     */
    const home = withoutComments(HOME_PAGE);
    const ask = withoutComments(partial('ask.css'));
    expect(home).toContain('const transcriptEmpty = messages.length === 0 && !loading && !conversationLoading;');
    expect(home).toContain("className={`conversation-main${transcriptEmpty ? ' is-empty' : ''}`}");
    expect(home).toContain('{transcriptEmpty && (');
    expect(body('.conversation-main.is-empty')).toMatch(/padding-bottom:\s*56px/);
    expect(body('.conversation-main.is-empty .composer')).toMatch(/position:\s*static/);
    expect(body('.conversation-main.is-empty .composer')).toMatch(/margin-top:\s*28px/);
    expect(home).not.toContain('prompt-grid');
    expect(ask).not.toContain('.prompt-grid');
  });

  it('leads the composer caveat with the mark, in a row that can hold one', () => {
    /*
     * The caveat's first word is the agent's name, so the drawing belongs against
     * it rather than somewhere else on the strip. The two assertions are a pair
     * and neither is sufficient: `.ast-mark` is `display: block`, so the mark in
     * an inline run of text would hang below the baseline it is supposed to sit
     * on -- the markup needs the strip's span to be a flex row, and the span is
     * ALSO the flexible spacer that puts the submit button hard right, so `flex`
     * has to survive whatever else is declared on it.
     *
     * The size is asserted because the prop and the painted size have to agree:
     * the mark drops its graduation ring below 32px and thickens its rim, so a
     * mark requested at one size and painted at another gets the wrong cut of the
     * drawing scaled to fit -- nothing looks broken, the graduations are just
     * wrong. Nothing in the stylesheet resizes this one, which is how they agree.
     */
    const home = withoutComments(HOME_PAGE);
    expect(home).toMatch(
      /<AstrolabeMark size=\{13\} \/>\s*astrolabe can make mistakes\. Sources and caveats are included\./
    );
    const caveat = body('.composer-actions > span');
    expect(caveat).toMatch(/display:\s*flex/);
    expect(caveat).toMatch(/align-items:\s*center/);
    expect(caveat).toMatch(/flex:\s*1/);
    expect(withoutComments(partial('composer.css'))).not.toMatch(
      /\.composer-actions\s*>\s*span\s+\.ast-mark[^}]*(width|height)/
    );
  });

  it('carries the agent’s mark on Ice, with no accent anywhere near it', () => {
    // §1: "agent-decision chips carry the small cut (22px chip, #F0F6FB fill)",
    // and §2 has no orange in it at all. This chip used to be a neutral outline
    // on oat holding the orange robot -- the one place on the screen where
    // orange as a legal mass and orange as an illegal hairline were a centimetre
    // apart. Both halves of that are gone: the fill is Ice, and the mark inside
    // it is the app's own.
    //
    // The mark's element states a size and no colour at all. A background
    // reappearing here would be a plate the mark cannot be seen through, which
    // is what it was before the robot: a filled orange square behind a white
    // sparkle.
    expect(body('.ask-hero-chip')).toMatch(/border:\s*1px solid var\(--ast-hairline\)/);
    expect(body('.ask-hero-chip')).toMatch(/background:\s*var\(--ast-ice\)/);
    expect(body('.ask-hero-chip')).not.toMatch(/orange|--db-warm/);
    expect(body('.ask-hero-chip-mark')).not.toMatch(/background|border/);
  });

  it('makes the composer one surface rather than a panel with an input in it', () => {
    // The field has no border of its own and the container has no padding, so the
    // footer strip below can be a band across the whole width instead of a rounded
    // rectangle floating in a white margin. `overflow: hidden` is what keeps the
    // strip's square corners inside the container's rounded ones, and the focus
    // ring is on the container so the whole thing reads as one control.
    const composer = body('.composer');
    expect(composer).toMatch(/padding:\s*0/);
    expect(composer).toMatch(/overflow:\s*hidden/);
    expect(body('.composer textarea')).toMatch(/border:\s*0/);
    expect(body('.composer:focus-within')).toMatch(/outline:\s*2px solid var\(--db-blue-600\)/);
  });

  it('names the inspector column before it names the list inside it', () => {
    // §4's inspector is "LIVE AGENT HARNESS", the pill, then the steps. The
    // column used to open on "Agent steps" with the pill beside it, so the one
    // thing that said what this rail was FOR was missing: a reader who had never
    // seen a run had a heading for an empty list and nothing telling them the
    // list was a live harness rather than a log.
    //
    // The string is a phrase in the source and capitals on screen. Typed in
    // capitals it would be handed to a screen reader as an acronym and read out
    // letter by letter, which is the same mistake as an em dash in a label: it
    // reads correctly only to the eye.
    expect(HOME_PAGE).toMatch(/const HARNESS_EYEBROW = 'Live agent harness'/);
    expect(HOME_PAGE).toMatch(/className="ast-eyebrow">\{HARNESS_EYEBROW\}/);
    expect(body('.ast-eyebrow')).toMatch(/text-transform:\s*uppercase/);
    // The pill sits on the eyebrow rather than on the heading, because what it
    // reports is whether the harness is live and not what the list holds.
    const head = HOME_PAGE.slice(HOME_PAGE.indexOf('<div className="trace-head">'));
    expect(head.indexOf('<RunStatusPill')).toBeLessThan(head.indexOf('</div>'));
    // Baseline, not centre: an 11px eyebrow centred against a 20px pill sits low.
    expect(body('.trace-head')).toMatch(/align-items:\s*baseline/);
    // The heading kept its size when it left the head row. A descendant selector
    // would have stopped matching it and taken the 16px with it silently.
    expect(body('.trace-title')).toMatch(/font-size:\s*18px/);
  });

  it('uses the entire harness rail as one navy panel', () => {
    const inspector = body('.trace-inspector');
    // `--ast-sky-fill`: the dark SURFACE token, which is a slightly lighter and
    // bluer dark than `--ast-navy`, the ink. Sam asked for the dark chrome to stop
    // reading as black; the ink stayed where the design handoff put it.
    expect(inspector).toMatch(/background:\s*var\(--ast-sky-fill\)/);
    expect(inspector).toMatch(/padding:\s*20px/);
    expect(inspector).toMatch(/gap:\s*14px/);
    expect(inspector).not.toMatch(/background:\s*var\(--background\)/);
    // AND THE STAR FIELD, WHICH IS WHAT PAINTS THE IDLE PANEL. `.trace-empty` has
    // no surface of its own, so a harness with no run in it is this element's
    // background and nothing else -- it was flat while the field lived only on the
    // page grid this column paints over.
    expect(inspector).toMatch(/background-image:\s*var\(--ast-sky-spackle\)/);

    const sky = body('.trace-inspector .ast-sky');
    // Transparent, so the column's one field runs behind the band rather than the
    // band tiling a second one of its own on top of it.
    expect(sky).toMatch(/background:\s*transparent/);
    expect(sky).toMatch(/border-radius:\s*0/);
  });

  it('keeps the completed run controls on the navy surface', () => {
    expect(body('.trace-inspector .metric-row')).toMatch(/grid-template-columns:\s*repeat\(2/);
    for (const label of ['Total time', 'Tool calls', 'Tokens', 'Slowest', 'Explore full run']) {
      expect(HOME_PAGE).toContain(label);
    }
    expect(HOME_PAGE).toContain('className="trace-explore w-full"');
    expect(HOME_PAGE).toContain('<ExternalLink aria-hidden="true" />');
  });

  it('separates what you type from what you press', () => {
    // THE HAIRLINE IS THE WHOLE SEPARATION NOW. This was a washed strip, and the
    // wash was a grey band across the bottom of the composer -- the most-seen band
    // in the app, because it is on screen before the reader has asked anything, and
    // it went with every other grey band on the sky. The rule stays; the fill does
    // not.
    const strip = body('.composer-actions');
    expect(strip).toMatch(/border-top:\s*1px solid var\(--db-line\)/);
    expect(strip).toMatch(/background:\s*transparent/);
    expect(strip).toMatch(/padding:\s*8px 8px 8px 16px/);
  });
});

describe('the run says which of four things it is doing', () => {
  // Live used to be a blank family so a solid blue mass could override the
  // recipe. That mass is the neon chip. Live now wears the same quiet outline
  // family as waiting; the word and the breathing dot still say it is in flight.
  const PAINTED = Object.entries(RUN_TONE_FAMILY).map(([tone, family]) => [
    tone,
    family ? `.${family}` : `.run-status.${tone}`,
  ]);

  it('states all four rather than leaving two of them to one Badge variant', () => {
    // `secondary` used to stand for "Ready" and for "Complete" both, so the start
    // of a run and the end of one were painted identically.
    for (const [tone, selector] of PAINTED) {
      expect(body(selector), `${tone} is painted by ${selector}`).not.toEqual('');
    }
    // Four distinct treatments rather than four names for two, which is the
    // defect the four tones were introduced to fix and which a bad family map
    // would quietly reintroduce.
    expect(RUN_TONE_FAMILY['is-live']).toBe('ast-pill--neutral-outline');
    expect(RUN_TONE_FAMILY['is-waiting']).toBe('ast-pill--neutral-outline');
    expect(new Set([RUN_TONE_FAMILY['is-ready'], RUN_TONE_FAMILY['is-failed'], RUN_TONE_FAMILY['is-live']]).size).toBe(3);
    // The chain that picks between them moved to `run-status.ts`, where it can be
    // called with each state rather than read for the strings it contains. The
    // page's own claim is now that it defers to it.
    expect(RUN_STATUS).toMatch(/tone: 'is-live'/);
    expect(RUN_STATUS).toMatch(/tone: 'is-failed'/);
    expect(HOME_PAGE).toMatch(/runStatusFor\(/);
  });

  it('changes nothing about the pill’s size when the run changes state', () => {
    // A pill that grows on going live moves the title beside it. Only colours are
    // allowed to differ between the four, which is checkable: any of padding,
    // border-width, font-size or line-height in a tone rule is a size. The
    // recipe states all four of those once, for every family at once, which is
    // most of why seating it beats restating it.
    for (const [tone, selector] of PAINTED) {
      expect(body(selector), `${tone} paints only colour`).not.toMatch(
        /padding|border-width|font-size|line-height|border:\s/
      );
    }
  });

  it('seats the app’s one status recipe rather than a second copy of it', () => {
    // §2 allows one status chip. This pill kept its own -- its own hairline, its
    // own radius, its own 11px -- against tokens the rebuild retires.
    expect(readFileSync(new URL('RunStatusPill.tsx', import.meta.url), 'utf8')).toMatch(/`ast-pill run-status /);
    const seat = body('.run-status');
    expect(seat).not.toMatch(/background|color|border|font-size|border-radius/);
    // What is left is the dot's lane and the fact that a status word may not be
    // squeezed or broken.
    expect(seat).toMatch(/flex:\s*none/);
    expect(seat).toMatch(/white-space:\s*nowrap/);
  });

  it('draws the working state as a quiet night-sky chip, not a solid blue mass', () => {
    // The conversation rail's "Live · step 03" and the harness's matching pill
    // were a filled `--ast-blue` slab with a white word. Complete / Partial /
    // Asked-by are outlined or quietly filled; Live now matches that register.
    // The ice-blue progress bar inside Working on it is a different surface and
    // is not this rule.
    expect(body('.run-status.is-live')).toMatch(/background:\s*var\(--ast-neutral-fill\)/);
    expect(body('.run-status.is-live')).toMatch(/color:\s*var\(--ast-neutral-text\)/);
    expect(body('.run-status.is-live')).not.toMatch(/--ast-blue/);
    expect(body('.run-status.is-live')).not.toMatch(/--db-orange/);
  });

  it('keeps evaluation out of the state that is waiting on the reader', () => {
    // "Approval needed" is the obvious place for amber and the wrong one: amber is
    // a judgement of a run, and a plan waiting for approval has not been judged.
    // The warn family IS the amber one, so this is now a claim about the map.
    expect(RUN_TONE_FAMILY['is-waiting']).not.toBe('ast-pill--warn');
    expect(body(`.${RUN_TONE_FAMILY['is-waiting']}`)).not.toMatch(/warn|amber|gold/);
  });
});

describe('the two marks that sign a transcript', () => {
  it('declares the agent’s mark once, so a card cannot draw the losing copy', () => {
    // shell.css declared it twice, at 32px and then again at 40px, and the second won
    // everywhere: answer.css corrected it back for its own two cards with a note
    // saying the real fix belonged in the shell, and the loading and clarification
    // cards were never corrected at all -- so the mark changed size between a turn
    // arriving and the same turn finishing.
    const declarations = withoutComments(partial('shell.css')).match(/(?:^|})\s*\.agent-avatar\s*\{/g) ?? [];
    expect(declarations.length).toBe(1);
    expect(body('.agent-avatar')).toMatch(/width:\s*32px/);
  });

  it('states the mark’s height as well as its width, and gives it the whole box', () => {
    // Width alone left the previous glyph 17 by 24, because lucide sets both as
    // attributes and CSS only replaced one: preserveAspectRatio then drew a 17px
    // glyph sitting a few pixels high in its own tile. Both are stated for that
    // reason, and both are the box's own 32px, because the clearance around this
    // mark is inside its window -- an inset here would shrink the figure a second
    // time, which is what made the old mark look lost in its tile.
    expect(body('.agent-avatar svg')).toMatch(/width:\s*32px/);
    expect(body('.agent-avatar svg')).toMatch(/height:\s*32px/);
  });

  it('outlines every reader question and leaves the full asker name visible', () => {
    // Every live, replayed, follow-up and plan-approval user turn reaches this one
    // role branch, so the class is the contract for all question surfaces.
    expect(HOME_PAGE).toMatch(/message\.role === 'user'[\s\S]{0,180}className="user-bubble"/);
    expect(body('.user-bubble')).toMatch(/border:\s*1px solid var\(--ast-blue-on-dark\)/);
    // 8/8/2/8, per the handoff. It was 14/14/3/14, and a 14px bubble beside an 8px
    // answer card reads as two different applications.
    expect(body('.user-bubble')).toMatch(/border-radius:\s*8px 8px 2px 8px/);
    // THE SKY'S PANE, which is the same token the answer card below it takes, and
    // the two earlier surfaces here are worth keeping apart because they failed for
    // different reasons. `rgba(245, 246, 248, 0.85)` was a light NEUTRAL: 15% of the
    // navy through a grey fill is the mid-grey slab Sam reported, and the fault was
    // the base colour as much as the alpha. Opaque `--ast-white` fixed the slab and
    // caused the next report: an opaque bubble directly above a translucent card is
    // what made the card read as grey. Pure white base, one shared alpha.
    expect(body('.user-bubble')).toMatch(/background:\s*var\(--ast-pane\)/);
    expect(body('.user-avatar')).toMatch(/max-width:\s*none/);
    expect(body('.user-avatar .identity-chip-text')).toMatch(/overflow:\s*visible/);
  });
});

describe('the owner filter chips are the one control that may not move when pressed', () => {
  const PRESSED = ".conversation-filter-chip[aria-pressed='true']";

  it('changes only colour between the two states, weight included', () => {
    // Spec §5.5 asks for fixed geometry between states, and weight is part of it:
    // this was 500 going to 600, so pressing a chip re-measured its own text and
    // nudged every chip after it along the wrapped row -- the failure being guarded
    // against is a second click landing on a different chip than the one aimed at.
    expect(body('.conversation-filter-chip')).toMatch(/font-weight:\s*500/);
    expect(body(PRESSED)).not.toMatch(/font-weight|padding|font-size|border-width|border:\s/);
  });

  it('keeps a border on both states so the box is the same size either way', () => {
    // The mockup's pressed chip has a fill and no border, which is a pixel narrower
    // than the outlined one beside it. The border goes to the fill colour instead.
    expect(body('.conversation-filter-chip')).toMatch(/border:\s*1px solid var\(--db-line-strong\)/);
    expect(body(PRESSED)).toMatch(/border-color:\s*var\(--db-chip\)/);
  });

  it('leaves blue in the rail for the row you are reading', () => {
    // The pressed chip was solid blue, which put a row of blue above the single blue
    // rule that marks the open conversation and made the two compete. A filter says
    // which subset is on screen, which is what the neutral chip fill means
    // everywhere else in the app.
    expect(body(PRESSED)).toMatch(/background:\s*var\(--db-chip\)/);
    expect(body(PRESSED)).not.toMatch(/--primary|blue/);
  });

  it('caps the wrapped block at three whole rows, measured off the chip', () => {
    // The cap was 84px under a comment claiming "roughly three rows", and roughly
    // was two pixels short of three: every rail with enough people to wrap carried
    // a permanent scrollbar and a sliver of a fourth row under the third. The
    // height is derived here rather than pinned, so a chip that changes padding,
    // border or type size fails this instead of quietly clipping again.
    const chip = body('.conversation-filter-chip');
    const px = (property: string) => Number(chip.match(new RegExp(`${property}:\\s*([\\d.]+)px`))![1]);
    const [padding] = chip
      .match(/padding:\s*([\d.]+)px/)!
      .slice(1)
      .map(Number);
    const [border] = chip
      .match(/border:\s*([\d.]+)px/)!
      .slice(1)
      .map(Number);
    const lineHeight = Number(chip.match(/line-height:\s*([\d.]+)/)![1]);
    const chipHeight = padding * 2 + border * 2 + px('font-size') * lineHeight;
    expect(chipHeight).toBe(26);

    const block = body('.conversation-filter');
    const gap = Number(block.match(/gap:\s*([\d.]+)px/)![1]);
    expect(block).toMatch(new RegExp(`max-height:\\s*${chipHeight * 3 + gap * 2}px`));
    // Scrolls past the cap rather than growing, which is what makes the cap a cap.
    expect(block).toMatch(/overflow-y:\s*auto/);
  });
});

describe('the inspector while a run is still going', () => {
  it('polls the small run record and reloads the transcript only when work finishes', () => {
    const reconnect = HOME_PAGE.slice(
      HOME_PAGE.indexOf('Follow a run whose original stream belonged to another view'),
      HOME_PAGE.indexOf('The rail, in one round trip rather than two')
    );
    const statusRead = reconnect.indexOf('readConversationRun(');
    const workingCheck = reconnect.indexOf('isWorkingConversationRun(status)');
    const transcriptRead = reconnect.indexOf('/messages');

    expect(statusRead).toBeGreaterThan(-1);
    expect(workingCheck).toBeGreaterThan(statusRead);
    expect(transcriptRead).toBeGreaterThan(workingCheck);
    expect(reconnect.match(/\/messages/g)).toHaveLength(1);
    expect(reconnect).not.toContain('Promise.all');
  });

  it('keeps the numbered constellation exclusively in the Live Agent harness', () => {
    // The answer pane reports live steps in text; only the inspector draws their
    // expanding numbered path.
    const answerPane = HOME_PAGE.slice(0, HOME_PAGE.indexOf('<aside className="trace-inspector">'));
    const harness = HOME_PAGE.slice(HOME_PAGE.indexOf('<aside className="trace-inspector">'));
    expect(answerPane).not.toContain('<AgentPathConstellation');
    expect(answerPane).not.toContain('<WorkingConstellation');
    expect(harness.match(/<AgentPathConstellation/g)).toHaveLength(1);
    expect(HOME_PAGE).not.toContain("import { WorkingConstellation } from './WorkingConstellation'");
  });

  it('marks a plan resolved as soon as its approval row is appended', () => {
    // Approval is a user row. `index !== lastAssistantIndex` therefore stayed
    // false until the final answer arrived and left Approve and run clickable
    // throughout the entire continuation.
    expect(HOME_PAGE).toContain('resolved={index < messages.length - 1}');
    expect(HOME_PAGE).not.toContain('resolved={index !== lastAssistantIndex}');
    // The approval's own user row, written once as a constant now: the card
    // reads the same sentence back to tell an approved plan from one that was
    // revised away. See plan-revision.test.ts.
    expect(HOME_PAGE).toContain("const PLAN_APPROVAL_LABEL = 'Approved the proposed analysis plan.';");
    expect(HOME_PAGE).toContain('label: PLAN_APPROVAL_LABEL,');
  });

  it('uses the constellation as its only run view before and after completion', () => {
    // The Ask rail keeps one representation across the run boundary. It mounts
    // the live path directly, so setting activeIndex to -1 after the answer lands
    // settles the constellation instead of revealing a second list underneath it.
    expect(HOME_PAGE).toContain("import { AgentPathConstellation } from './AgentConstellation'");
    expect(HOME_PAGE).not.toContain("import { TraceDag } from './TraceDag'");
    expect(HOME_PAGE).toMatch(/<AgentPathConstellation[\s\S]{0,180}activeIndex=\{railActiveIndex\}/);
    expect(HOME_PAGE).not.toMatch(/<TraceDag/);
    const view = HOME_PAGE.slice(
      HOME_PAGE.indexOf('<AgentPathConstellation'),
      HOME_PAGE.indexOf('/>', HOME_PAGE.indexOf('<AgentPathConstellation'))
    );
    expect(view).not.toContain('compact');
    expect(HOME_PAGE).toContain('<h3 className="trace-title">Agent path</h3>');
  });

  it('rings the newest step the run has announced, and never an envelope of it', () => {
    /*
     * THE REPORTED DEFECT: the ring and the band's status line sat on
     * "Step 01 · Orchestrator" while the run was around step seven.
     *
     * This used to prefer `runningStep`, on the reading that the step in progress
     * is a better answer than the frontier. They were the same row when that was
     * written. They are not: the run announces `orchestrator` and
     * `data_source_finder` before any step of it starts and reports neither until
     * the end, so "the step in progress" resolved to an envelope that is open from
     * the first event to the last. The frontier is the newest announcement, and it
     * is the only one of the two readings that moves.
     *
     * The `liveStages` guard is unchanged and still load-bearing: with no live
     * steps yet the rail falls back to the PREVIOUS answer's trace, so a mark
     * keyed on `loading` alone would light a card of a run that ended.
     */
    expect(HOME_PAGE).toMatch(
      /\(loading \|\| Boolean\(runStopped\)\) && liveStages\.length > 0 \? railStages\.length - 1 : -1;/
    );
    expect(HOME_PAGE).not.toMatch(/\(runningStep \|\| railStages\.length\) - 1/);
    // Still read, and still the number the pill's failure label needs: the step a
    // run DIED inside is a different claim from how far it got.
    expect(HOME_PAGE).toMatch(/const runningStep = runningStepNumber\(liveStages\);/);
    expect(HOME_PAGE).toMatch(/runningStep,/);
  });

  it('counts the step in progress off one clock, and stops it when the run ends', () => {
    // ONE TIMER FOR THE PAGE, which is the effect below rather than a timer per
    // row: `now` already ticks once a second and only while a run or an extraction
    // is going, so a finished run cannot be left counting by a component that kept
    // its own. The `loading` half of the guard is what makes that true of a run
    // that died mid-step, and `runningSince` is what makes it true between steps.
    expect(HOME_PAGE).toMatch(/const railElapsedMs = runningElapsed\(\{ loading, runningSince, now \}\);/);
    expect(HOME_PAGE).toMatch(/window\.setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
    expect(HOME_PAGE).toMatch(/if \(!parsing && !loading\) return;/);
    // THE INSTANT IS NOT THIS COMPONENT'S ANY MORE, and that is what makes the
    // clock survive leaving the page. It used to be cleared in five places here,
    // one of which was unmounting -- so a reader who came back to a run still in
    // flight got a counter that had been reset to nothing and a path to match.
    // The run is held in `live-ask.ts` now, which starts the count off the newest
    // announcement and stops it in `endLiveAsk`, so there is exactly one rule and
    // it is not tied to a mounted view. See live-ask-replay.test.ts.
    expect(HOME_PAGE).not.toMatch(/setRunningSince/);
    expect(HOME_PAGE).toMatch(/const runningSince = liveAsk\?\.runningSince \?\? null;/);
    // Every way a run can end passes through here, and unconditionally: a run
    // that ended while the reader was elsewhere must not still be counting when
    // they return.
    expect(HOME_PAGE).toMatch(/endLiveAsk\(runConversationId\);/);
    // Both surfaces read the same number, so they cannot disagree about how long
    // the reader has been waiting.
    expect(HOME_PAGE).toMatch(/<AgentPathConstellation[\s\S]{0,160}elapsedMs=\{railElapsedMs\}/);
    expect(HOME_PAGE).toMatch(/<LiveProgress[\s\S]{0,320}elapsedMs=\{railElapsedMs\}/);
  });

  it('hands every step to the registry rather than holding the run in its own state', () => {
    // THE RUN OUTLIVES THIS PAGE, so it is not kept here. Every value the live
    // path is drawn from used to be `useState` in this component: leaving Ask --
    // another tab, another conversation, anything that unmounts it -- threw the
    // steps away while the stream went on reporting them, and coming back showed
    // the question above a shut composer and a "Working on your question" row for
    // the rest of the run. The list, the merge and the clock are in `live-ask.ts`
    // now, keyed by conversation, and this page subscribes to the key it draws.
    expect(HOME_PAGE).toMatch(/const liveAsk = useLiveAsk\(conversationId\);/);
    expect(HOME_PAGE).toMatch(/const liveStages = liveAsk\?\.stages \?\? NO_LIVE_STAGES;/);
    expect(HOME_PAGE).not.toMatch(/useState<TraceStage\[\]>/);
    expect(HOME_PAGE).not.toMatch(/liveStagesRef/);
    expect(HOME_PAGE).not.toMatch(/setLiveStages/);
    // Recorded whatever is on screen. Both callbacks used to return early unless
    // the reader was still in the conversation the run started in, which dropped
    // every step that arrived after they moved -- including the ones they came
    // back for.
    expect(HOME_PAGE).toMatch(/onStage: \(stage\) => \{[\s\S]{0,40}recordLiveStage\(runConversationId, stage\);/);
    expect(HOME_PAGE).toMatch(/onOpen: \(\) => \{[\s\S]{0,40}openLiveAsk\(runConversationId\);/);
    // A new question replaces what the conversation had on record, which is what
    // clearing the list used to mean. The merge itself, and the one-row-per-id
    // guarantee behind it, are asserted in live-ask-replay.test.ts.
    expect(HOME_PAGE).toMatch(/beginLiveAsk\(\{ conversationId: runConversationId, question \}\);/);
  });

  it('promises no more steps under a band that is already drawing them', () => {
    // The design's footer line, removed with the rail's step tiles: "Steps appear
    // here as each one completes." explained the surface to the reader rather
    // than reporting on the run, and it sat under a constellation whose whole
    // subject is the chain arriving. The rule goes with the markup, so the class
    // cannot come back by being available.
    expect(HOME_PAGE).not.toMatch(/Steps appear here as each one completes/);
    expect(body('.trace-foot')).toBe('');
    expect(body('.trace-empty p')).toMatch(/font-size:\s*12px/);
  });

  it('counts no pause since the newest step, which was removed on purpose', () => {
    // live-progress.ts records why: a counter beside a step that is legitimately
    // slow reads as a stall, and this pane has no way to tell the two apart.
    expect(HOME_PAGE).not.toMatch(/Nothing new for/);
  });
});

describe('the inspector with nothing in it', () => {
  it('fills the idle pane with the still constellation, not AppKit Empty', () => {
    expect(HOME_PAGE).toContain('className="trace-idle-sky"');
    expect(HOME_PAGE).toContain('<ConstellationField shape={OPENING_CONSTELLATION} />');
    expect(HOME_PAGE).not.toMatch(/<EmptyMedia/);
    expect(withoutComments(RAIL)).toMatch(/\.trace-idle-sky\s*\{[^}]*z-index:\s*0/);
  });
});

describe('below 800px the conversation rail is somewhere else, not gone', () => {
  const NARROW = atWidth(800);

  it('replaces the column with a sheet in the same movement', () => {
    // Both halves in one query, so the page cannot end up with two rails or none.
    expect(NARROW).toMatch(/\.conversation-rail\s*\{\s*display:\s*none/);
    expect(NARROW).toMatch(/\.rail-sheet-trigger\s*\{\s*display:\s*inline-flex/);
  });

  it('keeps the trigger out of the grid above that width, and not merely invisible', () => {
    // The trigger is a child of `.ask-layout`, which is a three-column grid above
    // 800px. Anything short of `display: none` -- `visibility: hidden`, opacity,
    // a clip -- leaves it holding the middle cell and pushes the transcript into
    // the inspector's column.
    expect(body('.rail-sheet-trigger')).toMatch(/display:\s*none/);
  });

  it('leaves every rail action reachable from inside the sheet', () => {
    // Switching, creating, filtering and deleting were all unreachable below 800px:
    // the column was hidden and the sheet did not exist. One function draws both
    // copies, so a control added to the rail arrives in the sheet as well.
    expect(HOME_PAGE).toMatch(/const renderRail = \(scope: RailScope\)/);
    expect(HOME_PAGE).toMatch(/renderRail\('rail'\)/);
    expect(HOME_PAGE).toMatch(/renderRail\('rail-sheet'\)/);
  });

  it('scopes the entry ids, because both copies are in the document at once', () => {
    // The aside is hidden rather than unmounted, so an unscoped id would appear
    // twice and the sheet's delete control would take its description from the copy
    // the reader cannot see.
    expect(HOME_PAGE).toMatch(/function railTitleId\(conversationId: string, scope: RailScope\)/);
    expect(HOME_PAGE).toMatch(/aria-describedby=\{railTitleId\(conversation\.id, scope\)\}/);
  });

  it('lets the list inside the sheet scroll, which the sheet itself does not', () => {
    // AppKit's sheet content is `fixed ... flex flex-col gap-4` and sets no overflow
    // anywhere, so a conversation list longer than the viewport ran off the bottom of
    // a panel that could not scroll -- the same unreachability this sheet exists to
    // fix, four inches lower. `min-height: 0` is what lets a flex child shrink enough
    // to scroll at all.
    const sheeted = body('.conversation-rail.is-sheet');
    expect(sheeted).toMatch(/overflow-y:\s*auto/);
    expect(sheeted).toMatch(/min-height:\s*0/);
  });

  it('dismisses the sheet on the actions that answer the question it was opened to ask', () => {
    // Picking a conversation and starting one both close it, the same way the
    // header's nav sheet closes on choosing a page.
    expect(HOME_PAGE).toMatch(/setRailSheetOpen\(false\);\s*startNewConversation\(\);\s*focusQuestionInput\(\)/);
    expect(HOME_PAGE).toMatch(/setRailSheetOpen\(false\);\s*setSearchParams/);
  });
});

describe('below 1180px the finished run is still reachable', () => {
  const NARROW = atWidth(1180);

  it('swaps the inspector for the strip in one query', () => {
    expect(NARROW).toMatch(/\.trace-inspector\s*\{\s*display:\s*none/);
    expect(NARROW).toMatch(/\.trace-summary\s*\{\s*display:\s*flex/);
    // Hidden by default, so the strip and the column are never both on screen.
    expect(body('.trace-summary')).toMatch(/display:\s*none/);
  });

  it('carries the way into the run, which is what hiding the column took away', () => {
    expect(HOME_PAGE).toMatch(/className="trace-summary-link"/);
    expect(HOME_PAGE).toMatch(/Explore full run/);
  });

  it('says the lost-write disclosure in full in both places rather than twice differently', () => {
    // The inspector held the only copy, and `display: none` took it off the screen
    // at exactly the widths where the reader most needs it. One constant, two sites,
    // so the strip cannot end up with a shortened version of a sentence whose job
    // is to say the answer on screen will not be here tomorrow.
    expect(HOME_PAGE).toMatch(/const RUN_NOT_STORED =/);
    expect(HOME_PAGE).toMatch(/will not be here when you \s*'?\s*\+?\s*'?come back/);
    expect(HOME_PAGE.match(/RUN_NOT_STORED/g)?.length).toBe(3);
  });

  it('moves the nav at the same width, rather than 100px later than the column beside it', () => {
    // Tailwind's `xl` was deciding the nav and these queries were deciding the
    // layout, so the two disagreed by 100px and neither had been chosen.
    expect(NARROW).toMatch(/\.app-nav\s*\{\s*display:\s*none/);
    expect(NARROW).toMatch(/\.mobile-nav\s*\{\s*display:\s*block/);
  });

  it('insets the composer off the rail it is beside rather than off a second guess at it', () => {
    // The rail narrows to 220px here and the composer's left inset was the literal
    // 250px, so the two disagreed by 30px and only one of them knew the width.
    expect(NARROW).toMatch(/left:\s*calc\(var\(--conversation-width\)/);
    expect(NARROW).not.toMatch(/left:\s*\d+px/);
  });
});

describe('there is one set of breakpoints, and this is it', () => {
  it('reshapes at 480, 800, 1180 and 1366 and at no other width', () => {
    // Two systems were live: Tailwind's md/xl on utilities in Layout.tsx and these
    // hand-written queries. The chip left the header 32px before the rail left the
    // page, and the nav collapsed 100px after it. A fifth width appearing here is
    // how that starts again.
    const widths = [...withoutComments(RESPONSIVE).matchAll(/@media \(max-width: (\d+)px\)/g)].map((match) =>
      Number(match[1])
    );
    expect([...new Set(widths)].sort((a, b) => a - b)).toEqual([480, 800, 1180, 1365]);
  });

  it('states them largest first, so a narrower rule always overrides the wider one', () => {
    const widths = [...withoutComments(RESPONSIVE).matchAll(/@media \(max-width: (\d+)px\)/g)].map((match) =>
      Number(match[1])
    );
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
  });

  it('keeps the structural decisions out of the utilities that used to make half of them', () => {
    const layout = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
    // The responsive utilities are what disagreed with this file. The classes that
    // replaced them are switched here, in one place, and named for what they are.
    expect(layout).not.toMatch(/\b(md|lg|xl|2xl):(hidden|flex|block)/);
  });
});
