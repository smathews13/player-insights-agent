import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';

/**
 * The BRAND renders lowercase in lockups, headers and labels, and nothing in the
 * cascade quietly re-capitalises it. Ordinary sentence copy is left alone.
 *
 * This is deliberately NOT a rule that lowercases every title. The plan card
 * heading "Proposed analysis plan" is sentence prose and stays sentence case;
 * what must be lowercase is the astrolabe wordmark and the lockups it leads, such
 * as the ask hero chip "astrolabe player intelligence".
 *
 * Two ways a lowercase lockup shows up capitalised, and this file guards both.
 * One is the obvious one: somebody types "Astrolabe Player Intelligence" into the
 * source. The other is the render-time one that a grep on the string cannot find:
 * the source is lowercase and a `text-transform: capitalize` on the element (or
 * an ancestor) paints it Title Case at render.
 */

const PLAN_CARD = readFileSync(new URL('PlanCard.tsx', import.meta.url), 'utf8');
const HOME_PAGE = readFileSync(new URL('HomePage.tsx', import.meta.url), 'utf8');
const ASK_CSS = partial('ask.css');
const STYLESHEET = stylesheet();

/** Comments stripped, so a word set in prose is not read as a rendered string. */
function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

/** One CSS rule body, by exact selector. */
function body(selector: string, css: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    css
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? ''
  );
}

describe('the plan card title is sentence prose, left as written', () => {
  const planSource = withoutComments(PLAN_CARD);

  it('renders "Proposed analysis plan" in sentence case', () => {
    // Sam's call: the plan heading is prose, not a brand lockup, so it keeps its
    // sentence capitalisation. This pins it against a well-meaning lowercasing.
    expect(planSource).toContain('>Proposed analysis plan<');
  });

  it('is not all-lowercased or Title-Cased', () => {
    expect(planSource).not.toContain('>proposed analysis plan<');
    expect(planSource).not.toMatch(/>Proposed Analysis Plan</);
  });
});

describe('the ask hero chip is the exact lowercase brand lockup', () => {
  const homeSource = withoutComments(HOME_PAGE);

  it('renders "astrolabe player intelligence", all lowercase', () => {
    expect(homeSource).toContain('astrolabe player intelligence');
  });

  it('does not render a capitalised lockup', () => {
    expect(homeSource).not.toContain('Astrolabe Player Intelligence');
    expect(homeSource).not.toContain('Astrolabe player intelligence');
    expect(homeSource).not.toMatch(/Astrolabe\s+[Pp]layer\s+[Ii]ntelligence/);
  });

  it('does not capitalise the chip through CSS on the chip or its mark', () => {
    for (const selector of ['.ask-hero-chip', '.ask-hero-chip-mark']) {
      expect(body(selector, ASK_CSS)).not.toMatch(/text-transform:\s*(uppercase|capitalize)/);
    }
  });

  /**
   * The transform can hide on an ancestor. There is no `.ask-hero*` rule anywhere
   * in the cascade that upper- or title-cases its subtree; this fails if one is
   * introduced, which is the render-time bug grep on the string cannot see.
   */
  it('has no ask-hero rule anywhere that transforms case', () => {
    const askHeroRules = STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, ' ').match(
      /\.ask-hero[\w-]*\s*\{[^{}]*\}/g,
    );
    for (const rule of askHeroRules ?? []) {
      expect(rule).not.toMatch(/text-transform:\s*(uppercase|capitalize)/);
    }
  });
});
