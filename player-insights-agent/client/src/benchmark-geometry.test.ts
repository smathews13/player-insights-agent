import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

/**
 * What the Benchmark Lab's stylesheet has to keep saying, in the pattern
 * connections-geometry.test.ts established.
 *
 * This page's whole argument is about how much weight a number will bear: which
 * scores are deterministic, which are a language model's opinion, what population
 * each rate is over. Two things follow for the stylesheet. Amber means evaluation
 * and nothing else, in the three places §9 names and no fourth. And the figures
 * have to line up, because every one of them is read down a column or across a
 * row of tiles against another figure.
 */

const CSS = `${partial('summary-grid.css')}\n${partial('benchmark.css')}`;

/** Comments stripped, so a token discussed in prose is not read as one in use. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = RULES.match(new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[2];
  expect(body, `benchmark.css has no rule for ${selector}`).toBeDefined();
  return body!;
}

describe('amber marks evaluation, in the palette’s own amber', () => {
  /**
   * §9: "Amber marks evaluation only: thick tile rule, column underline, star
   * fill." Three places, and the hue in all three was DuBois #FFAB00 -- a bright
   * gold that reads as the orange §2 removed from the palette. The astrolabe
   * family is #8A6A38, and the saturated rung rather than the #E0D3B8 hairline
   * because all three uses are filled masses.
   */
  it('paints the three evaluation marks from the warning family', () => {
    expect(rule(".summary-grid [data-slot='card'].benchmark-score")).toMatch(
      /border-top:\s*4px solid var\(--ast-warn-text\)/
    );
    expect(rule(".table-scroll:not(.bench-cases) [data-slot='table'] thead th:last-child")).toMatch(
      /border-bottom:\s*3px solid var\(--ast-warn-text\)/
    );
    expect(rule('.stars svg')).toMatch(/fill:\s*var\(--ast-warn-text\)/);
  });

  it('keeps amber off the type, which is the rule that goes with it', () => {
    // The tile's label and caption take the deep rung; the value stays ink.
    expect(
      rule(
        ".summary-grid [data-slot='card'].benchmark-score span,\n.summary-grid [data-slot='card'].benchmark-score small"
      )
    ).toMatch(/color:\s*var\(--ast-warn-deep\)/);
  });

  it('names no DuBois status wash anywhere on the page', () => {
    // The five this file used to carry: a brighter green, an orange-leaning amber
    // and their washes and hairlines.
    for (const token of [
      '--db-amber',
      '--db-green-600',
      '--db-green-wash',
      '--db-green-line',
      '--db-red-wash',
      '--db-warn-600',
    ]) {
      expect(RULES, `benchmark.css still names ${token}`).not.toContain(`var(${token})`);
    }
  });
});

describe('the one status recipe, with nothing left to override it', () => {
  /**
   * THE THREE DEAD RULES, HELD OUT BY NAME.
   *
   * The scorer-kind pill is `astPill('neutral-outline', ...)` now, and nothing in
   * the app emits `tone-deterministic`, `tone-judged` or `tone-operational`. The
   * rules that painted them were left behind by the convergence, and a dead rule
   * is not harmless: it is how a converged recipe comes apart, not by being
   * changed but by an old rule still being there to win the moment somebody
   * reintroduces the class.
   */
  it('has no rule left for a pill nothing draws', () => {
    for (const dead of ['tone-deterministic', 'tone-judged', 'tone-operational']) {
      expect(RULES, `benchmark.css still paints .bench-pill.${dead}`).not.toContain(`.bench-pill.${dead}`);
    }
  });
});

describe('the figures line up', () => {
  /**
   * Every rule on this page that claimed tabular figures claimed them of DM Sans,
   * which declares no `tnum` feature, so none of them got any: a column of
   * durations jittered by most of a digit width as the numbers changed, and the
   * five summary tiles did not align with each other.
   *
   * The two table classes take the family in the rule, because every element they
   * are on is a figure and a class per cell across a table that pages is a place
   * for one to be missed. The tiles and the rating take `.ast-num` in the markup,
   * because the tile's caption and the star beside the rating must not be mono.
   */
  it('sets the two column classes in the face that can align them', () => {
    for (const selector of ['.bench-num', '.bench-when']) {
      expect(rule(selector)).toMatch(/font-family:\s*var\(--font-mono\)/);
    }
    expect(rule('.bench-num')).toMatch(/text-align:\s*right/);
  });

  it('leaves no rule asking DM Sans for a feature its files do not carry', () => {
    const claiming = [...RULES.matchAll(/\{([^}]*font-variant-numeric[^}]*)\}/g)].map((match) => match[1]);
    for (const body of claiming) {
      expect(body, `a rule asks for tabular figures without a mono family: ${body.trim()}`).toMatch(
        /font-family:\s*var\(--font-mono\)/
      );
    }
  });

  it('stops the tile value and the rating claiming it from the stylesheet', () => {
    // Both carry `.ast-num` in the markup instead, which is asserted in
    // benchmark-render.test.tsx where the markup is.
    expect(rule('.summary-grid strong')).not.toMatch(/font-variant-numeric/);
    expect(rule('.stars')).not.toMatch(/font-variant-numeric/);
  });
});

describe('the type scale', () => {
  it('writes every size as a rung of the scale', () => {
    const sizes = [...RULES.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(sizes.length).toBeGreaterThan(5);
    const stray = sizes.filter((value) => !/^var\(--(ast-fs-\d+|text-[\w-]+)\)$/.test(value));
    expect(stray).toEqual([]);
  });
});

describe('the how-to pane', () => {
  it('numbers the steps from the list, not from the copy', () => {
    expect(rule('.eval-steps')).toMatch(/list-style:\s*decimal/);
    expect(rule('.eval-steps')).toMatch(/list-style-position:\s*outside/);
  });
});

describe('the v3 Lab chrome', () => {
  it('sets the tab to the 1080px reference column and 16px rhythm', () => {
    expect(rule('.benchmark-lab')).toMatch(/max-width:\s*1080px/);
    expect(rule('.benchmark-lab')).toMatch(/gap:\s*16px/);
  });

  it('gives every Lab button the same 30px box', () => {
    expect(rule('.bench-btn')).toMatch(/height:\s*30px/);
    expect(rule('.bench-btn-primary')).toMatch(/background:\s*var\(--db-blue-tint\)/);
    expect(rule('.bench-btn-secondary')).toMatch(/border:\s*1px solid var\(--ast-border-input\)/);
    expect(rule('.bench-btn:disabled')).toMatch(/cursor:\s*not-allowed/);
  });

  it('draws 28px mono nodes on the ice-blue spine', () => {
    expect(rule('.bench-stage-node')).toMatch(/width:\s*28px/);
    expect(rule('.bench-stage-node')).toMatch(/height:\s*28px/);
    expect(rule('.bench-stage-node')).toMatch(/border-radius:\s*50%/);
    expect(rule('.bench-pipeline::before')).toMatch(/rgba\(143,\s*193,\s*232,\s*0\.35\)/);
  });

  it('keeps the contract strip at six hairline cells', () => {
    expect(rule('.bench-contract')).toMatch(/grid-template-columns:\s*repeat\(6/);
    expect(rule('.bench-contract')).toMatch(/min-height:\s*52px/);
  });

  it('paints comparison deltas in the north-star teal and rose', () => {
    expect(rule('.bench-delta-pos')).toMatch(/#9ad6ce/i);
    expect(rule('.bench-delta-neg')).toMatch(/#e8a9b8/i);
  });

  it('sets the six region min-heights from the 1080px reference', () => {
    expect(rule('#lab-pipeline')).toMatch(/min-height:\s*740px/);
    expect(rule('#lab-evaluation-set')).toMatch(/min-height:\s*600px/);
    expect(rule('#lab-genie-accuracy')).toMatch(/min-height:\s*560px/);
    expect(rule('#lab-run-comparison')).toMatch(/min-height:\s*560px/);
    expect(rule('#lab-failure')).toMatch(/min-height:\s*480px/);
    expect(rule('#lab-held-out')).toMatch(/min-height:\s*520px/);
  });

  it('draws the overlay drawer, tag capsules, three-cell SQL, and salmon audit banner', () => {
    expect(rule('.bench-failure-drawer')).toMatch(/position:\s*absolute/);
    expect(rule('.bench-failure.is-open .bench-failure-list')).toMatch(/opacity:\s*0\.4/);
    expect(rule('.bench-tag-capsule')).toMatch(/border-radius:\s*999px/);
    expect(rule('.bench-sql-triple')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)/
    );
    expect(rule('.bench-sql-triple pre')).toMatch(/overflow:\s*visible/);
    expect(rule('.bench-audit-banner')).toMatch(/rgba\(232,\s*168,\s*152/);
    expect(rule('.bench-chip-fixed')).toMatch(/#9ad6ce/i);
    expect(rule('.bench-chip-broken')).toMatch(/#e8a9b8/i);
  });
});
