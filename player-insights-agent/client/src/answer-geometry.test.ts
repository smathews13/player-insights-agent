import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';

/**
 * The transcript's three cards, at the measurements the design gives them.
 *
 * Asserted against the source and the stylesheet, for the reason
 * message-selection.test.ts and palette.test.ts are: every claim here is a
 * painted pixel and this repo has no browser. What that buys is real but
 * narrow -- it proves the rules exist, that they say what the handoff says,
 * and that a later edit which quietly reverts one will fail. It cannot prove
 * the result looks right, and nothing in this file should be read as saying
 * anyone has seen it.
 *
 * The claims worth pinning are the ones that were wrong for a reason rather
 * than by a pixel: a value printed on the fill it has to be read against, a
 * delta coloured green because its text did not begin with a hyphen, a
 * provenance chip in the colour of a button.
 */
const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
/**
 * The card's copy with its comments removed, for the assertions about what the
 * card may not SAY. The comments explain at length what a sentence used to claim
 * and why it stopped, so a check for a forbidden phrase run over the whole file
 * fails on the explanation of the fix.
 */
const PROSE = CARD.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
const PLAN = readFileSync(new URL('./PlanCard.tsx', import.meta.url), 'utf8');
const CHARTS = readFileSync(new URL('./AnswerCharts.tsx', import.meta.url), 'utf8');
const ANSWER_CSS = partial('answer.css');
const BODY_CSS = partial('answer-body.css');
const SHELL_CSS = partial('shell.css');
const STYLESHEET = stylesheet();

/**
 * The body of the rule whose selector list starts a line with `selector`.
 *
 * The same helper answer-markdown.test.ts uses, and it has the same limit: it
 * finds the FIRST such rule. Where a selector is declared in two partials the
 * caller has to say which file it means, which is why the two are read
 * separately above as well as concatenated.
 */
function ruleFor(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector}`);
  expect(at, `${selector} is declared`).toBeGreaterThan(-1);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

const TOKENS = partial('tokens.css');
const RAIL_CSS = partial('rail.css');
/** Where every structural width in this app narrows. See breakpoints.test.ts. */
const RESPONSIVE_CSS = partial('responsive.css');

/** One declaration's value, by custom-property or property name. */
function declaration(source: string, name: string): string {
  const value = source.match(new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`))?.[1];
  expect(value, `${name} is declared`).toBeDefined();
  return (value as string).trim();
}

/** The first pixel length in a value, as a number. */
function pixels(value: string): number {
  const raw = value.match(/(-?[\d.]+)px/)?.[1];
  expect(raw, `${value} carries a pixel length`).toBeDefined();
  return Number.parseFloat(raw as string);
}

/**
 * The inspector's width at one window width, media query included.
 *
 * Read rather than restated for the same reason every other term here is, and
 * RESOLVED rather than taken from the base declaration alone: the rail is 340px on
 * a wide window and hands the 76px back in responsive.css's tight band, so a model
 * that read only rail.css would compute the transcript 76px narrower than a laptop
 * actually gets it and fail this file's own claim about a readable column.
 */
function traceWidth(window_: number): number {
  const narrowed = [...RESPONSIVE_CSS.matchAll(/@media \(max-width: (\d+)px\)([\s\S]*?)\n\}/g)]
    .filter(([, bound]) => window_ <= Number(bound))
    .map(([, , band]) => band.match(/--trace-width:\s*(\d+)px/)?.[1])
    .find((found): found is string => found !== undefined);
  return narrowed === undefined ? pixels(declaration(RAIL_CSS, '--trace-width')) : Number(narrowed);
}

/** `clamp(<a>px, <n>vw, <b>px)` resolved against one window width. */
function clampVw(value: string, window_: number): number {
  const [low, vw, high] = [...value.matchAll(/([\d.]+)(?:px|vw)/g)].map((match) => Number(match[1]));
  return Math.min(Math.max(low, (vw / 100) * window_), high);
}

/**
 * The width `.bar-row` is laid out in, inside a window `window_` px wide.
 *
 * Every term is read from the stylesheet the layout is built from rather than
 * restated, because the point of the assertion this feeds is that a number in
 * that stylesheet resolves to a readable column -- a copy of the number here
 * would agree with itself after somebody changed one of them.
 */
function barRowWidth(window_: number): number {
  const column = window_ - pixels(declaration(TOKENS, '--conversation-width')) - traceWidth(window_);
  const inset = clampVw(declaration(TOKENS, '--conversation-inset'), window_);
  // The transcript stops widening at its stated measure and the surplus becomes
  // margin, so past about 1500px this is the only term that still moves.
  const transcript = Math.min(column - inset * 2, pixels(declaration(TOKENS, '--conversation-measure')));
  const cardInset = pixels(
    declaration(ruleFor(ANSWER_CSS, ".answer-card > [data-slot='card-header'],"), 'padding-inline')
  );
  const panelInset = pixels(
    declaration(ruleFor(BODY_CSS, ".chart-card > [data-slot='card-header'],"), 'padding-inline')
  );
  // Both cards are `box-sizing: border-box` with a 1px border, which is 2px of
  // the row each and is the size of the fault this whole block is about.
  return transcript - 2 - cardInset * 2 - 2 - panelInset * 2;
}

/**
 * The four `.bar-row` track widths, in px, for a row `width` px wide.
 *
 * CSS Grid §12.7 as far as this row uses it: the non-flexible track is sized to
 * its cap, then the fr unit is found against what is left -- freezing any
 * flexible track whose floor is above its share and starting again, which is the
 * step that decides this row and the one no assertion about shares can see.
 */
function resolveBarRow(width: number): number[] {
  const row = ruleFor(BODY_CSS, '.bar-row {');
  const tracks = [
    ...declaration(row, 'grid-template-columns').matchAll(/minmax\(([\d.]+)px,\s*([\d.]+)(px|fr)\)/g),
  ].map((match) => ({ floor: Number(match[1]), limit: Number(match[2]), flexible: match[3] === 'fr' }));
  expect(tracks, 'four minmax tracks').toHaveLength(4);
  const gap = Number(declaration(row, 'gap').match(/[\d.]+px\s+([\d.]+)px/)![1]);

  const rigid = tracks.filter((track) => !track.flexible);
  let pool = width - gap * (tracks.length - 1) - rigid.reduce((total, track) => total + track.limit, 0);
  let flexible = tracks.filter((track) => track.flexible);
  let unit = 0;
  // Freeze, recompute, repeat -- a frozen track's floor leaves the pool before
  // the tracks still competing for it are sized.
  for (;;) {
    const shares = flexible.reduce((total, track) => total + track.limit, 0);
    unit = pool / Math.max(shares, 1);
    const starved = flexible.find((track) => track.limit * unit < track.floor);
    if (!starved) break;
    pool -= starved.floor;
    flexible = flexible.filter((track) => track !== starved);
    if (flexible.length === 0) break;
  }
  const resolved = unit;
  return tracks.map((track) =>
    track.flexible ? Math.max(track.floor, flexible.includes(track) ? track.limit * resolved : 0) : track.limit
  );
}

describe('the answer and plan cards sit on the design’s scale, not the library’s', () => {
  it('takes the one card radius and no shadow', () => {
    // 8px is the card radius and 4px the control radius; there is no third, and
    // AppKit's 12px was one. The shadow went with the page gradient -- a card
    // that floats over a flat white page reads as a dialog.
    for (const selector of ['.answer-card {', '.plan-card {']) {
      expect(ruleFor(ANSWER_CSS, selector)).toContain('border-radius: var(--ast-radius-card)');
      expect(ruleFor(ANSWER_CSS, selector)).toContain('box-shadow: none');
    }
  });

  it('closes the gap between sections to the design’s 16px', () => {
    // The difference between a card holding ten sections and a card holding ten
    // pages. AppKit's own value is 24px, and the answer card has ten of them.
    expect(ruleFor(ANSWER_CSS, '.answer-card,')).toContain('gap: 16px');
  });

  it('draws the agent’s mark at 32px, from the shell’s one declaration', () => {
    // shell.css used to declare .agent-avatar twice, at 32px and then at 40px, and
    // the second won -- so this file corrected it back for the two cards it owns,
    // with a note saying the real fix belonged in the shell. It was made there,
    // and the override went with it rather than staying as a second opinion about
    // a size only one file should hold.
    //
    // The shell's declaration reaches all of them: every mark in the transcript
    // sits inside .answer-card or .plan-card, including the loading card and the
    // clarification card, which the scoped override never covered and which had
    // been drawing the 40px mark all along.
    const shell = ruleFor(SHELL_CSS, '.agent-avatar {');
    expect(shell).toContain('width: 32px');
    expect(shell).toContain('height: 32px');
    // And it is not restated here, which is what made the mark change size
    // between a turn arriving and the same turn finishing.
    expect(ANSWER_CSS).not.toMatch(/\.agent-avatar[^{]*\{[^}]*(width|height):\s*32px/);
  });

  it('sizes the takeaway as a card heading and not as a hero', () => {
    // 18px/700. It was a clamp to 28px on a page whose own h2 is 22px, so the
    // one sentence in the card out-shouted the page it was on.
    const rule = ruleFor(ANSWER_CSS, '.answer-takeaway {');
    expect(rule).toContain('font-size: var(--ast-fs-18)');
    expect(rule).toContain('font-weight: 700');
    expect(rule).toContain('line-height: 1.35');
  });
});

describe('the provenance chip has three tones and none is the action colour', () => {
  it('states a live answer as the ink fill', () => {
    const rule = ruleFor(ANSWER_CSS, ".provenance-chip[data-tone='live'] {");
    expect(rule).toContain('background: var(--ast-navy)');
    expect(rule).toContain('color: var(--ast-white)');
  });

  it('separates a half-stored answer from a wholly stored one', () => {
    // THE THIRD TONE, AND THE REASON FOR IT. Both used to be `destructive`,
    // because the chip was coloured from AppKit's `variant` and that has no rung
    // between fine and failure. So an answer whose narrative is live and whose
    // figures are stored wore the same chip as one where nothing ran at all --
    // and a reader has to do different things about those. The first is an
    // answer to their question with numbers that are not theirs; the second is
    // not an answer to their question.
    //
    // Warning tinted for mixed, because it qualifies the answer under it and a
    // solid mass above a heading reads as a refusal. Negative SOLID for stored,
    // which is the one filled chip in the app and is the design reference's own
    // drawing at 11ar: #A04A62 is 5.93:1 with white on it, so the label is still
    // type at 11px.
    const mixed = ruleFor(ANSWER_CSS, ".provenance-chip[data-tone='mixed'] {");
    expect(mixed).toContain('background: var(--ast-warn-fill)');
    expect(mixed).toContain('border: 1px solid var(--ast-warn-border)');
    expect(mixed).toContain('color: var(--ast-warn-text)');

    const stored = ruleFor(ANSWER_CSS, ".provenance-chip[data-tone='stored'] {");
    expect(stored).toContain('background: var(--ast-neg-text)');
    expect(stored).toContain('color: var(--ast-white)');
    expect(stored, 'the two are not the same chip').not.toContain('var(--ast-warn-fill)');
  });

  it('is never blue, because a blue pill above a heading reads as a control', () => {
    for (const tone of ['live', 'mixed', 'stored']) {
      const rule = ruleFor(ANSWER_CSS, `.provenance-chip[data-tone='${tone}'] {`);
      expect(rule, `the ${tone} chip`).not.toMatch(/--db-blue|--ast-blue|--primary|#2272b4/i);
    }
  });

  it('leaves which chip appears to the module that reads what the server stated', () => {
    // The most serious defect this card can ship is a chip that is wrong about
    // where a figure came from, so the tone is derived from the decision rather
    // than chosen beside it: one call drives the label, the variant and the
    // attribute the stylesheet keys on. A literal label here would be a second
    // opinion about provenance living in the presentation layer.
    expect(CARD).toContain('const badge = answerBadge(answer);');
    expect(CARD).toContain('<Badge variant={badge.variant} className="provenance-chip" data-tone={badge.tone}>');
    expect(CARD).toContain('{badge.label}');
  });
});

describe('the result breakdown gives every figure a column of its own', () => {
  it('is the design’s four columns, and not one of them is a fixed width', () => {
    // Three of the four were: 150px for the label, 70px for the value, 60px for
    // the comparison. The agent does not write to a fixed width, and a live run
    // put "Most granular: one row per transaction with SKU detail" in the first
    // and a sentence in the last -- 60px is narrower than the word
    // "transaction", so the wrapping rule above split the word in half and the
    // reader got a right-aligned ribbon two words wide.
    //
    // Asserted as four minmax tracks rather than as a literal, because the
    // numbers will be tuned and the property that must not be tuned away is
    // that every column has a floor and a share.
    const rule = ruleFor(BODY_CSS, '.bar-row {');
    const tracks = rule.match(/grid-template-columns:([^;]+);/)![1].trim();
    expect(tracks.match(/minmax\(/g)).toHaveLength(4);
    expect(tracks, 'no track is a bare pixel width').not.toMatch(/(^|\s)\d+px(\s|$)/);
  });

  it('leaves the four floors inside the narrowest column the row is laid out in', () => {
    // The floors are what keep `overflow-wrap: anywhere` out of reach, so they
    // want to be generous, and they are also the row's minimum width, so they
    // want to be small. The bound is the transcript column just above 800px --
    // 220px of rail, 28px of page padding either side, then the card's 28px and
    // the chart panel's 16px -- which leaves about 433px. Past that a desktop
    // grows a horizontal scrollbar, which is the one outcome worse than the
    // crowding this changed.
    const tracks = ruleFor(BODY_CSS, '.bar-row {').match(/grid-template-columns:([^;]+);/)![1];
    const floors = [...tracks.matchAll(/minmax\((\d+)px/g)].map((match) => Number(match[1]));
    const gap = Number(ruleFor(BODY_CSS, '.bar-row {').match(/gap:\s*\d+px\s+(\d+)px/)![1]);
    expect(floors).toHaveLength(4);
    expect(floors.reduce((total, floor) => total + floor, 0) + gap * 3).toBeLessThanOrEqual(433);
    // And the other half of the bound: each of the three columns that receives
    // text still clears an ordinary English word at 13px, which is around 70px
    // and is exactly what the 60px comparison column did not. The second track
    // is the bar, and its floor is a bar's minimum rather than a word's.
    for (const at of [0, 2, 3]) expect(floors[at], `track ${at + 1}`).toBeGreaterThanOrEqual(72);
  });

  it('gives the description more of the row than the label, so the bars start early', () => {
    // Reported as "the description column is too narrow and wraps awkwardly".
    // The floors were not the problem by then; the shares were. The label had
    // 2.4 of 4.8 and the description 1.6, so on a wide card the bars began a
    // third of the way across while the sentence on the right broke into a
    // ribbon. The label is the shortest text in the row on nearly every answer.
    const tracks = ruleFor(BODY_CSS, '.bar-row {').match(/grid-template-columns:([^;]+);/)![1];
    const shares = [...tracks.matchAll(/([\d.]+)fr/g)].map((match) => Number(match[1]));
    expect(shares, 'the label, the value and the description take shares').toHaveLength(3);
    const [label, , description] = shares;
    expect(description).toBeGreaterThan(label);
  });

  it('resolves the description to a readable width, and not just to a large share', () => {
    // THE THIRD REPORT OF THIS ROW, AND THE REASON THE TWO ABOVE SURVIVED IT.
    // Every assertion in this file up to here reads the stylesheet and reasons
    // about it: four minmax tracks, floors inside a bound, the description's
    // share larger than the label's. All three were true while the description
    // was still coming out at 182px on an ordinary window and still wrapping,
    // because a share is not a width. The value column's floor sits above its
    // share on every window narrower than about 1500px, so it is frozen at that
    // floor and the difference comes out of the pool BEFORE the description is
    // sized -- which no assertion about shares can see.
    //
    // So this one does the arithmetic. `resolveBarRow` is CSS Grid §12.7, which
    // is short enough to write out: size the non-flexible tracks to their caps,
    // then find the fr unit against what is left, freezing any flexible track
    // whose floor is above its share and starting again. The widths below are
    // the ones the row is actually laid out in, taken from the same tokens the
    // layout is built from rather than from a guess.
    // 1366 is in the list because it is the WORST case rather than a round
    // number: it is the narrowest window that gives the harness rail its full
    // 340px, one pixel above the band where responsive.css hands 76px of that
    // back, so it is where a wider rail would show up as an unreadable row first.
    for (const [window_, floor] of [
      [1280, 220],
      [1366, 220],
      [1920, 350],
    ] as const) {
      const [label, bar, value, description] = resolveBarRow(barRowWidth(window_));
      expect(description, `the description at ${window_}px`).toBeGreaterThanOrEqual(floor);
      // And it is the widest thing in the row wherever there is room to choose,
      // which is the shape the reported one did not have: a sentence narrower
      // than the label above it, beside a bar with room to spare.
      expect(description, `the description outsizes the label at ${window_}px`).toBeGreaterThan(label);
      expect(description, `the description outsizes the value at ${window_}px`).toBeGreaterThan(value);
      expect(bar, 'the bar is capped rather than given a share').toBeLessThanOrEqual(64);
    }
  });

  it('stops competing for width the row does not have, rather than redividing it', () => {
    // THE FOURTH REPORT OF THIS ROW, AND WHY THE THREE FIXES ABOVE DID NOT END
    // IT. Each of them redivided the row -- shares moved, the bar's cap came
    // down, the floors were retuned -- and each bought the description forty
    // pixels on a wide window and nothing at all on a narrow one. The reason is
    // arithmetic rather than taste: the four floors are 386px and the gaps
    // another 42, against a row that is about 433px with both rails up, so at
    // that end the description is AT its floor whatever share it holds. There is
    // no readable measure left in 433px to redivide.
    //
    // So below the width at which the four tracks can seat a sentence, the row
    // becomes two lines and the description takes the whole of the second. This
    // asserts the mechanism and then the arithmetic behind the threshold, and it
    // fails against the stylesheet as it stood: there was no container, no query
    // and no second form, so every clause below is new behaviour rather than a
    // tightened number.
    const chart = ruleFor(BODY_CSS, '.bar-chart {');
    // A CONTAINER QUERY AND NOT A MEDIA QUERY, which is the whole of why the
    // mobile override in responsive.css never reached this report. This panel
    // sits inside a card inside a transcript column whose width is the window
    // minus the conversation rail, minus the trace rail, minus two page insets
    // and two card insets -- any of which can be absent. Two readers at 1280px
    // can have rows hundreds of pixels apart, so the viewport is the wrong box
    // to ask.
    expect(chart).toContain('container-type: inline-size');
    expect(chart).toContain('container-name: breakdown');

    const query = BODY_CSS.match(/@container breakdown \(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/);
    expect(query, 'the narrow form is declared').not.toBeNull();
    const [, threshold, narrow] = query!;
    // Three across, then the sentence spanning the row underneath it.
    expect(narrow).toMatch(/grid-template-columns:[^;]*\)\s+auto;/);
    expect(narrow).toContain('grid-column: 1 / -1');

    // And the threshold is the width at which the wide form resolves the
    // description to a readable measure, recomputed from the very tracks above
    // rather than restated. 260px is about forty characters at 13px and is the
    // point below which the agent's sentences begin breaking mid-clause. Moving
    // a share moves what this number means, and this is what says so.
    const READABLE = 260;
    expect(resolveBarRow(Number(threshold))[3]).toBeGreaterThanOrEqual(READABLE);
    // One pixel narrower and the four-track form is already below it, so the
    // threshold is the crossing point and not a round number near one.
    expect(resolveBarRow(Number(threshold) - 1)[3]).toBeLessThan(READABLE);
  });

  it('refuses to break a figure mid-number, wherever it appears in the row', () => {
    // The exact line a reader was shown: "1.81% (~2,833" then "rows)" on the
    // next line, the thousands separator doing the work of a line break. Both
    // columns inherit `overflow-wrap: anywhere` from the card's content slot,
    // which is right for a table name and wrong for a number, so both refuse
    // it. A number that breaks has to be re-read to be believed.
    for (const selector of ['.bar-row b {', '.bar-row em {']) {
      const rule = ruleFor(BODY_CSS, selector);
      expect(rule, selector).toContain('overflow-wrap: normal');
      expect(rule, selector).toContain('word-break: normal');
    }
  });

  it('pads and rules the rows the way the app’s own tables do', () => {
    // benchmark.css sets a data cell at 8px vertical and 16px horizontal, and
    // this block is a table in everything but markup. The gap replaces the
    // container's, which is why .bar-chart has none: two sources for one piece
    // of spacing is how the hairline ended up floating between two voids.
    const rule = ruleFor(BODY_CSS, '.bar-row {');
    expect(rule).toMatch(/padding-block:\s*8px/);
    expect(ruleFor(BODY_CSS, '.bar-chart {')).toMatch(/gap:\s*0/);
    expect(ruleFor(BODY_CSS, '.bar-row + .bar-row {')).toContain('border-top: 1px solid var(--ast-hairline)');
  });

  it('right-aligns the figure and nothing else in the row', () => {
    // .bench-num states the rule for the results table: a column read down as
    // digits is right-aligned, and everything else is not. `comparison` is free
    // text -- "vs. the previous window" -- and set flush right in the last
    // track it was a paragraph hung off the panel's edge.
    expect(ruleFor(BODY_CSS, '.bar-row b {')).toContain('text-align: right');
    expect(ruleFor(BODY_CSS, '.bar-row em {')).toContain('text-align: left');
    expect(ruleFor(BODY_CSS, '.bar-row > span {')).not.toContain('text-align');
  });

  it('runs the track at 8px in the hairline grey, with the primary series as the fill', () => {
    // A bar's empty half is not data, so the track is the hairline rather than
    // the darker grey it was, and the fill is the same blue as the button that
    // produced it.
    expect(ruleFor(BODY_CSS, '.bar-row > div {')).toContain('height: 8px');
    expect(ruleFor(BODY_CSS, '.bar-row > div {')).toContain('background: var(--ast-hairline)');
    expect(ruleFor(BODY_CSS, '.bar-row i {')).toContain('background: var(--ast-blue)');
  });

  it('never prints a value on the fill it would have to be read against', () => {
    // The rule the four columns exist for. The fill is a childless element, and
    // the value and the delta are its siblings, so there is no arrangement of
    // widths in which a number ends up on top of a bar.
    expect(CARD).toContain('<i style={{ width: `${Math.min(Math.max(figure.value, 0), 100)}%` }} />');
    expect(CARD).toMatch(/<b className="ast-num">{figure\.display \?\? figure\.value}<\/b>/);
    expect(CARD).toMatch(/<em className={`ast-num \$\{comparisonDirection\(figure\.comparison\)\}`\.trim\(\)}>/);
  });

  it('sets the two figure columns in DM Mono, because they are columns', () => {
    // REVERSED, AND THE REVERSAL IS THE POINT. This used to assert the opposite:
    // that the value stayed in DM Sans with `font-variant-numeric: tabular-nums`,
    // on the reading that a number is never in a different family from the text
    // around it. That reading was defensible and the mechanism behind it was
    // not, which the font files settle rather than anyone's taste.
    // DMSans-variable.woff2 in this repository declares no `tnum` feature at all
    // -- its GSUB carries calt, ccmp, dnom, frac, liga, locl, numr and nothing
    // else -- so the property switched on nothing, silently. And its digits are
    // proportional by a wide margin: at 1000 units per em a `1` is 342 against a
    // `0` at 656. A column of them cannot line up however it is marked, so the
    // rule that was supposed to hold the block together was decorative.
    //
    // The astrolabe rule is about placement rather than about the character: a
    // figure in a column, a table cell, a stat value or a right-aligned meta slot
    // is DM Mono; DM Sans numerals are for prose, where nothing has to line up.
    // Both of these are columns -- a second value sits directly above and below
    // each of them on every answer with more than one figure.
    //
    // The class is on the markup rather than in the rule deliberately. Which
    // figures are columnar is a fact about the layout, and putting it where a
    // reviewer reads the layout is what makes it checkable at a glance.
    expect(CARD).toContain('<b className="ast-num">');
    expect(CARD).toContain('`ast-num ${comparisonDirection(figure.comparison)}`');
    // And the class does what it says, in the one file that declares it.
    const num = ruleFor(partial('astrolabe-tokens.css'), '.ast-num {');
    expect(num).toContain('font-family: var(--font-mono)');
    // The stylesheet does not restate the family, so there is one answer to
    // "what face is this figure in" rather than two that can drift apart.
    expect(ruleFor(BODY_CSS, '.bar-row b {')).not.toContain('font-family');
    expect(ruleFor(BODY_CSS, '.bar-row em {')).not.toContain('font-family');
  });

  it('keeps the figures in the agent’s order, uncapped', () => {
    // The same rule the caveats have and for the same reason: the agent chose
    // which figures to return and in what order, and a sort or a slice here
    // would be this surface editing the result.
    expect(CARD).toContain('{answer.figures.map((figure) => (');
    expect(CARD).not.toMatch(/answer\.figures\.(slice|sort|filter)\(/);
  });
});

describe('a delta claims a direction only when its own text does', () => {
  it('reads both minus characters, not just the ASCII one', () => {
    // The agent writes U+2212 in prose it has formatted for display and an
    // ASCII hyphen elsewhere. A check for the second alone painted every
    // typographic minus in the colour of a rise, which is the one direction
    // error a reader cannot catch from the colour.
    const helper = CARD.slice(CARD.indexOf('function comparisonDirection'));
    expect(helper).toContain("startsWith('-')");
    expect(helper).toContain("startsWith('\\u2212')");
    expect(helper).toContain("startsWith('+')");
  });

  it('is the neutral grey until then', () => {
    // `comparison` is free text: "vs. the previous window" reports no direction
    // at all and used to arrive green, on the strength of not beginning with a
    // hyphen.
    expect(ruleFor(BODY_CSS, '.bar-row em {')).toContain('color: var(--ast-text-secondary)');
    // The muted families rather than the signal ones. A delta is a reading, not
    // an alarm, and DuBois green #277C43 beside DuBois red #C82D4C turns a
    // column of them into a scoreboard.
    expect(ruleFor(BODY_CSS, '.bar-row em.positive {')).toContain('color: var(--ast-pos-text)');
    expect(ruleFor(BODY_CSS, '.bar-row em.negative {')).toContain('color: var(--ast-neg-text)');
  });

  it('leaves the sign in the text, so the direction is never colour alone', () => {
    expect(CARD).toContain('{figure.comparison}');
    expect(CARD).not.toMatch(/comparison\.(replace|slice|substring)\(/);
  });
});

describe('the caveats change how loudly they are said and nothing else', () => {
  it('keeps the amber, and spends it on a footer rather than on a panel', () => {
    // Amber is the evaluation colour and these are the qualifications on the
    // figures above them. What changed is where it is spent: this was a
    // free-standing alert under the sources, and an alert is a box, so on the
    // neutral wash it read as one more panel in a column of panels and was
    // missed for months. It is now the closing zone of the Sources module,
    // separated from the rows by a hairline in the same hue rather than by a
    // gap, so the qualification arrives attached to the tables it qualifies.
    //
    // The hue moved with the palette. DuBois amber #FFAB00 was a signal colour
    // that could not be read as type at 11px; astrolabe's warning family is
    // #8A6A38 on #F9F6EF behind #E0D3B8, which is muted on purpose and is what
    // the design reference draws at 8ar. Same meaning, same seating, a family
    // whose text rung is legible.
    const rule = ruleFor(BODY_CSS, '.keep-in-mind {');
    expect(rule).toContain('border-top: 1px solid var(--ast-warn-border)');
    expect(rule).toContain('background: var(--ast-warn-fill)');
    // Not a box: the module's own border is the only edge in this card, and a
    // second one inside it would restore the panel that was being skipped.
    expect(rule).not.toMatch(/\bborder:/);
    expect(rule).not.toContain('border-radius');
  });

  it('labels the block with a heading rather than a warning glyph', () => {
    // The alert brought an icon with it, in the deep rung, which was the only
    // amber glyph the card allowed. Read beside an amber wash it made the block
    // look like an error the reader had caused rather than a note about the
    // figures, so the label is now a heading and the wash is the whole alarm.
    expect(ruleFor(BODY_CSS, '.keep-in-mind-heading {')).toContain('font-weight: 700');
    expect(BODY_CSS).not.toContain('caveat-alert');
    // The deep rung survives on the one control in the block, which needs to be
    // legible as a control without recruiting the action blue into an amber
    // panel for the sake of showing two more lines of the same list.
    expect(ruleFor(BODY_CSS, '.keep-in-mind-toggle {')).toContain('var(--ast-warn-deep)');
  });

  it('gives a scope tag, a linked table and a named column the same mono tag', () => {
    // Three ways of naming a thing inside one bullet -- the tag in front of the
    // sentence, a table the app can link, a column it can only mark -- and a
    // reader has no reason to care which is which. They are one visual object
    // in the amber tint, and only the link keeps the underline that says it can
    // be followed.
    const rule = ruleFor(BODY_CSS, '.keep-in-mind .caveat-scope,');
    expect(rule).toContain('font-family: var(--font-mono)');
    // The warning family's mono fill, which is an rgba of its deep rung rather
    // than a hex: a tag inside a tinted panel has to sit ON the wash, and an
    // opaque second tint at these two values reads as a rendering fault.
    expect(rule).toContain('background: var(--ast-warn-mono-fill)');
    expect(BODY_CSS).toContain('.keep-in-mind a[data-entity] {');
  });

  // Count, order, wording and the absence of a cap are caveat-list.test.ts's,
  // which asserts them against this same file. Nothing is restated here.
});

describe('the run process is one panel rather than a bar and a box', () => {
  it('carries its edge on the container', () => {
    // At the control rung rather than the hairline: the answer card is a
    // high-alpha white over the sky, and #EBEBEB on that is an edge nobody can
    // see. Same step .ast-pill--neutral-outline makes for the same reason.
    const rule = ruleFor(BODY_CSS, '.run-process {');
    expect(rule).toContain('border: 1px solid var(--ast-border-input)');
    expect(rule).toContain('border-radius: var(--ast-radius-card)');
  });

  it('rules the head instead of washing it', () => {
    // THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, and the decision it
    // pinned no longer has two options to choose between. It read "washes the head
    // instead of drawing a second edge under it", because a wash and a rule together
    // are two separations doing one job. Every grey band on the sky has since gone:
    // the card is a translucent white sheet and a #F7F7F7 band on it is the exact
    // thing that made the sheet read as grey. With no wash to pick, the hairline is
    // the only thing left that can say the head is a heading and not the first line
    // of the body -- and this head, unlike the Sources module's, had no rule of its
    // own to fall back on, so one is added rather than merely uncovered.
    const rule = ruleFor(BODY_CSS, '.run-process-head {');
    expect(rule).toContain('background: transparent');
    expect(rule).toContain('border-bottom: 1px solid var(--ast-hairline)');
  });

  it('pushes the control to the end of the head row', () => {
    // The trigger renders as a Button, whose own data-slot replaces the
    // trigger's, so the rule reaches it as an element rather than by slot.
    expect(ruleFor(BODY_CSS, '.run-process-head > button {')).toContain('margin-left: auto');
  });

  it('leaves what is drawn inside it to the timeline', () => {
    // The boundary with the trace screen: this file owns the disclosure and its
    // head bar, TraceTimeline owns the roll-up and the Gantt.
    expect(CARD).toContain('<CollapsibleContent className="run-process-body">');
    expect(CARD).toMatch(/<TraceTimeline trace={answer\.trace}/);
    expect(BODY_CSS).not.toContain('.trace-kpi');
    expect(BODY_CSS).not.toContain('.gantt');
  });
});

describe('the plan card says which state it is in, in the colour that state means', () => {
  it('waits in the warning family and resolves to the positive one', () => {
    // ASSERTED ON THE MARKUP NOW, BECAUSE THE STYLESHEET NO LONGER DECIDES IT.
    // The chip used to declare its own radius, padding, size, weight and then a
    // wash and a deep-rung label per state -- one of twenty-one independently
    // written chip recipes in this app, which disagreed with each other on every
    // axis. It takes `.ast-pill` and one family class, so the colours are the
    // same two the trace, the Connections rows and the Sources module use, and
    // there is nothing left in `answer.css` to read them out of.
    //
    // The hues moved with the palette rather than the meaning: DuBois amber
    // #FFAB00 could not be read as type at 11px, and astrolabe's #8A6A38 on
    // #F9F6EF is the muted family drawn for exactly this.
    expect(PLAN).toContain(
      "`ast-pill plan-state ast-pill--${state === 'approved' ? 'pos' : state === 'review' ? 'warn' : 'neutral'}`"
    );
    expect(ANSWER_CSS, 'no second recipe survives in the stylesheet').not.toMatch(
      /\.plan-state\[data-state='(review|approved)'\]\s*\{/
    );
  });

  it('drives the tint from the same flag as the label', () => {
    // One value for all three statements -- chip label, chip tint, and the
    // sentence at the foot -- so the card cannot say "Approved" over copy that
    // says nothing ran. The third state is a plan settled without being
    // approved: revised away, or left behind by the next question.
    expect(PLAN).toContain("const state = approved ? 'approved' : resolved ? 'superseded' : 'review';");
    expect(PLAN).toContain('data-state={state}');
    expect(PLAN).toContain("{state === 'approved' ? 'Approved' : state === 'review' ? 'Review needed' : 'Not run'}");
  });

  it('keeps the sentence that says no query has run yet', () => {
    // Load-bearing copy. The card is a consent gate, and this is the line that
    // tells the reader what approving it will do.
    expect(PLAN).toContain('No analytical query runs until you approve this plan.');
    expect(PLAN).toContain('You approved this plan. The analysis below was produced by running these steps.');
    // And the third: claiming an approval the reader never gave is the same
    // defect in the other direction.
    expect(PLAN).toContain('None of these steps ran. The turn below replaced this plan.');
  });

  it('reassures in green, which is the reachable-or-saved colour', () => {
    // The positive family, which is the same three values the state chip above it
    // and the Sources rows take. It was DuBois' green wash, so the reassurance and
    // the chip two lines from it were two different greens.
    const rule = ruleFor(ANSWER_CSS, "[data-slot='alert'].plan-reassurance {");
    expect(rule).toContain('background: var(--ast-pos-fill)');
    expect(rule).toContain('border-color: var(--ast-pos-border)');
  });

  it('numbers the steps in the action colour at 22px, in the face that can line them up', () => {
    const rule = ruleFor(ANSWER_CSS, '.plan-step > span {');
    expect(rule).toContain('width: 22px');
    expect(rule).toContain('background: var(--ast-blue)');
    // MONO ON THE MARKUP, AND NO `tabular-nums` LEFT IN THE RULE. The reason
    // given for the property was that a ten-step plan should not have a wider
    // circle at 10 than at 9, and the circle is 22px either way, so that was
    // never the risk. The digits inside it were, and DM Sans cannot line those
    // up: it declares no `tnum` feature, so the property switched on nothing.
    expect(rule).not.toContain('tabular-nums');
    expect(PLAN).toContain('<span className="ast-num">');
  });

  it('right-aligns the decision, with the query-starting action last', () => {
    expect(ruleFor(ANSWER_CSS, '.plan-actions {')).toContain('justify-content: flex-end');
    expect(PLAN.indexOf('Revise request')).toBeLessThan(PLAN.indexOf('Approve and run'));
  });

  it('presses in blue and never in the evaluation colour', () => {
    // palette.test.ts enforces this across the app; asserted here because this
    // card is the one place amber and a primary button are inches apart.
    expect(ruleFor(ANSWER_CSS, '.plan-actions {')).not.toMatch(/amber/i);
  });
});

describe('the chart panel is a panel on this card, not a second page', () => {
  it('takes the hairline, the 8px radius and 16px of padding', () => {
    const rule = ruleFor(BODY_CSS, '.chart-card {');
    expect(rule).toContain('border-radius: var(--ast-radius-card)');
    expect(rule).toContain('padding-block: 16px');
    expect(ruleFor(BODY_CSS, ".chart-card > [data-slot='card-header'],")).toContain('padding-inline: 16px');
  });

  it('titles itself as a sub-block, under the takeaway rather than beside it', () => {
    const rule = ruleFor(BODY_CSS, ".chart-card > [data-slot='card-header'] [data-slot='card-title'] {");
    expect(rule).toContain('font-size: var(--ast-fs-14)');
    expect(rule).toContain('font-weight: 700');
  });

  it('heads itself with the title and the kind, and no line working the plot for the reader', () => {
    // "Hover for values, drag to zoom, double-click to reset" sat under the
    // title as the card's description. It was a manual for three affordances
    // Plotly discloses itself: the tooltip follows the pointer, and the mode
    // bar appears on hover carrying zoom, pan and Reset axes as labelled
    // buttons with their own titles.
    //
    // Pinned as the shape rather than the sentence. The header may hold the
    // title row and nothing else, so a REWORDED hint fails here too, whether it
    // comes back as a description or as a bare paragraph.
    const prose = CHARTS.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
    const header = prose.match(/<CardHeader>[\s\S]*?<\/CardHeader>/)?.[0] ?? '';
    expect(header).toContain('<CardTitle>');
    expect(header).toContain('<Badge variant="outline">');
    expect(header).not.toContain('<CardDescription');
    expect(header).not.toContain('<p');
    // Scoped to the header: the boundary's failure notice is a paragraph too,
    // and it is the one piece of prose in this file that says something the
    // reader cannot see for themselves.
    expect(prose).toContain('The figures and generated SQL below are unaffected.');
    // No instruction anywhere in the panel, under any wording.
    expect(prose).not.toMatch(/\b(hover|drag|zoom|click|scroll|pinch|tap)\b/i);
    // The other side: the rule that sized that description. It styled nothing
    // else, and left behind it is a slot that makes the next hint look intended.
    expect(BODY_CSS).not.toContain(".chart-card > [data-slot='card-header'] [data-slot='card-description']");
  });

  it('keeps all three interactions the removed line described', () => {
    // Deleting the caption must not delete the behaviour it narrated. These are
    // the affordances a reader still has, and the mode bar is what discloses
    // them now, so the buttons that reset and zoom may not be stripped from it.
    const plot = readFileSync(new URL('./plotly-config.ts', import.meta.url), 'utf8');
    expect(plot).toContain("doubleClick: 'reset'");
    expect(plot).toContain("displayModeBar: 'hover'");
    expect(plot).not.toMatch(/resetScale2d|zoom2d|pan2d/);
  });

  it('holds the plot at 320px and the skeleton at the same number', () => {
    // One constant for both, so the transcript does not jump when the chunk
    // lands. Two literals would drift the moment either was tuned.
    expect(CHARTS).toContain('const CHART_HEIGHT = 320;');
    expect(CHARTS).toContain('<Skeleton style={{ height: CHART_HEIGHT }}');
    expect(CHARTS).toContain('height={CHART_HEIGHT}');
    expect(CHARTS.match(/\b320\b/g)).toHaveLength(1);
  });

  it('fetches Plotly only when an answer carries a chart', () => {
    expect(CHARTS).toContain("lazy(() => import('./PlotlyFigure'))");
    expect(CHARTS).toContain('<Suspense fallback=');
  });

  it('loses one chart rather than the answer around it', () => {
    expect(CHARTS).toContain('static getDerivedStateFromError()');
    expect(CHARTS).toContain('<ChartBoundary>');
    // Inside the map, so the boundary is per panel: one boundary around the
    // list would take every chart down with the first one that threw.
    expect(CHARTS.indexOf('<ChartBoundary>')).toBeLessThan(CHARTS.indexOf('function AnswerCharts'));
  });

  it('reserves the mono face for what a reader compares character by character', () => {
    // SQL and identifiers, which is what it is for. The rule used to be stated
    // the other way round -- the source name was set in DM Sans and the point
    // was that the freshness line under it must not be mono. Both halves have
    // moved: the name is an identifier a reader checks against the one in the
    // prose above, so it takes the mono face, and there is no freshness line
    // left to get wrong because the freshness is in the row's tooltip.
    expect(ruleFor(BODY_CSS, '.code-panel pre {')).toContain('var(--font-mono');
    // The shared source-name recipe also reaches derivation rows; pin the
    // recipe rather than the one seating that opts into it.
    expect(ruleFor(BODY_CSS, '.source-name-pill {')).toContain('var(--font-mono)');
    // The header's facts are a sentence about the list, not something to be
    // compared, and mono on them would make the count read as data.
    expect(ruleFor(BODY_CSS, '.sources-module-facts {')).not.toContain('font-family');
  });

  it('adds no series colour of its own', () => {
    // `data` and `layout` are the run's and are carried through untouched, so
    // the leading bar in the working colour that the handoff asks for belongs to
    // the agent's plot contract. A colour written at this end would be a second
    // palette arguing with the one the figure declared.
    expect(CHARTS).not.toMatch(/marker|colorway|--chart-|#[0-9a-f]{6}/i);
  });

  it('adds no label layout of its own either', () => {
    // The same rule as the colours, for the same reason. Where the legend sits,
    // how much room the tick labels get and which slice labels are drawn are one
    // arrangement in the agent's `new_plot`, applied to every chart it can
    // produce. Written a second time at this end it would only cover the shapes
    // whoever wrote it had in mind, and the agent writes the specs, so the next
    // question is a shape nobody had in mind.
    const plot = readFileSync(new URL('./PlotlyFigure.tsx', import.meta.url), 'utf8');
    for (const source of [CHARTS, plot]) {
      expect(source).not.toMatch(/legend|automargin|tickangle|textposition|\bmargin\b/i);
    }
  });
});

describe('the advanced panel is a row and a code block, on the shared recipes', () => {
  it('states the toggle row’s two lines in the stylesheet rather than on the markup', () => {
    // BOTH LINES USED TO CARRY UTILITY CLASSES THE STYLESHEET OUTRANKED. The
    // label had `font-medium text-sm` and the caption `text-xs
    // text-muted-foreground`, against `.advanced-row > div > p:first-child` and
    // `:last-child`, which are two-class selectors. So the markup named a 14px
    // 500 label the row has never drawn -- and the 500 it named was not even
    // wrong, only unenforced, which is the version of this that survives a
    // palette pass unnoticed. The weight is declared where the size is now.
    const label = ruleFor(BODY_CSS, '.advanced-row > div > p:first-child {');
    expect(label).toContain('font-size: var(--ast-fs-13)');
    expect(label).toContain('font-weight: 500');
    const caption = ruleFor(BODY_CSS, '.advanced-row > div > p:last-child {');
    expect(caption).toContain('font-size: var(--ast-fs-12)');
    expect(caption).toContain('color: var(--ast-text-secondary)');
    expect(CARD).toContain('<p>Advanced trace details</p>');
    expect(CARD).toContain('<p>Generated SQL and raw input and output of every stage</p>');
  });

  it('chips the SQL panel’s read-only note on the one pill recipe, outlined', () => {
    // Outlined and not tinted: the chip sits on the code panel's header, which is
    // the card's translucent sheet, and a neutral tint on a tinted surface reads as
    // a rendering fault rather than as a chip. That is the case
    // `--ast-pill--neutral-outline` exists for. The header used to carry
    // `--ast-fill-band` and the reasoning was the same then -- a tint on a tint.
    expect(CARD).toContain('className="ast-pill ast-pill--neutral-outline"');
  });

  it('says a failed rating in the negative family, not in AppKit’s destructive', () => {
    // The one sentence in the feedback row that reports a failure. It was
    // `text-destructive text-xs` on the markup, which is a second red beside the
    // three the rest of the card draws.
    expect(CARD).toContain('<span className="feedback-error">{feedback.error}</span>');
    const rule = ruleFor(BODY_CSS, '.feedback-error {');
    expect(rule).toContain('color: var(--ast-neg-text)');
    expect(CARD).not.toContain('text-destructive');
  });

  it('tints the chosen thumb from the one blue rather than a copy of it', () => {
    // The tint was a hand-written `rgba(34, 114, 180, 0.06)` behind a token
    // named for the state instead of the colour, so the palette could move and
    // this selected control would keep the old blue at 6%.
    const rule = ruleFor(BODY_CSS, '.feedback > button.feedback-chosen {');
    expect(rule).toContain('color-mix(in srgb, var(--ast-blue) 6%, transparent)');
    expect(rule).not.toMatch(/rgba\(|--db-/);
  });
});

describe('an entity in the prose is a link that says where it goes', () => {
  it('is blue at 500 with a pinned 1px dotted rule', () => {
    // The dotted underline is what separates "this names a table you can go and
    // inspect" from ordinary emphasis. `decoration-1` states the thickness the
    // browser would otherwise scale with the font size.
    const links = readFileSync(new URL('./DataEntityLinks.tsx', import.meta.url), 'utf8');
    expect(links).toContain('text-primary font-medium underline decoration-dotted decoration-1 underline-offset-2');
  });

  it('says so on hover as well, since a dotted rule is easy to miss', () => {
    const links = readFileSync(new URL('./DataEntityLinks.tsx', import.meta.url), 'utf8');
    expect(links).toContain('hover:decoration-solid');
  });

  it('keeps a solid rule for a link the agent wrote, which is a different offer', () => {
    expect(ruleFor(ANSWER_CSS, '.answer-link {')).toContain('text-decoration: underline');
    expect(ruleFor(ANSWER_CSS, '.answer-link {')).not.toContain('dotted');
  });
});

describe('the closing note and the feedback row', () => {
  it('separates the feedback with a hairline rather than a component', () => {
    // It was a <Separator />, which is a 24px-margined element in a card whose
    // sections are 16px apart.
    const rule = ruleFor(BODY_CSS, '.feedback {');
    expect(rule).toContain('border-top: 1px solid var(--ast-hairline)');
    expect(CARD).not.toContain('<Separator />');
  });

  it('sizes the icon buttons at the design’s 30px', () => {
    expect(ruleFor(BODY_CSS, '.feedback > button {')).toContain('width: 30px');
  });

  it('keeps the disclosure that names who read the data', () => {
    // Load-bearing copy, and the sentence a reader needs in order to know whose
    // grants the figures were computed under.
    expect(CARD).toContain('astrolabe analysis. Verify material decisions against cited sources.');
  });

  it('takes the identity half of that disclosure from the run, not from a constant', () => {
    // The card used to end "Data access executed by the Player Insights service
    // principal", which this deployment has not done since the reader's token
    // started being forwarded to the endpoint. A constant cannot be right about
    // an arrangement a release can change, so the sentence is derived from the
    // claim the run reported and the assertion is that no literal survives.
    expect(CARD).toContain('dataAccessDisclosure(answer.executionIdentity)');
    expect(PROSE).not.toMatch(/service principal/i);
    expect(PROSE).not.toMatch(/Data access executed by/i);
  });

  it('ends the note after the caveat when the run recorded no identity', () => {
    // The footer used to close "The identity this data was read as is
    // unconfirmed." on every run whose identity was not recorded. It is gone
    // rather than reworded: a doubt printed under an answer is a claim about
    // that answer, and it was being made on runs nobody had found anything
    // wrong with. `dataAccessDisclosure` returns null there and the card
    // renders the sentence conditionally, so nothing hedged can come back
    // through this line.
    expect(CARD).toContain('dataAccess ?');
    expect(PROSE).not.toMatch(/unconfirmed/i);
  });

  it('sets the note at 12px in the secondary grey', () => {
    expect(ruleFor(BODY_CSS, '.ai-note {')).toContain('font-size: var(--ast-fs-12)');
    expect(ruleFor(BODY_CSS, '.ai-note {')).toContain('color: var(--ast-text-secondary)');
  });
});

describe('the card holds text it did not write', () => {
  it('lets every agent-supplied string break wherever it has to', () => {
    // A table name is one word and longer than the column it lands in. The list
    // is long because AppKit's slots are reached by attribute and the Markdown
    // renderer's output is reached through its wrapper.
    const rule = ruleFor(BODY_CSS, '.answer-card p,');
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).toContain('min-width: 0');
    for (const selector of ['.answer-prose', '.bar-row > span', '.keep-in-mind']) {
      expect(BODY_CSS, `${selector} is in the wrapping list`).toContain(`\n${selector},`);
    }
  });

  it('keeps the source rows out of that list, because they ellipsise instead', () => {
    // The one place in the card where a long name is not allowed to break. A
    // three-part Unity Catalog name is longer than the column at most widths,
    // and wrapping it put half an identifier on a line of its own directly above
    // the next table's -- two names, three lines, no way to tell where one
    // ended. The row is one line with an ellipsis and the whole name in its
    // tooltip, so nothing is lost by not wrapping it.
    expect(BODY_CSS).not.toContain('\n.sources-row-name,');
    const rule = ruleFor(BODY_CSS, '.sources-row-name {');
    expect(rule).toContain('white-space: nowrap');
    expect(rule).toContain('overflow: hidden');
    expect(rule).toContain('text-overflow: ellipsis');
  });

  it('wraps the fallback sentence in one child, because the alert slot is a grid', () => {
    // AppKit lays that slot out as a grid and puts every direct child on a row
    // of its own, which is what shipped "Nothing stored yet.Lakebase is
    // connected" on another screen. The headline and the sentence that finishes
    // it are one paragraph.
    // alert-layout.test.ts removed the app's `display: block` pin on that slot
    // and recorded the call-site wrapping as follow-up work. This is that work,
    // at the last call site still exposed to it.
    const alert = CARD.slice(CARD.indexOf('<Alert variant="destructive">'), CARD.indexOf('<AnswerProse'));
    const description = alert.slice(alert.indexOf('<AlertDescription>'));
    expect(description.indexOf('<p>')).toBeLessThan(description.indexOf('ANSWER_FALLBACK_NOTICES[fallback].headline'));
    expect(description).toMatch(/<\/p>\s*<\/AlertDescription>/);
  });

  it('omits a freshness it was not given rather than printing the separator', () => {
    // In SourcesModule.tsx since the Run Explorer and the answer card were found
    // disagreeing about this row's punctuation and stopped each drawing their
    // own. The freshness has moved from the row's text into its tooltip, but the
    // branch is the same one and the defect it guards against is the same: a
    // source that arrived without a freshness must not be labelled with a
    // dangling separator. What the row reads is rendered and read back in
    // sources-module-render.test.tsx; this pins the branch where it is written.
    const module = readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8');
    expect(module).toContain('row.freshness ? `${row.name} · ${row.freshness}` : row.name');
  });

  it('borders the sources module, because it is a card and no longer a caption', () => {
    // The deliberate reversal. The strip was a washed caption under the figures,
    // sized to be skimmed past; the module is the card an answer's provenance
    // and its qualifications both live on, so it takes a border and a radius and
    // clips its head and footer fills to them. A wash alone cannot hold three
    // zones -- head, rows, amber footer -- without them reading as three panels
    // that happen to be adjacent, which is precisely the arrangement the reader
    // stopped noticing the caveats in.
    const rule = ruleFor(BODY_CSS, '.sources-module {');
    expect(rule).toContain('border: 1px solid var(--ast-hairline)');
    expect(rule).toContain('border-radius: var(--ast-radius-card)');
    expect(rule).toContain('overflow: hidden');
    // And the head is separated from the rows by a hairline rather than a gap,
    // so the count reads as a header on the list and not as a line of prose that
    // happens to sit above it.
    const head = ruleFor(BODY_CSS, '.sources-module-head {');
    expect(head).toContain('border-bottom: 1px solid var(--ast-hairline)');
    // And nothing else: the hairline was always the separation here, so dropping the
    // grey fill costs this head nothing. See `.run-process-head`, which had no rule
    // and needed one added.
    expect(head).toContain('background: transparent');
  });

  it('gives the role chip the app’s one pill recipe rather than a recipe of its own', () => {
    // `.sources-chip` used to declare its own size, weight, radius, padding and
    // then a fill and a text colour per tone -- one of twenty-one independently
    // written chip recipes in this app, which disagreed on radius, label size
    // and whether a chip has a border at all. It now carries `.ast-pill` and one
    // family class, and the only things left in its own rule are the two facts
    // the shared recipe cannot know: that the name beside it must not squeeze it
    // and that its label must not wrap.
    const module = readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8');
    expect(module).toContain("`ast-pill sources-chip ast-pill--${row.tone === 'queried' ? 'info' : 'neutral'}`");
    const rule = ruleFor(BODY_CSS, '.sources-chip {');
    expect(rule).not.toMatch(/background|color:|border-radius|font-size|font-weight/);
    // And the name beside it reads in the same family's text colour, so the row
    // is one statement rather than a name and a separate label about it.
    expect(ruleFor(BODY_CSS, ".source-name-pill[data-tone='queried'] {")).toContain(
      'color: var(--ast-info-text)'
    );
    expect(ruleFor(BODY_CSS, ".source-name-pill[data-tone='queried'] .source-name-short {")).toContain(
      'background: var(--ast-info-fill)'
    );
  });
});

describe('the copy the reader asked us to drop stays dropped', () => {
  it('has none of the section titles that were removed', () => {
    const sources = `${CARD}${PLAN}${CHARTS}`;
    for (const phrase of ['Where the time went', 'How it worked', 'A friendly view', 'Interactive result']) {
      expect(sources, `${phrase} is gone`).not.toContain(phrase);
    }
  });

  it('does not argue for the design in the reader’s own card', () => {
    // Prose that explains why the app was built the way it was belongs in a
    // comment, and these three files carry a great deal of it there on purpose.
    // What must not appear is the same reasoning addressed to the reader, so the
    // comments are stripped and what is left is what reaches the screen.
    const copy = `${CARD}${PLAN}${CHARTS}`.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const phrase of ['we chose', 'we built', 'we decided', 'by design', 'for performance reasons']) {
      expect(copy.toLowerCase(), `"${phrase}" is not said to the reader`).not.toContain(phrase);
    }
  });

  it('describes the advanced panel by what it holds', () => {
    // It promised the payloads were sanitized, which is a claim about a
    // pipeline this card cannot see; what it can say is which things the switch
    // reveals. Two of them now rather than three: "all declared sources" named a
    // tab that was the source list a second time -- same names, same links, same
    // governance line -- and the caption is the one place a stale promise would
    // survive the tab being deleted.
    expect(CARD).toContain('Generated SQL and raw input and output of every stage');
    expect(CARD).not.toContain('sanitized');
    const caption = CARD.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
    expect(caption).not.toContain('all declared sources');
  });
});

describe('the two cards do not reach past the token block', () => {
  it('writes no colour of its own', () => {
    // palette.test.ts makes this claim for the whole stylesheet. It is made
    // again for these two partials because they are the files a designer is
    // most likely to paste a hex into, and white is the one literal allowed:
    // it is what sits on the ink chip and the blue numeral.
    //
    // Comments are stripped first, and deliberately: the contrast arithmetic
    // these rules were chosen by is recorded beside them in hex, and a check
    // that could not tell a note from a declaration would push those notes out
    // of the file to stay green.
    for (const [name, source] of [
      ['answer.css', ANSWER_CSS],
      ['answer-body.css', BODY_CSS],
    ] as const) {
      const declarations = source.replace(/\/\*[\s\S]*?\*\//g, '');
      const hexes = [...new Set(declarations.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])]
        .map((hex) => hex.toLowerCase())
        .filter((hex) => hex !== '#ffffff');
      expect(hexes, `${name} names colours by token`).toEqual([]);
    }
  });

  it('spends no token that is not the astrolabe palette’s', () => {
    // An ALLOWLIST, not a list of the older spellings. The two this caught were
    // `--text-h-card` and `--text-h-sub`, which no sweep for `--db-` would have
    // named: they are the previous heading scale, they resolve to 18px and 14px,
    // and the card therefore looked correct while sizing itself off a block the
    // astrolabe tokens do not own. A denylist only ever finds the tokens whoever
    // wrote it had already thought of.
    //
    // `--font-mono` is the one exception, and it is not a palette value: it is
    // the family `.ast-num` sets numerals in, and the tokens block is where it
    // is meant to be read from.
    for (const [name, source] of [
      ['answer.css', ANSWER_CSS],
      ['answer-body.css', BODY_CSS],
    ] as const) {
      const tokens = [...new Set(source.match(/var\(--[a-z0-9-]+/g) ?? [])].map((ref) =>
        ref.replace('var(', ''),
      );
      const foreign = tokens.filter((token) => !token.startsWith('--ast-') && token !== '--font-mono');
      expect(foreign, `${name} draws from the astrolabe tokens`).toEqual([]);
    }
  });

  it('is still part of the stylesheet the other tests read', () => {
    // partial() reads a file directly; stylesheet() parses index.css for the
    // import order. A partial dropped from that list would leave every claim
    // above passing and none of the rules loaded.
    expect(STYLESHEET).toContain('.provenance-chip {');
    expect(STYLESHEET).toContain('.bar-row {');
  });
});
