import { describe, expect, it } from 'vitest';

import { BADGE_FAMILY } from './status-badge-state';
import { partial } from './styles/stylesheet';

/**
 * What the Connections page's shape has to keep saying after a restyle.
 *
 * The page is a report about a deployment, and almost everything on it is a
 * statement of fact rather than a problem. Three things on it are not, and the
 * whole readability of the page rests on those three being the only ones that
 * are coloured: a check that failed, a value the deployment is demonstrably not
 * using, and the card carrying the statements that fix them. Everything else --
 * the immutability notice, the counts of things that are fine, the drift marker
 * on a connection that answered -- has to stay quiet, or the reader learns that
 * red on this page means nothing in particular.
 *
 * So these assertions are about meaning rather than pixels. Padding and gaps can
 * move freely; which family a rule paints in, and whether a count of zero is
 * tinted at all, cannot.
 *
 * Read against the stylesheet in the pattern palette.test.ts established, because
 * this repo has no jsdom: the claims a browser would have to confirm are noted in
 * the handover rather than asserted here.
 */

const CSS = partial('connections.css');
/*
 * The palette's own partial, because the status families moved there.
 *
 * The three verdict rules that used to live in connections.css -- a green, a red
 * and an amber wash written out per selector -- are `.ast-pill--pos`, `--neg` and
 * `--warn` now, applied from StatusBadge.tsx. The assertions about WHICH rung
 * drift takes therefore have to read the recipe rather than this page's copy of
 * it, and reading the recipe is the point: there is one copy to be right about.
 */
const TOKENS = partial('astrolabe-tokens.css');
const RESPONSIVE = partial('responsive-connections.css');

/**
 * One rule's body, by exact selector, and a failure rather than an empty string
 * when the selector is not there. Half the assertions below are negative -- that a
 * rule does NOT paint red -- and a missing selector would satisfy every one of
 * them while the page said nothing at all.
 */
function ruleIn(css: string, where: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[2];
  if (body === undefined) throw new Error(`${where} has no rule for ${selector}`);
  return body;
}

function rule(selector: string): string {
  return ruleIn(CSS, 'connections.css', selector);
}

/** One rule from the shared recipe, same contract. */
function token(selector: string): string {
  return ruleIn(TOKENS, 'astrolabe-tokens.css', selector);
}

describe('the three things on this page that are allowed to be coloured', () => {
  it('gives the blocked-checks card the red edge and the red head', () => {
    // It renders only when something is blocked, which is what earns it the red:
    // a healthy deployment never sees this card at all.
    expect(rule('.connections-fix')).toMatch(/border:\s*1px solid var\(--ast-neg-border\)/);
    expect(rule('.connections-fix-head')).toMatch(/background:\s*var\(--ast-neg-fill\)/);
  });

  it('turns the in-use tile red only when the two readings disagree', () => {
    const disagreeing = rule(".connection-tile[data-disagrees='true']");
    expect(disagreeing).toMatch(/border-color:\s*var\(--ast-neg-border\)/);
    expect(disagreeing).toMatch(/background:\s*var\(--ast-neg-fill\)/);
    expect(rule(".connection-tile[data-disagrees='true'] .connection-tile-value")).toMatch(
      /color:\s*var\(--ast-neg-text\)/
    );
    // The tile in agreement is an ordinary hairline tile. A page that tints both
    // has spent the colour on the comparison rather than on its outcome.
    expect(rule('.connection-tile')).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(rule('.connection-tile')).not.toMatch(/red/);
  });

  /**
   * The standing immutability notice is gone, and this is where the assertion
   * about it was. It read "Most values here cannot be changed from a form. Each
   * row states which, and carries the command where one exists" -- permanently
   * true, therefore never news, and it sat above the summary where the reader
   * looks first. Each row still says whether it can be changed, with a pencil or
   * a padlock, which is the same fact where the question is actually asked.
   */
  it('draws no permanent notice above the summary', () => {
    expect(CSS).not.toContain('.connections-immutable');
  });
});

describe('drift is a qualification, not a failure', () => {
  /**
   * The per-row drift chip is gone with every other per-row status chip: the
   * verdict is the section a row is in, said once in its header. So the amber
   * rungs are asserted where drift is now drawn -- the section header, and the
   * value badge on the rows under it.
   */
  it('marks it in the deep warning rung, never in amber itself', () => {
    expect(rule(".connection-group-title[data-tone='drifted']")).toMatch(/color:\s*var\(--ast-warn-deep\)/);
    // The badge is the shared warning family, so this reads the one recipe.
    const badge = token('.ast-pill--warn');
    expect(badge).toMatch(/color:\s*var\(--ast-warn-text\)/);
    // Amber itself is 1.90:1 on white. It may be a mass; it may not be this
    // label, which is why the fill is the mixed-down rung and the type is above it.
    expect(badge).not.toMatch(/var\(--db-amber\)|#ffab00/i);
  });

  it('does not let a connection that answered wear the failure colour', () => {
    expect(rule(".connection-group-title[data-tone='drifted']")).not.toMatch(/red|neg/);
    expect(token('.ast-pill--warn')).not.toMatch(/red|neg/);
    // And drift resolves to the warning family rather than to the failure one,
    // asserted at the join rather than in the stylesheet: a badge that took
    // `--neg` would satisfy every rule above by never being drawn amber at all.
    expect(BADGE_FAMILY.drifted).toBe('warn');
    expect(BADGE_FAMILY.blocked).toBe('neg');
  });
});

describe('resource picker geometry', () => {
  it('keeps the value-only resource type control compact', () => {
    expect(rule('.plane-field-select')).toMatch(/width:\s*min\(240px,\s*100%\)/);
    expect(rule('.plane-field-select')).toMatch(/height:\s*32px/);
    expect(rule('.plane-kind-field')).toMatch(/gap:\s*4px/);
  });

  it('bounds the result list and keeps rows compact', () => {
    expect(rule('.asset-picker-rows')).toMatch(/max-height:\s*220px/);
    expect(rule('.asset-picker-rows')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.asset-picker-row')).toMatch(/padding:\s*6px 8px/);
  });

  it('uses full width only in the narrow layout', () => {
    expect(rule('.plane-field-select')).toMatch(/width:\s*min\(240px,\s*100%\)/);
  });

  it('stops picker motion for both animation preferences', () => {
    expect(CSS).toMatch(/data-animations='off'[\s\S]*\.asset-picker-spinner[\s\S]*animation:\s*none/);
    expect(CSS).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*\.asset-picker-spinner[\s\S]*animation:\s*none/);
  });
});

describe('a count of nothing is not a status', () => {
  it('tints a count only through a tone the markup has to ask for', () => {
    // The page sets `data-tone` only when the count is above zero, so "0 blocked"
    // is ordinary body text. Asserted here as the stylesheet half: the base rule
    // states no colour, so an untoned count cannot be tinted by accident.
    expect(rule('.connections-count')).not.toMatch(/color:/);
    expect(rule(".connections-count[data-tone='blocked']")).toMatch(/color:\s*var\(--ast-neg-text\)/);
    expect(rule(".connections-count[data-tone='reachable']")).toMatch(/color:\s*var\(--ast-pos-text\)/);
    expect(rule(".connections-count[data-tone='drifted']")).toMatch(/color:\s*var\(--ast-warn-deep\)/);
  });

  /**
   * The inert claim, held out by name so it cannot come back.
   *
   * This rule used to read `font-variant-numeric: tabular-nums` and a test used
   * to read it back, and both passed while the line reflowed on every refresh
   * exactly as it had before either was written: DM Sans in this repo declares no
   * `tnum` feature, so the property had nothing to switch on. The figures are
   * `.ast-num` in the markup now, which is DM Mono and tabular by being
   * monospaced. Asking for it here again would be asking the font for something
   * it cannot do, in the one place a reader would then stop looking.
   *
   * Which characters carry the class is the part that matters, and a stylesheet
   * cannot see it. That is asserted on the rendered markup in
   * connections-design.test.tsx.
   */
  it('does not ask DM Sans for a feature its files do not carry', () => {
    expect(rule('.connections-count')).not.toMatch(/font-variant-numeric/);
  });
});

describe('the parts a reader has to be able to use', () => {
  it('makes a remediation statement selectable in one gesture', () => {
    // The page's whole value for a new workspace is that an admin can lift the
    // line out of it. `user-select: all` is what makes one click take the
    // statement and not half of it.
    const code = rule('.connections-code');
    expect(code).toMatch(/user-select:\s*all/);
    expect(code).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(code).toMatch(/background:\s*var\(--db-code-bg\)/);
  });

  it('marks the row an entity link landed on with the app’s selected-row treatment', () => {
    const highlighted = rule(".connections-table tr[data-highlighted='true']");
    expect(highlighted).toMatch(/background:\s*var\(--db-selected-tint\)/);
    // Inset, so arriving at a row cannot shift the text inside it sideways.
    expect(highlighted).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--ast-blue\)/);
  });

  it('draws the declared Unity Catalog objects as a readable table', () => {
    /*
     * This section used to rely on the component library's bare table geometry:
     * the header, rows and body shared one uninterrupted ground. Pin the three
     * relationships that make it scan as a matrix, and the object name that the
     * reader came here to inspect.
     */
    expect(rule('.connections-table th')).toMatch(/background:\s*var\(--ast-fill-band\)/);
    // Same seating as Foundation model / Vector Search. An 8px header and
    // AppKit's compact cells made these rows shorter than every other
    // connection on the page.
    expect(rule('.connections-table')).toMatch(/font-size:\s*var\(--text-base\)/);
    expect(rule('.connections-table th')).not.toMatch(/padding-block:\s*8px/);
    expect(CSS).toMatch(/\.connections-table th,\s*\n\s*\.connections-table td[\s\S]*?padding:\s*10px 16px/);
    expect(rule('.connections-table tbody tr')).toMatch(/border-bottom:\s*1px solid var\(--border\)/);
    expect(rule('.connections-table tbody tr:hover')).toMatch(/background:\s*var\(--db-row-hover\)/);
    // The repeated catalog and schema are context; the table is the scanning
    // anchor and is the only segment that should carry the full weight.
    expect(rule('.connections-table-name')).toMatch(/font-weight:\s*400/);
    expect(rule(".connections-entity-name [data-entity-part='table']")).toMatch(/font-weight:\s*700/);
    // The search sits in a compact toolbar above the matrix, sized here; the
    // magnifying glass and field padding are `.run-search` so this cannot drift
    // from Monitoring and Run Explorer.
    expect(rule('.connections-table-toolbar')).toMatch(/display:\s*flex/);
    expect(rule('.connections-table-toolbar')).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule('.connections-table-toolbar')).toMatch(/overflow:\s*visible/);
    expect(rule('.connections-table-filter-menu')).toMatch(/width:\s*max-content/);
    expect(rule('.connections-table-filter-menu')).toMatch(/position:\s*absolute/);
    expect(rule('.connections-table-search')).toMatch(/flex:\s*none/);
    expect(rule('.connections-table-search')).toMatch(/width:\s*12rem/);
    expect(rule('.connections-table-search')).toMatch(/height:\s*32px/);
    expect(rule(".connections-table-search [data-slot='input']")).toMatch(/height:\s*32px/);
    expect(rule('.connections-table-filter')).toMatch(/flex:\s*none/);
    expect(rule('.connections-table-filter')).toMatch(/position:\s*relative/);
    expect(rule('.connections-table-filter')).toMatch(/overflow:\s*visible/);
    expect(rule('.connection-block')).toMatch(/overflow:\s*visible/);
    expect(rule('html:has(.connections-page) body[data-scroll-locked]')).toMatch(/padding-right:\s*0\s*!important/);
    expect(rule('.connections-table-detail')).toMatch(/white-space:\s*normal/);
    expect(rule('.connections-table-detail')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('keeps table controls right-aligned in the header with a narrow fallback', () => {
    expect(rule('.connection-block-head')).toMatch(/display:\s*flex/);
    expect(rule('.connection-block-controls')).toMatch(/margin-left:\s*auto/);
    expect(rule('.connection-block-controls')).toMatch(/flex:\s*0 0 auto/);
    expect(RESPONSIVE).toMatch(/@media \(max-width: 800px\)[\s\S]*?\.connection-block-head\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(RESPONSIVE).toMatch(/\.connection-block-controls\s*\{[^}]*width:\s*100%/);
    expect(RESPONSIVE).toMatch(/\.connection-block-controls \.connections-table-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('keeps Connections status badges compact and on one line', () => {
    const resource = rule('.status-badge');
    expect(resource).toMatch(/font-size:\s*var\(--ast-fs-11\)/);
    expect(resource).toMatch(/padding:\s*1px 6px/);
    expect(resource).toMatch(/white-space:\s*nowrap/);
    const table = rule(".connections-table [data-slot='badge']");
    expect(table).toMatch(/font-size:\s*var\(--ast-fs-11\)/);
    expect(table).toMatch(/white-space:\s*nowrap/);
  });

  it('keeps Not checked rows at Connected-resources density', () => {
    expect(CSS).toMatch(
      /\.connection-row-summary,\s*\n\s*\.connection-block-summary\s*\{[^}]*padding:\s*10px 16px[^}]*font-size:\s*var\(--text-base\)/
    );
  });

  it('paints the add-connection row in the same ink as a configuration label', () => {
    expect(rule('.plane-add-connection')).toMatch(/color:\s*var\(--ast-text\)/);
    expect(rule('.plane-add-connection')).toMatch(/font-weight:\s*500/);
    expect(rule('.plane-add-connection')).toMatch(/font-size:\s*var\(--text-base\)/);
    expect(rule('.plane-add-connection')).not.toMatch(/opacity:/);
    expect(rule('.plane-add-row')).toMatch(/border:\s*1px solid var\(--border\)/);
  });

  it('sizes the trash mark inside the shared destructive button', () => {
    expect(rule('.plane-delete-connection svg')).toMatch(/width:\s*14px/);
    expect(rule('.plane-delete-connection svg')).toMatch(/height:\s*14px/);
  });

  it('paints the affordance that leads somewhere in the action colour, and the padlock not at all', () => {
    expect(rule('.connection-row-affordance')).toMatch(/color:\s*var\(--db-slate-icon\)/);
    // The astrolabe spelling of the one blue. `--ast-blue` and `--db-blue-600`
    // are the same #2272B4 and astrolabe-tokens.test.ts holds them equal; this
    // page asks for it by the name the rebuild uses.
    expect(rule(".connection-row-affordance[data-affordance='write']")).toMatch(/color:\s*var\(--ast-blue\)/);
  });
});

describe('the add-resource surface over the constellation', () => {
  it('uses theme-aware opaque surfaces for standard rows, the form and picker', () => {
    expect(rule('.connection-rows')).toMatch(/background:\s*var\(--popover\)/);
    expect(rule('.plane-add-row')).toMatch(/background:\s*var\(--popover\)/);
    expect(rule('.plane-form')).toMatch(/background:\s*var\(--popover\)/);
    expect(rule('.asset-picker')).toMatch(/background:\s*var\(--card\)/);
    for (const selector of ['.connection-rows', '.plane-add-row', '.plane-form', '.asset-picker']) {
      expect(rule(selector), selector).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    }
  });

  it('keeps selected, hover and keyboard focus rows readable without moving them', () => {
    const selected = rule(".asset-picker-row[data-selected='true']");
    expect(selected).toMatch(/background:\s*var\(--db-selected-tint\)/);
    expect(selected).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--ast-blue\)/);
    expect(CSS).toMatch(/\.asset-picker-row:hover,\s*\n\.asset-picker-row:focus-within\s*\{/);
    expect(rule('.asset-picker-row-names')).toMatch(/display:\s*grid/);
    expect(rule('.asset-picker-row-id')).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule('.asset-picker-row-id')).toMatch(/white-space:\s*nowrap/);
  });

  it('separates pagination from the resource rows', () => {
    expect(rule('.asset-picker-more')).toMatch(/border-top:\s*1px solid var\(--border\)/);
    expect(rule('.asset-picker-more')).toMatch(/justify-content:\s*center/);
  });
});

/**
 * The two faults a passing render test walks straight past.
 *
 * Everything above is about colour, which the markup asks for and a test can
 * read back. These two are about WIDTH, which no render test on this page can
 * see: the DOM is identical whether a value ends in an ellipsis or is sliced off
 * mid-hostname by the card's own clipping, so both of these shipped green.
 */
describe('a long value truncates rather than being cut off', () => {
  /**
   * The badge has to be allowed to shrink before its own ellipsis can fire.
   *
   * Every long value on this page -- the app endpoint, a three-part table name,
   * a warehouse id -- sits in a flex row. A flex item's automatic minimum size
   * is its min-content width, and with `white-space: nowrap` that minimum is the
   * whole string, which outranks `max-width` and leaves `text-overflow` with
   * nothing to do. The badge then overflows and the card's `overflow: hidden`
   * cuts it, with no ellipsis to say so, which is the one truncation a reader
   * cannot tell from the end of the value.
   */
  it('lets the status badge shrink, so its ellipsis can fire', () => {
    const badge = rule('.status-badge');
    expect(badge).toMatch(/min-width:\s*0/);
    expect(badge).toMatch(/max-width:\s*100%/);
    expect(badge).toMatch(/text-overflow:\s*ellipsis/);
    expect(badge).toMatch(/overflow:\s*hidden/);
  });

  it('uses a compact label column inside the three identity groups', () => {
    expect(rule('.deployment-card-build .identity-fact-label')).toMatch(/flex-basis:\s*110px/);
    expect(rule('.deployment-card-identity .identity-fact-label')).toMatch(/flex-basis:\s*96px/);
  });

  it('keeps all three identity groups balanced across the desktop width', () => {
    expect(rule('.identity-overview')).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(rule('.identity-overview')).toMatch(/gap:\s*8px/);
    expect(rule('.deployment-card-identity-body')).toMatch(/padding:\s*8px/);
    expect(rule('.identity-section')).toMatch(/padding:\s*8px 10px/);
    expect(rule('.identity-section-grid')).toMatch(/gap:\s*2px/);
    expect(rule('.deployment-card-identity .identity-fact')).toMatch(/min-height:\s*22px/);
    expect(rule('.identity-fact-value')).toMatch(/min-width:\s*0/);
    expect(CSS).not.toContain('.identity-not-reported');
  });

  it('stacks the two groups cleanly on mobile without clipping values', () => {
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.identity-overview\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
    expect(RESPONSIVE).toMatch(/\.deployment-card-identity \.identity-fact-label\s*\{[^}]*flex-basis:\s*104px/);
    expect(rule('.identity-full-value')).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe('two radii, and no third', () => {
  it('writes every corner as one of the two tokens', () => {
    const radii = [...CSS.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(radii.length).toBeGreaterThan(4);
    // Either spelling of the same two corners: astrolabe-tokens.test.ts holds
    // --ast-radius-control equal to --radius-sm and --ast-radius-card equal to
    // --radius-md, so a rule in the rebuild's spelling is not a third radius.
    const stray = radii.filter((value) => !/^var\(--(?:radius-(?:sm|md)|ast-radius-(?:control|card))\)$/.test(value));
    expect(stray).toEqual([]);
  });
});
