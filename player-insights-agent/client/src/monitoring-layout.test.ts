import { describe, expect, it } from 'vitest';

import { RANGE_SEGMENTS } from './time-range';
import { stylesheet } from './styles/stylesheet';

/**
 * Whether Monitoring's filter row still fits on one line, as arithmetic.
 *
 * WHY THIS FILE EXISTS. The row holds the period control, a rule, four chips and
 * the search box, and the search box is pushed to the right edge by
 * `margin-left: auto`. That is right while everything is on one line. Once the row
 * wraps, the same margin strands the field at the far end of a line of its own
 * with a gap where the chips used to be, and a field floating away from
 * everything reads as belonging to whatever wrapped above it. `responsive.css`
 * answers that by giving the field its own full-width line below a breakpoint, so
 * the question that decides whether the row is broken is a single one: is that
 * breakpoint at least as wide as the width at which the row runs out of line?
 *
 * Nobody could answer it. It was raised as a concern, guessed at as "somewhere
 * between 800px and full width", and left unverified through two releases, because
 * the honest way to check is to look at a screen and this repository must not open
 * a browser. Adding a fifth segment to the period control made it worse and made
 * it urgent. So it is computed instead.
 *
 * THE ESTIMATE, AND WHICH WAY IT IS WRONG. Every box measurement below is read out
 * of the stylesheet the app ships, so a change to any padding, border, gap or flex
 * basis moves this test. The one thing that cannot be read is how wide a string of
 * DM Sans renders, because that needs a font engine. `CHAR_PX` is a deliberate
 * OVER-estimate of the average advance, so the widths here are upper bounds and
 * the wrap point they produce is earlier than the real one. A test built on an
 * under-estimate would report a row fitting when it does not, which is the failure
 * this whole file is a reaction to.
 *
 * WHAT IT DOES NOT PROVE. Not that the row looks right, not where anything sits,
 * and not that a row with filters SET fits: a set chip prints its value, and a
 * table name is allowed 34 characters, so that row is wider than this one and
 * wraps sooner. The same full-width rule catches it. What is asserted is the
 * default row, which is what every reader sees on first load.
 */

/** Rules only, comments stripped, so a number quoted in prose is not read as CSS. */
const CSS = stylesheet().replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * An upper bound on the average character advance, as a fraction of font size.
 *
 * DM Sans is a humanist sans whose lowercase advances sit around 0.5em to 0.55em
 * at these sizes, with digits and capitals wider. 0.58 is above all of them, which
 * is the direction this has to err in: see the note above.
 */
const CHAR_PX = 0.58;

/** Uppercase, 700, and letter-spaced, so the eyebrow is measured on its own terms. */
const CAPS_CHAR_PX = 0.7;

/** `--text-sm`, the size the segments, the chips and the search box all render at. */
const TEXT_SM = 12;

/** `--text-xs`, the size of the PERIOD eyebrow, plus its 0.06em tracking. */
const TEXT_XS = 11;
const TRACKING_EM = 0.06;

/** `.page-shell`: 1440px wide, padded `clamp(20px, 4vw, 56px)` a side. */
const SHELL_MAX = 1440;
const SHELL_PAD_MAX = 56;
const SHELL_PAD_VW = 0.04;

function textWidth(label: string, size = TEXT_SM): number {
  return label.length * size * CHAR_PX;
}

function capsWidth(label: string): number {
  return label.length * TEXT_XS * (CAPS_CHAR_PX + TRACKING_EM);
}

/**
 * One declaration from one rule, as a number of pixels.
 *
 * Throws rather than defaulting when the rule or the property is not found. A
 * missing value silently read as zero is a budget that shrinks every time somebody
 * renames a class, and it would pass.
 */
function px(selector: string, property: string, which = 0): number {
  const rule = new RegExp(`${selector.replace(/[.[\]']/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!rule) throw new Error(`no rule for ${selector}`);
  const found = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(rule[1]);
  if (!found) throw new Error(`no ${property} on ${selector}`);
  const parts = found[1].trim().split(/\s+/);
  const value = Number.parseFloat(parts[which] ?? parts[0]);
  if (!Number.isFinite(value)) throw new Error(`${property} on ${selector} is not a length: ${found[1]}`);
  return value;
}

/** Horizontal padding, from a one-to-four-value shorthand. */
function padX(selector: string): number {
  const rule = new RegExp(`${selector.replace(/[.[\]']/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!rule) throw new Error(`no rule for ${selector}`);
  const found = /(?:^|;)\s*padding:\s*([^;]+)/.exec(rule[1]);
  if (!found) throw new Error(`no padding on ${selector}`);
  const parts = found[1].trim().split(/\s+/).map(Number.parseFloat);
  const right = parts[1] ?? parts[0];
  const left = parts[3] ?? right;
  return right + left;
}

/** Both borders, from a `1px solid var(--x)` shorthand. */
function borderX(selector: string): number {
  return px(selector, 'border') * 2;
}

function ruleBody(selector: string, css = CSS): string {
  const rule = new RegExp(`${selector.replace(/[.[\]']/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  if (!rule) throw new Error(`no rule for ${selector}`);
  return rule[1];
}

function mediaBody(maxWidth: number): string {
  const marker = `@media (max-width: ${maxWidth}px)`;
  // responsive.css is the final partial and owns the canonical breakpoint.
  // A concurrent page partial carrying a stray query must not make this test
  // inspect that earlier block instead of the responsive band under test.
  const start = CSS.lastIndexOf(marker);
  if (start < 0) throw new Error(`no media query for ${maxWidth}px`);
  const next = CSS.indexOf('@media ', start + marker.length);
  return CSS.slice(start, next < 0 ? undefined : next);
}

/* ── The row's preferred width ───────────────────────────────────────────── */

/** The segmented control, including the group's own border and the separators. */
function periodSegments(): number {
  const pad = padX('.time-range-segment');
  const labels = RANGE_SEGMENTS.map((segment) => textWidth(segment.label) + pad);
  // One `border-left` on every segment after the first.
  const separators = RANGE_SEGMENTS.length - 1;
  return borderX('.time-range-segments') + separators + labels.reduce((total, width) => total + width, 0);
}

/** The bordered group: the eyebrow, a gap, and the segments. */
function periodGroup(): number {
  return (
    borderX('.monitoring-period') +
    padX('.monitoring-period') +
    capsWidth('Period') +
    px('.monitoring-period', 'gap') +
    periodSegments()
  );
}

/**
 * One unset chip, which is now the shared app-select trigger inside the
 * Monitoring wrapper and prints its name, separator dot and off word.
 */
function chip(name: string, off: string): number {
  return (
    borderX('.app-select-trigger') +
    padX('.app-select-trigger') +
    // Two gaps: name to dot, dot to value.
    px('.app-select-trigger', 'gap') * 2 +
    textWidth(`${name}\u00b7${off}`)
  );
}

const CHIPS: [string, string][] = [
  ['Person', 'All'],
  ['Outcome', 'All'],
  ['Rating', 'All'],
  ['Table', 'Any'],
];

const ROW_GAP = () => px('.monitoring-filters', 'gap');

/** The 1px divider and its 2px margins. */
const RULE = () => px('.monitoring-filters-rule', 'width') + px('.monitoring-filters-rule', 'margin', 1) * 2;

/** `flex: 0 1 240px` -- what the search box asks for before any shrinking. */
const SEARCH_BASIS = () => px('.monitoring-search', 'flex', 2);

/** Its floor. Below this the field stops giving width back to the row. */
const SEARCH_MIN = () => px('.monitoring-search', 'min-width');

function rowPreferred(): number {
  const items = [periodGroup(), RULE(), ...CHIPS.map(([name, off]) => chip(name, off)), SEARCH_BASIS()];
  const gaps = (items.length - 1) * ROW_GAP();
  return gaps + items.reduce((total, width) => total + width, 0);
}

/** The content box inside `.page-shell` at a viewport width. */
function contentWidth(viewport: number): number {
  const pad = Math.min(SHELL_PAD_MAX, Math.max(20, viewport * SHELL_PAD_VW));
  return Math.min(SHELL_MAX, viewport) - pad * 2;
}

/**
 * The widest viewport at which the row cannot hold everything on one line.
 *
 * The search box shrinks first, down to its floor, so the row survives until the
 * content box is narrower than the preferred width less that much give.
 */
function wrapViewport(): number {
  const survives = rowPreferred() - (SEARCH_BASIS() - SEARCH_MIN());
  for (let viewport = 1440; viewport > 320; viewport -= 1) {
    if (contentWidth(viewport) < survives) return viewport;
  }
  return 0;
}

/** The `max-width` of the query that gives the search box its own full line. */
function searchOwnLineBreakpoint(): number {
  const widths = [...CSS.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)]
    .filter(([, , body]) => /\.monitoring-search\s*\{[^}]*flex:\s*1\s+1\s+100%/.test(body))
    .map(([, width]) => Number.parseInt(width, 10));
  return widths.length === 0 ? 0 : Math.max(...widths);
}

describe("Monitoring's filter row at three widths", () => {
  /**
   * Full width, which is the one width the design was drawn at. Everything on one
   * line, the search box at the right edge, nothing wrapped.
   */
  it('fits on one line at full width', () => {
    expect(rowPreferred()).toBeLessThan(contentWidth(1440));
  });

  /**
   * The claim that would have failed before All time shipped, and the reason this
   * file was written. The row runs out of line above 1090px; the rule that stops
   * the search box being stranded lived at 800px, so for nearly 300px of viewport
   * the row wrapped with `margin-left: auto` still in force and nothing said so.
   */
  it('gives the search box its own line before the row runs out of room', () => {
    expect(searchOwnLineBreakpoint()).toBeGreaterThanOrEqual(wrapViewport());
  });

  /**
   * And below that breakpoint the field is full width rather than merely
   * unpinned. `margin-left: 0` alone would leave a 240px box at the left of an
   * otherwise empty line, which is the same orphan the other way round.
   */
  it('makes it full width there, not just unpinned', () => {
    const band = new RegExp(`@media\\s*\\(max-width:\\s*${searchOwnLineBreakpoint()}px\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(
      CSS
    );

    expect(band).not.toBeNull();
    const rule = /\.monitoring-search\s*\{([^}]*)\}/.exec(band?.[0] ?? '');
    expect(rule?.[1]).toContain('margin-left: 0');
    expect(rule?.[1]).toMatch(/flex:\s*1\s+1\s+100%/);
  });

  /**
   * The widest state of the row that is still bounded: every chip set, so Clear
   * filters is drawn too. A set chip is wider than the unset one measured above
   * because it prints a value, and a set Table chip is allowed 34 characters, so
   * this is the row at its worst before wrapping is the intended behaviour.
   */
  it('still fits at full width with Clear filters drawn', () => {
    // shadcn's `size="sm"`: 12px of padding a side.
    const clearFilters = textWidth('Clear filters', 13) + 24;

    expect(rowPreferred() + clearFilters + ROW_GAP()).toBeLessThan(contentWidth(1440));
  });

  /**
   * The four supported presets leave a bounded amount of slack before the
   * search moves to its own line. This catches an unexpectedly widened control
   * without preserving the space that the retired Custom segment occupied.
   */
  it('leaves the period control room to grow before the breakpoint must move', () => {
    const headroom = searchOwnLineBreakpoint() - wrapViewport();

    expect(headroom).toBeLessThan(180);
    expect(headroom).toBeGreaterThanOrEqual(0);
  });
});

describe("Monitoring's desktop outcome header", () => {
  it('gives the four-label outcome card two of six desktop tracks', () => {
    expect(ruleBody('.monitoring-strip')).toContain('grid-template-columns: repeat(6, minmax(0, 1fr))');
    expect(ruleBody('.monitoring-outcomes-tile')).toContain('grid-column: span 2');
  });

  it('keeps the full label on one readable desktop line', () => {
    const label = ruleBody('.monitoring-outcomes-label');
    expect(label).toContain('white-space: nowrap');
    expect(label).not.toMatch(/font-size:\s*(?:[0-9]|10px)/);

    const laptop = mediaBody(1180);
    expect(laptop).toContain("'questions threads outcomes outcomes'");
    expect(laptop).toContain("'rated rated median median'");
  });

  it('intentionally releases the label to wrap only at the narrow breakpoint', () => {
    const narrow = mediaBody(800);
    expect(narrow).toMatch(/\.monitoring-outcomes-label\s*\{[^}]*white-space:\s*normal/);
    expect(narrow).toContain("'outcomes outcomes'");
  });
});
