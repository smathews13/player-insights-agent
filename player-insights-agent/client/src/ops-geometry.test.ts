import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

/**
 * What the Ops tab's stylesheet has to keep saying, in the pattern
 * connections-geometry.test.ts established.
 *
 * This tab is the most numeric surface in the app and the least certain: three of
 * its six cost figures are apportionments, one is a rate, and the block carrying
 * them is badged Experimental and Under development. Both facts decide what the
 * stylesheet is allowed to do. The figures have to line up, because a grid of
 * currency a reader compares down a column is the one arrangement where
 * proportional digits are visible on a single screen. And nothing here may be
 * loud, because a page whose argument is "most of these numbers will not bear
 * weight" cannot have the brightest colours in the app on it.
 *
 * Read against the stylesheet rather than a browser: this repo has no jsdom, and
 * the claims a browser would have to confirm are named in the handover instead.
 */

const CSS = partial('ops.css');
const RESPONSIVE = partial('responsive.css');

/** Comments stripped, so a token discussed in prose is not read as one in use. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * One rule's body, by exact selector, and a failure rather than an empty string
 * when the selector is missing. Several assertions below are negative, and a
 * missing selector would satisfy every one of them while the tab said nothing.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = RULES.match(new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[2];
  expect(body, `ops.css has no rule for ${selector}`).toBeDefined();
  return body!;
}

describe('the figures line up', () => {
  it('keeps resource-status badges compact and never wraps the two-part label', () => {
    expect(rule('.ops-pill')).toMatch(/font-size:\s*var\(--ast-fs-11\)/);
    expect(rule('.ops-pill')).toMatch(/padding:\s*1px 6px/);
    expect(rule('.ops-platform-pill')).toMatch(/display:\s*inline-flex/);
    expect(rule('.ops-platform-pill')).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule('.ops-platform-pill')).toMatch(/white-space:\s*nowrap/);
    expect(rule('td.ops-col-result .ops-platform-pill')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.ops-table-scroll')).toMatch(/overflow-x:\s*auto/);
    expect(rule('.ops-health-table')).toMatch(/min-width:\s*680px/);
  });

  /**
   * THE DEFECT THIS REPLACED, and it tested green for as long as it existed.
   *
   * Both of these asked for tabular figures with `font-variant-numeric` on DM
   * Sans. DM Sans in this repo declares no `tnum` feature -- its GSUB carries
   * calt, ccmp, dnom, frac, liga, locl and numr -- so the property had nothing to
   * switch on and did nothing, silently. Its digits are proportional and not
   * marginally: at 1000 units per em a `1` is 342 and a `0` is 656, so `$1.10`
   * and `$8.88` in one column genuinely do not share an edge.
   *
   * The latency cells set the family in the rule because every cell in the
   * selector is a figure. The tile figure carries `.ast-num` in the markup
   * instead, because the phrase beside it must NOT be mono, and that is asserted
   * in ops-render.test.tsx where the markup is.
   */
  it('sets the latency columns in the one face that can align them', () => {
    const cells = rule('.ops-latency-table td');
    expect(cells).toMatch(/font-family:\s*var\(--font-mono\)/);
    // Right-aligned, which is the reason it matters: right alignment exists to
    // make a column of figures share an edge.
    expect(cells).toMatch(/text-align:\s*right/);
  });

  it('leaves no rule claiming tabular figures it cannot get', () => {
    // Every surviving `tabular-nums` in this file has to sit beside a mono family,
    // where it is redundant rather than false and becomes meaningful again if a
    // tnum-capable DM Sans is ever sourced.
    const claiming = [...RULES.matchAll(/\{([^}]*font-variant-numeric[^}]*)\}/g)].map((match) => match[1]);
    expect(claiming.length).toBeGreaterThan(0);
    for (const body of claiming) {
      expect(body, `a rule asks for tabular figures without a mono family: ${body.trim()}`).toMatch(
        /font-family:\s*var\(--font-mono\)/
      );
    }
  });

  /** The stat value is not one of them any more: the class is in the markup. */
  it('stops the tile figure asking DM Sans for the feature', () => {
    expect(rule('.ops-tile-figure')).not.toMatch(/font-variant-numeric/);
  });

  it('reserves readable widths for every latency figure column', () => {
    expect(rule('.ops-latency-table')).toMatch(/table-layout:\s*fixed/);
    expect(rule('.ops-latency-table')).toMatch(/min-width:\s*760px/);
    expect(rule('.ops-lat-col-hit')).toMatch(/width:\s*70px/);
    expect(rule('.ops-lat-col-spans')).toMatch(/width:\s*56px/);
    expect(rule('.ops-lat-col-p50')).toMatch(/width:\s*64px/);
    expect(rule('.ops-lat-col-bar')).toMatch(/width:\s*150px/);
    expect(rule('.ops-lat-col-slowest')).toMatch(/width:\s*70px/);
  });

  /**
   * TREND WAS 132px, which is shorter than the "Slower than baseline" pill plus
   * its padding and rounded end. Extra table width went to the route column, so
   * the badge clipped at the card edge while empty space sat on the left.
   */
  it('gives TREND a min-width that fits Slower than baseline and keeps the badge on one line', () => {
    const col = rule('.ops-lat-col-trend');
    const colMin = Number(/min-width:\s*(\d+)px/.exec(col)?.[1]);
    expect(colMin, '.ops-lat-col-trend min-width').toBeGreaterThanOrEqual(188);

    const cell = rule('.ops-lat-trend');
    const cellMin = Number(/min-width:\s*(\d+)px/.exec(cell)?.[1]);
    expect(cellMin, '.ops-lat-trend min-width').toBeGreaterThanOrEqual(188);
    expect(cell).toMatch(/white-space:\s*nowrap/);

    expect(rule('.ops-lat-trend .ops-pill')).toMatch(/white-space:\s*nowrap/);
  });

  it('keeps the latency search wide enough for its placeholder', () => {
    const search = rule('.ops-latency-head-controls .ops-latency-search');
    expect(search).toMatch(/min-width:\s*280px/);
    expect(search).toMatch(/flex:\s*1\s+0\s+280px/);
  });

  /**
   * AppKit's field is 36px. Refresh is 32px and the TREND pills sit on that
   * rail, so the search was the one control that stuck up. 32px is the app's
   * control height; this pins it without touching Monitoring's field.
   */
  it('keeps the latency search at the 32px control height', () => {
    const field = rule('.ops-latency-head-controls .ops-latency-search input');
    expect(field).toMatch(/height:\s*32px/);
    expect(field).toMatch(/min-height:\s*32px/);
    expect(field).toMatch(/max-height:\s*32px/);
    expect(field).toMatch(/padding-top:\s*0/);
    expect(field).toMatch(/padding-bottom:\s*0/);
  });

  it('keeps the TREND pills the same 32px height as search and Refresh', () => {
    const pill = rule('.ops-latency-trend-filter');
    expect(pill).toMatch(/height:\s*32px/);
    expect(pill).toMatch(/align-items:\s*center/);
  });

  it('keeps the TREND pills on the same header rail as search, not a second row', () => {
    expect(rule('.ops-latency-block .ops-block-head')).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule('.ops-latency-head-controls')).toMatch(/flex-wrap:\s*nowrap/);
    expect(rule('.ops-latency-trend-filters')).toMatch(/flex:\s*0\s+0\s+auto/);
  });
});

describe('the traffic groups share the row', () => {
  it('keeps the questions, causes, and tools in three equal columns', () => {
    expect(rule('.ops-charts')).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(rule('.ops-charts')).toMatch(/gap:\s*16px/);
  });

  it('uses the specified label width without crowding tool bars', () => {
    expect(rule('.ops-chart-tool .ops-bar-row')).toMatch(/minmax\(0,\s*110px\)\s+1fr\s+auto/);
  });
});

describe('the Cost assumptions and actuals stay separate', () => {
  it('uses the shared assumption grid for one desktop row and a read-only projection-style matrix', () => {
    expect(rule('.ops-ticker-assumption-grid')).toMatch(
      /grid-template-columns:\s*repeat\(var\(--ops-assumption-columns\),\s*minmax\(0,\s*1fr\)\)/
    );
    expect(rule('.ops-cost-budget-matrix')).toMatch(/table-layout:\s*fixed/);
    expect(rule('.ops-forecast-breakdown table')).toMatch(/min-width:\s*620px/);
    expect(rule('.ops-tile-budget')).not.toMatch(/display:\s*grid/);
  });

  it('reserves room for long values, unit affixes, and visible arrow controls', () => {
    expect(rule('.ops-number-ticker-wide')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+24px/);
    expect(rule('.ops-number-ticker-wide')).toMatch(/width:\s*min\(100%,\s*14rem\)/);
    expect(rule(".ops-number-ticker[data-prefix='true'] input")).toMatch(/padding-left:\s*22px/);
    expect(rule(".ops-number-ticker[data-suffix='true'] input")).toMatch(/padding-right:\s*40px/);
    expect(RULES).toMatch(/\.ops-number-ticker-suffix\s*\{[^}]*right:\s*32px/);
    expect(rule('.ops-budget-actual')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('deliberately reflows the six assumptions through 3, 2, and 1 columns', () => {
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 800px\)[\s\S]*\.ops-ticker-assumption-grid\[data-columns='6'\]\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(RESPONSIVE).toMatch(
      /@container \(max-width: 640px\)[\s\S]*\.ops-ticker-assumption-grid\[data-columns='6'\]\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
    );
    expect(RULES).toMatch(/\.ops-cost-resource-budgets\s*\{[^}]*container-type:\s*inline-size/);
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.ops-ticker-assumption-grid\[data-columns='6'\],[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
    );
  });

  it('aligns the App ticker, Apply, and status on the same control-height rail', () => {
    expect(rule('.ops-cost-total .ops-ticker-input-row')).toMatch(/display:\s*grid/);
    expect(rule('.ops-cost-total .ops-ticker-input-row')).toMatch(/align-items:\s*stretch/);
    expect(rule('.ops-ticker-input-row')).toMatch(/--ops-ticker-control-height:\s*36px/);
    expect(rule('.ops-number-ticker-wide input')).toMatch(/height:\s*var\(--ops-ticker-control-height,\s*36px\)/);
    expect(rule('.ops-cost-total .ops-budget-apply')).toMatch(/height:\s*var\(--ops-ticker-control-height\)/);
    expect(rule('.ops-app-budget-status')).toMatch(/height:\s*var\(--ops-ticker-control-height\)/);
    expect(RESPONSIVE).toMatch(
      /@media \(max-width: 480px\)[\s\S]*\.ops-cost-total \.ops-ticker-input-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/
    );
  });
});

describe('nothing on this tab is louder than what it is reporting', () => {
  /**
   * NO ORANGE, which §2 states as a palette rule and this tab was breaking in one
   * place: the substituted-window note was `--db-warn-600` #BE501E. That is not
   * amber. It is close enough to `--db-orange` to read as it, on the one line of
   * the tab that is allowed to be loud, so it was also the most visible pixel
   * here.
   *
   * The replacement is the deep amber rung, which is the palette's text weight for
   * that family, and it is louder rather than quieter: 5.79:1 on white against
   * #BE501E's 4.82.
   */
  it('uses no orange', () => {
    expect(RULES).not.toMatch(/--db-orange|--db-warn-600|#FF3621|#ff3621|#BE501E|#be501e/);
  });

  /**
   * Two charts, two colours, and the muting is the point rather than a side
   * effect. `ops-tab.md` names them: failure bars #A04A62, refusal bars #46596B.
   * They were DuBois `--db-red-600` #C82D4C and `--db-grey-blue` #445461, one step
   * brighter and one step darker, and a bar chart of failures in DuBois red is the
   * loudest thing on a page badged Experimental.
   */
  it('draws failures and refusals in the palette’s own two families', () => {
    expect(rule('.ops-chart-failure .ops-bar-fill')).toMatch(/background:\s*var\(--ast-neg-text\)/);
    expect(rule('.ops-chart-refusal .ops-bar-fill')).toMatch(/background:\s*var\(--ast-neutral-text\)/);
    // And never one series. Two selectors, two fills, no shared rule.
    expect(rule('.ops-chart-failure .ops-bar-fill')).not.toEqual(rule('.ops-chart-refusal .ops-bar-fill'));
  });

  /**
   * The cost block is greyed, and by wash rather than by `opacity`. Opacity on the
   * section would take the border, the band and the two badges down with the
   * figures, and at the strength that reads as unfinished it puts body text under
   * the ratio it needs.
   */
  it('greys the unfinished block without dimming the words that say so', () => {
    expect(rule('.ops-block-unfinished .ops-block-body')).toMatch(/background:\s*var\(--ast-fill-band\)/);
    expect(rule('.ops-block-unfinished .ops-block-body')).not.toMatch(/opacity/);
    expect(rule('.ops-block-unfinished .ops-tile-figure')).toMatch(/color:\s*var\(--ast-text-secondary\)/);
  });
});

describe('the type scale and the two radii', () => {
  /**
   * §3 gives eight rungs: 11, 12, 13, 14, 16, 18, 22, 32. This file had five
   * declarations off it -- 20px, 15px and 10px three times -- which is the largest
   * concentration in the app after trace.css. A stray size is not a visible bug on
   * its own; five of them is a surface that does not share a scale with the page
   * next to it.
   */
  it('writes every size as a rung of the scale', () => {
    const sizes = [...RULES.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(sizes.length).toBeGreaterThan(10);
    const stray = sizes.filter((value) => !/^var\(--(ast-fs-\d+|text-[\w-]+)\)$/.test(value));
    expect(stray).toEqual([]);
  });

  it('writes every corner as a token or a shape', () => {
    const radii = [...RULES.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
    const stray = radii.filter(
      (value) =>
        !/^var\(--(?:radius-(?:sm|md)|ast-radius-(?:control|card))\)$/.test(value) &&
        // A 2px bar and a 2px bar top. Both are 8px tall and 4px would round them
        // into lozenges, which is the same exception timeline.css carries.
        !['2px', '2px 2px 0 0', '50%', '999px', '0'].includes(value)
    );
    expect(stray).toEqual([]);
  });
});
