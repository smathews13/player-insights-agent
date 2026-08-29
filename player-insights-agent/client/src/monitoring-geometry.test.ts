import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

/**
 * What the per-user panel's WIDTHS have to keep doing, read off the stylesheet.
 *
 * NO RENDER TEST ON THIS PANEL CAN SEE ANY OF IT, which is why the file exists.
 * The markup is identical whether a value ends in an ellipsis or is sliced off
 * mid-word by a card's own clipping, and there is no browser in this repository to
 * compose a screen and measure one. The panel shipped green with a
 * fully-qualified Unity Catalog name broken across two lines inside a word --
 * `..._catalog.player_i` / `nary` -- and with the same name overrunning its grant
 * row into the panel's clipping.
 *
 * Written in the pattern connections-geometry.test.ts established, an hour after
 * that file caught the same class of fault on the Connections cards. The cause is
 * the same one in both places: a long unbreakable string in a flex or grid item
 * whose automatic minimum size is the whole string.
 */

const CSS = partial('monitoring.css');

/**
 * One rule's body, by exact selector, and a failure rather than an empty string
 * when the selector is not there. Several assertions below are negative, and a
 * missing selector would satisfy every one of them while the panel clipped.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = CSS.match(new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[2];
  if (body === undefined) throw new Error(`monitoring.css has no rule for ${selector}`);
  return body;
}

describe('a fully-qualified table name remains readable beside its count', () => {
  /**
   * Every catalog, schema and table segment is a shared unbroken entity token.
   * The surrounding name may wrap between those tokens instead of clipping the
   * evidence or pushing the count off the row.
   */
  it('gives the tile carrying a table name the whole grid row', () => {
    expect(rule('.monitoring-panel-tile-wide')).toMatch(/grid-column:\s*1\s*\/\s*-1/);
  });

  it('wraps between shared entity segments rather than clipping the table name', () => {
    const name = rule('.monitoring-ranked-table');

    expect(name).toMatch(/overflow-wrap:\s*anywhere/);
    expect(name).not.toMatch(/overflow:\s*hidden/);
    expect(name).not.toMatch(/text-overflow:\s*ellipsis/);
  });

  /** The flexible name column gives before the compact run count does. */
  it('lets each ranked name shrink beside its count', () => {
    expect(rule('.monitoring-ranked-table')).toMatch(/min-width:\s*0/);
    expect(rule('.monitoring-table-ranking li')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/);
    expect(rule('.monitoring-panel-tile')).toMatch(/min-width:\s*0/);
  });

  /**
   * The grant rows carry the same names in a flex row inside a box that clips.
   *
   * `.monitoring-grants` has `overflow: hidden`, so a row that could not shrink
   * lost the name AND the badge beside it off the right edge, with no mark to say
   * either had been cut.
   */
  it('lets a grant row shrink its table name instead of overrunning the box', () => {
    const table = rule('.monitoring-grant-table');

    expect(table).toMatch(/min-width:\s*0/);
    expect(table).toMatch(/text-overflow:\s*ellipsis/);
    expect(table).toMatch(/overflow:\s*hidden/);
    expect(table).toMatch(/white-space:\s*nowrap/);
    // Confirming the clipping this is protecting against is still there, so the
    // assertion above cannot quietly become about nothing.
    expect(rule('.monitoring-grants')).toMatch(/overflow:\s*hidden/);
  });

  it('keeps each run count intact while ordinary captions remain free to wrap', () => {
    expect(rule('.monitoring-table-runs')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.monitoring-tile-caption')).not.toMatch(/white-space:\s*nowrap/);
  });
});

describe('a question opens as a centered modal, not a side drawer', () => {
  it('places the dialog in the middle of a full-page overlay', () => {
    expect(rule('.monitoring-question-overlay')).toMatch(/position:\s*fixed/);
    expect(rule('.monitoring-question-overlay')).toMatch(/place-items:\s*center/);
    expect(rule('.monitoring-question-overlay')).toMatch(/top:\s*var\(--app-header-h\)/);
    expect(rule('.monitoring-question-overlay')).not.toMatch(/inset:\s*0/);
    expect(rule('.monitoring-question-modal')).not.toMatch(/position:\s*fixed/);
    expect(rule('.monitoring-question-modal')).not.toMatch(/right:\s*0/);
    // The person panel is still the right-hand drawer. Question detail is not.
    expect(rule('.monitoring-drawer')).toMatch(/right:\s*0/);
  });

  it('lets the dialog scroll and forbids its children from shrinking over each other', () => {
    const dialog = rule('.monitoring-question-modal');
    expect(dialog).toMatch(/overflow-y:\s*auto/);
    expect(dialog).toMatch(/max-height:\s*min\(calc\(100vh - var\(--app-header-h\) - 40px\),\s*920px\)/);
    expect(dialog).toMatch(/flex-direction:\s*column/);
    expect(dialog).not.toMatch(/position:\s*absolute/);
    const child = rule('.monitoring-question-modal > *');
    expect(child).toMatch(/flex-shrink:\s*0/);
    expect(child).toMatch(/min-height:\s*min-content/);
    expect(child).toMatch(/position:\s*static/);
  });
});

describe('the panel head and the scope badges cannot be clipped either', () => {
  /**
   * The close button is `flex: none`, so a long local part with no space in it
   * would take its own minimum width out of the row first and push the only way
   * out of the panel off the edge.
   */
  it('lets the name block shrink so the close button stays on screen', () => {
    expect(rule('.monitoring-drawer-head > div')).toMatch(/min-width:\s*0/);
    expect(rule('.monitoring-drawer-close')).toMatch(/flex:\s*none/);
    // An address has no space to wrap at, and this is the one place a break
    expect(rule('.monitoring-panel-name')).toMatch(/min-width:\s*0/);
    expect(rule('.monitoring-panel-name .identity-chip')).toMatch(/max-width:\s*100%/);
  });

  /**
   * A scope badge wraps, unlike every other pill in this file.
   *
   * The outcome pills carry one word. A scope badge carries four or five plus a
   * run count, so `white-space: nowrap` inherited from `.monitoring-pill` would
   * make its minimum width the whole label and push the row past the drawer at
   * the width the drawer goes to 100vw. A badge that wraps cannot be clipped.
   */
  it('lets a scope badge wrap rather than overrun the row', () => {
    const scope = rule('.monitoring-scope');

    expect(scope).toMatch(/white-space:\s*normal/);
    expect(scope).toMatch(/max-width:\s*100%/);
    expect(scope).toMatch(/min-width:\s*0/);
    // The pill it overrides is the nowrap one, so this is not a rule about nothing.
    expect(rule('.monitoring-pill')).toMatch(/white-space:\s*nowrap/);
    // And the row wraps, so several badges stack rather than scrolling sideways.
    expect(rule('.monitoring-scopes')).toMatch(/flex-wrap:\s*wrap/);
  });

  /**
   * The asker column, once it carries a mark as well as a name.
   *
   * The trap here is one column to the left and is written up over the question
   * cell: a `td` given `display: flex` stops being a table cell and drops out of
   * the column sizing the header row settles. The mark and the name therefore
   * sit in a span inside the cell, and this is the assertion that keeps them
   * there -- the failure mode is not a clipped name, it is six columns quietly
   * re-sizing themselves from their content.
   */
  it('lays the asker cell out inside itself rather than turning the cell into a flex box', () => {
    expect(rule('.monitoring-asker')).not.toMatch(/display:\s*(flex|inline-flex|grid)/);
    expect(rule('.monitoring-asker-who')).toMatch(/display:\s*inline-flex/);
    expect(rule('.monitoring-asker-who')).toMatch(/max-width:\s*100%/);
    expect(CSS).not.toContain('.monitoring-initials');
  });

  it('keeps enough width for the compact identity chip', () => {
    const px = (body: string, property: string) =>
      Number.parseFloat(body.match(new RegExp(`${property}:\\s*(-?[\\d.]+)px`))?.[1] ?? 'NaN');
    expect(px(rule('.monitoring-col-asker'), 'width')).toBeGreaterThan(110);
  });

  it('takes a few pixels off every row without taking the click target with them', () => {
    // The list was asked to be more compact. The row is one control, so the
    // padding is what gives and the two-line question clamp is not: a target
    // only as tall as its text is a target people miss.
    const px = Number.parseFloat(rule('.monitoring-row td').match(/padding:\s*(-?[\d.]+)px/)?.[1] ?? 'NaN');
    expect(px).toBeLessThan(9);
    expect(px).toBeGreaterThanOrEqual(6);
    expect(rule('.monitoring-question-text')).toMatch(/-webkit-line-clamp:\s*2/);
  });

  it('sets the range beside a heading rather than in the heading’s own voice', () => {
    // It qualifies the section, it is not part of its name. In the eyebrow's own
    // caps and weight it reads as a second heading.
    const range = rule('.monitoring-eyebrow-range');
    expect(range).toMatch(/text-transform:\s*none/);
    expect(range).toMatch(/color:\s*var\(--muted-foreground\)/);
    expect(rule('.monitoring-eyebrow')).toMatch(/text-transform:\s*uppercase/);
  });

  /** The badges are the section now, so nothing may re-add the prose block. */
  it('carries no stylesheet for the prose block the badges replaced', () => {
    expect(CSS).not.toContain('.monitoring-panel-lines');
  });
});

/**
 * The palette and the scale, after the astrolabe pass.
 *
 * This tab is where a deployment's numbers are compared: five tiles across the
 * top that a reader reads sideways, and a table with two right-aligned columns
 * they read downwards. Both were asking DM Sans for tabular figures, which its
 * files cannot give, so neither lined up.
 */
describe('the filter-row search is a field, not a hole in the sky', () => {
  /**
   * AppKit paints the input transparent. The chips beside it paint `--card`.
   * The fill is the whole of this rule: size and placement stay on
   * `.monitoring-search`, which is what the wrap arithmetic reads.
   */
  it('paints the field with the chip token and does not resize it', () => {
    expect(rule('.monitoring-filters .monitoring-search input')).toMatch(/background:\s*var\(--card\)/);
    expect(rule('.monitoring-filters .monitoring-search input')).not.toMatch(/height:|min-width:|flex:|margin-left:/);
    expect(rule('.monitoring-search')).toMatch(/flex:\s*0\s+1\s+240px/);
    expect(rule('.monitoring-search')).toMatch(/min-width:\s*160px/);
    expect(rule('.monitoring-search')).toMatch(/margin-left:\s*auto/);
    expect(rule('.monitoring-search')).not.toMatch(/height:/);
  });
});

describe('the figures line up and the palette is the palette', () => {
  const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

  /**
   * `font-variant-numeric: tabular-nums` on DM Sans is a no-op that reads as
   * done: its GSUB carries no `tnum`, and its digits run from 342 to 656 units
   * wide. Four rules here asked for it and none of them got it. `.ast-num` in the
   * markup is DM Mono, which is tabular by being monospaced.
   */
  it('leaves no rule asking DM Sans for a feature its files do not carry', () => {
    const claiming = [...RULES.matchAll(/\{([^}]*font-variant-numeric[^}]*)\}/g)].map((match) => match[1]);
    for (const body of claiming) {
      expect(body, `a rule asks for tabular figures without a mono family: ${body.trim()}`).toMatch(
        /font-family:\s*var\(--font-mono\)/
      );
    }
  });

  /**
   * And the class is NOT on `.monitoring-numeric` itself, which is the mistake
   * this arrangement avoids: that class is on the two column HEADERS as well as
   * on the cells, and "Time" and "Tools" are words.
   */
  it('keeps the column headers out of the mono face', () => {
    expect(rule('.monitoring-numeric')).not.toMatch(/font-family|font-variant-numeric/);
  });

  /**
   * Refused and failed are the two halves of one tile and they must never sum.
   * monitoring-ops.md names their colours: #46596B and #A04A62. They were DuBois
   * `--db-grey-blue` #445461 and `--db-red-600` #C82D4C.
   */
  it('colours refused and failed in the palette’s neutral and negative', () => {
    expect(rule('.monitoring-refused')).toMatch(/color:\s*var\(--ast-neutral-text\)/);
    expect(rule('.monitoring-failed')).toMatch(/color:\s*var\(--ast-neg-text\)/);
    // Two rules, never one: the words are in the label above, so the split does
    // not ride on colour, but it must still be a split.
    expect(rule('.monitoring-refused')).not.toEqual(rule('.monitoring-failed'));
  });

  /** §3's eight rungs, with the off-scale initials size gone. */
  it('writes every size as a rung of the scale', () => {
    const sizes = [...RULES.matchAll(/font-size:\s*([^;]+);/g)].map((value) => value[1].trim());
    // `inherit` is not a size: it is the Select trigger declining to have one of
    // its own so the chip around it decides, which is the opposite of a stray.
    const stray = sizes.filter((value) => value !== 'inherit' && !/^var\(--(ast-fs-\d+|text-[\w-]+)\)$/.test(value));
    expect(stray).toEqual([]);
  });

  it('has no initials-circle recipe on either user list', () => {
    const rail = partial('rail.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(CSS).not.toContain('.monitoring-asker-initials');
    expect(rail).not.toMatch(/\.conversation-owner\s*\{[^}]*border-radius:\s*50%/);
  });
});
