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
const RESPONSIVE = partial('responsive-monitoring.css');

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

describe('the namespaced user profile cannot regress to overlapping layout', () => {
  const profileRules = [...CSS.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1].trim(), body: match[2] }))
    .filter((entry) => entry.selector.includes('.user-profile-modal'));

  it('removes every legacy profile selector from all Monitoring stylesheets', () => {
    const all = `${CSS}\n${RESPONSIVE}\n${partial('dark-monitoring.css')}`;
    for (const legacy of [
      'monitoring-person-',
      'monitoring-panel-grid',
      'monitoring-panel-tile',
      'monitoring-spend',
      'monitoring-grants',
      'monitoring-scopes',
      'monitoring-refusal-tiles',
    ]) {
      expect(all).not.toContain(legacy);
    }
  });

  it('uses one scrolling body with max-content rows and non-shrinking KPI cards', () => {
    const body = rule('.user-profile-modal-body');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overflow-x:\s*visible/);
    expect(body).toMatch(/grid-auto-flow:\s*row/);
    expect(body).toMatch(/grid-auto-rows:\s*max-content/);
    expect(rule('.user-profile-modal-kpi')).toMatch(/min-height:\s*96px/);
    expect(rule('.user-profile-modal-spend')).not.toMatch(/min-height/);
    expect(rule('.user-profile-modal-spend-kpi-loading')).toMatch(/min-height:\s*92px/);
    expect(CSS).not.toContain('user-profile-modal-spend-loading-icon');
  });

  it('forbids seating, clipping, fixed content heights, and overlapping grid areas in the namespace', () => {
    const shell = (selector: string) =>
      /(?:^|,)\s*\.user-profile-modal(?:-overlay|-header|-body)?(?:\s|,|$)/.test(selector);
    for (const { selector, body } of profileRules) {
      expect(body, selector).not.toMatch(/position:\s*absolute/);
      expect(body, selector).not.toMatch(/grid-area\s*:/);
      expect(body, selector).not.toMatch(/margin(?:-(?:top|right|bottom|left))?\s*:\s*-\d/);
      if (!shell(selector)) {
        expect(body, selector).not.toMatch(/(?:^|;)\s*transform\s*:/);
        expect(body, selector).not.toMatch(/overflow:\s*hidden/);
        expect(body, selector).not.toMatch(/(?:^|;)\s*(?:height|max-height)\s*:\s*\d/);
        expect(body, selector).not.toMatch(/(?:^|;)\s*top\s*:/);
      }
    }
  });

  it('keeps profile spend to aggregate KPIs with no component matrix selectors', () => {
    expect(rule('.user-profile-modal-spend-kpis')).toMatch(
      /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.user-profile-modal-spend-kpis\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 480px\)[\s\S]*?\.user-profile-modal-spend-kpis\s*\{[^}]*minmax\(0,\s*1fr\)/
    );
    for (const removed of [
      'user-profile-modal-spend-rows',
      'user-profile-modal-spend-columns',
      'user-profile-modal-spend-resource',
      'user-profile-modal-spend-amount',
      'user-profile-modal-spend-attribution',
      'user-profile-modal-spend-badges',
      'user-profile-modal-spend-quality',
    ]) {
      expect(CSS).not.toContain(removed);
      expect(RESPONSIVE).not.toContain(removed);
    }
  });

  it('wraps long tables and grants without a clipping container', () => {
    expect(rule('.user-profile-modal-table-name')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.user-profile-modal-grant-table')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.user-profile-modal-table-runs')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.user-profile-modal-grants')).not.toMatch(/overflow:\s*hidden/);
  });

  it('turns the dedicated question table into structured cards on narrow screens', () => {
    const narrow = RESPONSIVE.slice(RESPONSIVE.indexOf('@media (max-width: 800px)'));
    expect(narrow).toMatch(/\.user-profile-modal-question-table thead\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.user-profile-modal-question-table td:not\(:first-child\)\s*\{[^}]*display:\s*grid/);
    expect(narrow).toMatch(/content:\s*attr\(data-label\)/);
  });
});

describe('Monitoring details open as centered modals, not side drawers', () => {
  it('keeps the unique profile and browser overlays centered with viewport margins', () => {
    expect(CSS).toMatch(/\.user-profile-modal-overlay,[\s\S]*?position:\s*fixed/);
    expect(CSS).toMatch(/\.user-profile-modal-overlay,[\s\S]*?inset:\s*0/);
    expect(CSS).toMatch(/\.user-profile-modal-overlay,[\s\S]*?z-index:\s*1000/);
    expect(CSS).toMatch(/\.user-profile-modal-overlay,[\s\S]*?place-items:\s*center/);
    expect(CSS).toMatch(/max-height:\s*min\(calc\(100dvh - 40px\),\s*920px\)/);
    expect(CSS).not.toMatch(/\.user-profile-modal-overlay,[\s\S]*?top:\s*var\(--app-header-h\)/);
    const narrow = RESPONSIVE.slice(RESPONSIVE.indexOf('@media (max-width: 800px)'));
    expect(narrow).toMatch(/\.user-profile-modal-overlay,[\s\S]*?padding:\s*12px/);
    expect(narrow).toMatch(/\.user-profile-modal,[\s\S]*?width:\s*calc\(100vw - 24px\)/);
    expect(CSS).not.toContain('.monitoring-drawer {');
  });

  it('gives the user browser a wider shell and readable mobile rows', () => {
    expect(CSS).toMatch(/\.monitoring-users-modal\s*\{\s*width:\s*min\(1080px/);
    expect(rule('.monitoring-user-row')).toMatch(/grid-template-columns/);
    const narrow = RESPONSIVE.slice(RESPONSIVE.indexOf('@media (max-width: 800px)'));
    expect(narrow).toMatch(/\.monitoring-users-columns\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.monitoring-user-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/);
    expect(CSS).not.toContain('.monitoring-user-coverage');
  });

  it('uses one stable user-icon loader with static reduced-motion fallbacks', () => {
    expect(rule('.monitoring-users-loading')).toMatch(/min-height:\s*180px/);
    expect(rule('.monitoring-users-loading-icon')).toMatch(/width:\s*18px/);
    expect(CSS).not.toContain('.monitoring-users-loading-list');
    const reduced = partial('astrolabe-animation.css').slice(
      partial('astrolabe-animation.css').indexOf('@media (prefers-reduced-motion: reduce)')
    );
    expect(reduced).toMatch(/\[class\*='ast-anim-'\]\s*\{[^}]*animation:\s*none/);
    expect(reduced).toMatch(/\.ast-anim-center-pulse\s*\{[^}]*transform:\s*none/);
    expect(partial('appearance-preferences.css')).toMatch(
      /data-animations='off'[\s\S]*\.ast-anim-center-pulse[\s\S]*transform:\s*none/
    );
  });
});

describe('the panel head and identity controls cannot be clipped', () => {
  it('lets the name block shrink so the close button stays on screen', () => {
    expect(rule('.user-profile-modal-user')).toMatch(/min-width:\s*0/);
    expect(rule('.user-profile-modal-close,\n.user-profile-modal-back')).toMatch(/flex:\s*none/);
    expect(rule('.user-profile-modal-user .identity-chip')).toMatch(/max-width:\s*100%/);
  });

  it('seats the compact blue back link at the true header origin', () => {
    expect(rule('.user-profile-modal-header')).toMatch(/padding:\s*12px 16px/);
    expect(CSS).toMatch(
      /\.user-profile-modal-back\s*\{[^}]*justify-self:\s*start[^}]*padding-inline:\s*0[^}]*color:\s*var\(--ast-blue\)/
    );
  });

  it('lets a scope badge wrap rather than overrun the row', () => {
    const scope = rule('.user-profile-modal-scope');
    expect(scope).toMatch(/white-space:\s*normal/);
    expect(scope).toMatch(/max-width:\s*100%/);
    expect(scope).toMatch(/min-width:\s*0/);
    expect(rule('.user-profile-modal-scopes')).toMatch(/flex-wrap:\s*wrap/);
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

  it('uses opaque token-mixed row states without changing row geometry', () => {
    const hover = rule('.monitoring-row:hover,\n.monitoring-row:focus-visible');
    const selected = rule('.monitoring-row-selected');

    expect(hover).toMatch(
      /background:\s*color-mix\(in srgb,\s*var\(--ast-surface-primary\)\s*96%,\s*var\(--ast-blue\)\)/
    );
    expect(hover).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--ast-hairline\)/);
    expect(selected).toMatch(
      /background:\s*color-mix\(in srgb,\s*var\(--ast-surface-primary\)\s*91%,\s*var\(--ast-blue\)\)/
    );
    expect(selected).toMatch(/inset 3px 0 0 var\(--ast-blue\)/);
    for (const state of [hover, selected]) {
      expect(state).not.toMatch(/padding|margin|border-width|transform/);
    }
  });

  it('gives the nested user link a stronger blue state than the row', () => {
    const link = rule('.monitoring-row .user-drilldown-link,\n.monitoring-question-card .user-drilldown-link');
    const active = rule(
      '.monitoring-row .user-drilldown-link:hover .identity-chip,\n.monitoring-row .user-drilldown-link:focus-visible .identity-chip,\n.monitoring-question-card .user-drilldown-link:hover .identity-chip,\n.monitoring-question-card .user-drilldown-link:focus-visible .identity-chip'
    );

    expect(link).toMatch(/cursor:\s*pointer/);
    expect(link).toMatch(/opacity:\s*1/);
    expect(active).toMatch(/border-color:\s*var\(--ast-blue\)/);
    expect(active).toMatch(/color:\s*var\(--ast-info-text\)/);
    expect(active).toMatch(
      /background:\s*color-mix\(in srgb,\s*var\(--ast-surface-primary\)\s*78%,\s*var\(--ast-blue\)\)/
    );
    expect(CSS).not.toContain('.monitoring-question-button');
    expect(CSS).not.toContain('.monitoring-question-card-button');
  });

  it('sets the range beside a heading rather than in the heading’s own voice', () => {
    // It qualifies the section, it is not part of its name. In the eyebrow's own
    // caps and weight it reads as a second heading.
    const range = rule('.user-profile-modal-range');
    expect(range).toMatch(/text-transform:\s*none/);
    expect(range).toMatch(/color:\s*var\(--muted-foreground\)/);
    expect(rule('.user-profile-modal-section-title')).toMatch(/text-transform:\s*uppercase/);
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
  it('keeps the control row unboxed while preserving its alignment rhythm', () => {
    const filters = rule('.monitoring-filters');

    expect(filters).toMatch(/display:\s*flex/);
    expect(filters).toMatch(/align-items:\s*center/);
    expect(filters).toMatch(/flex-wrap:\s*wrap/);
    expect(filters).toMatch(/gap:\s*8px/);
    expect(filters).not.toMatch(/background|border|box-shadow|border-radius|padding/);
  });

  /**
   * AppKit paints the input transparent. The chips beside it paint `--card`.
   * The fill is the whole of this rule: size and placement stay on
   * `.monitoring-search`, which is what the wrap arithmetic reads.
   */
  it('paints the field with elevated glass and does not resize it', () => {
    const input = rule('.monitoring-filters .monitoring-search input');

    expect(input).toMatch(/background:\s*var\(--ast-surface-elevated\)/);
    expect(input).toMatch(/backdrop-filter:\s*none/);
    expect(input).toMatch(/filter:\s*none/);
    expect(rule('.monitoring-filters .monitoring-search input')).not.toMatch(/height:|min-width:|flex:|margin-left:/);
    expect(rule('.monitoring-search')).toMatch(/flex:\s*0\s+1\s+240px/);
    expect(rule('.monitoring-search')).toMatch(/min-width:\s*160px/);
    expect(rule('.monitoring-filter-actions')).toMatch(/margin-left:\s*auto/);
    expect(rule('.monitoring-search')).toMatch(/margin-left:\s*auto/);
    expect(rule('.monitoring-user-browser-trigger')).toMatch(/height:\s*36px/);
    expect(rule(".monitoring-search input[type='search']")).toMatch(/height:\s*36px/);
    expect(rule('.monitoring-filter-actions')).toMatch(/align-items:\s*center/);
    expect(rule('.monitoring-filter-actions')).toMatch(/gap:\s*8px/);
  });

  it('keeps a crisp standard-size icon above the field backdrop', () => {
    const wrapper = rule('.monitoring-search');
    const icon = rule('.monitoring-search .monitoring-search-icon');
    const input = rule(".monitoring-search input[type='search']");
    const clear = rule('.monitoring-search-clear');

    expect(wrapper).toMatch(/isolation:\s*isolate/);
    expect(wrapper).toMatch(/background:\s*var\(--ast-surface-elevated\)/);
    expect(icon).toMatch(/width:\s*16px/);
    expect(icon).toMatch(/height:\s*16px/);
    expect(icon).toMatch(/top:\s*50%/);
    expect(icon).toMatch(/transform:\s*translateY\(-50%\)/);
    expect(icon).toMatch(/color:\s*var\(--ast-text-long\)/);
    expect(icon).toMatch(/opacity:\s*1/);
    expect(icon).toMatch(/filter:\s*none/);
    expect(icon).toMatch(/backdrop-filter:\s*none/);
    expect(icon).not.toMatch(/blur\(|grayscale\(|drop-shadow\(/);
    expect(icon).toMatch(/z-index:\s*2/);
    expect(input).toMatch(/z-index:\s*1/);
    expect(clear).toMatch(/z-index:\s*3/);
  });

  it('reserves the icon gutter and uses contrast tokens in every state', () => {
    expect(rule(".monitoring-search input[type='search']")).toMatch(/padding-left:\s*34px/);
    expect(rule('.monitoring-search:hover .monitoring-search-icon')).toMatch(/color:\s*var\(--foreground\)/);
    expect(rule('.monitoring-search:focus-within .monitoring-search-icon')).toMatch(/color:\s*var\(--ast-info-text\)/);
    const disabled = rule('.monitoring-search:has(input:disabled) .monitoring-search-icon');
    expect(disabled).toMatch(/color:\s*var\(--ast-text-secondary\)/);
    expect(disabled).toMatch(/opacity:\s*1/);
  });

  it('uses the same elevated, blur-free field layer in dark mode', () => {
    const dark = rule("html[data-theme='dark'] .monitoring-page .monitoring-search input");

    expect(dark).toMatch(/background:\s*var\(--ast-surface-elevated\)/);
    expect(dark).toMatch(/filter:\s*none/);
    expect(dark).toMatch(/backdrop-filter:\s*none/);
  });
});

describe('the figures line up and the palette is the palette', () => {
  const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('uses one card rhythm and anchors every subtitle to the same row', () => {
    const tile = rule('.monitoring-tile');

    expect(tile).toMatch(/padding:\s*12px\s+14px/);
    expect(tile).toMatch(/grid-template-rows:\s*auto\s+1fr\s+auto/);
    expect(tile).toMatch(/min-height:\s*82px/);
    expect(tile).toMatch(/gap:\s*4px/);
    expect(rule('.monitoring-outcomes-tile')).toMatch(/grid-template-rows:\s*auto\s+1fr\s+auto/);
    expect(rule('.monitoring-tile-head')).toMatch(/justify-content:\s*space-between/);
    expect(rule('.monitoring-period-badge')).toMatch(/white-space:\s*nowrap/);
  });

  it('keeps outcome labels and values in one four-column metric grid', () => {
    const grid = rule('.monitoring-outcome-grid');
    const metric = rule('.monitoring-outcome-metric');
    const value = rule('.monitoring-outcome-value');

    expect(grid).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(metric).toMatch(/display:\s*grid/);
    expect(metric).toMatch(/gap:\s*4px/);
    expect(value).toMatch(/font-size:\s*var\(--text-kpi\)/);
    expect(value).toMatch(/font-weight:\s*700/);
    expect(value).toMatch(/min-width:\s*0/);
  });

  it('keeps zero outcome values visible without making them dominant', () => {
    const zero = rule('.monitoring-outcome-value-zero');
    const opacity = Number.parseFloat(zero.match(/opacity:\s*([\d.]+)/)?.[1] ?? 'NaN');

    expect(opacity).toBeGreaterThan(0.5);
    expect(opacity).toBeLessThan(1);
    expect(zero).not.toMatch(/display:\s*none|visibility:\s*hidden|color:\s*transparent/);
  });

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
    expect(rule('.monitoring-partial')).toMatch(/color:\s*var\(--ast-warn-text\)/);
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
