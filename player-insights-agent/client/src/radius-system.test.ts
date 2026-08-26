import { describe, expect, it } from 'vitest';

import { partial, partialNames } from './styles/stylesheet';

/**
 * Two radii, and no third, across the whole stylesheet rather than one partial.
 *
 * gate-geometry.test.ts already makes this claim about gate.css. The reason it is
 * worth making globally is the failure it would have caught: architecture.css
 * named `var(--radius-lg)` at six call sites and nothing in this app declares it,
 * so the six corners were being drawn by whatever AppKit's imported stylesheet
 * happened to carry -- which turned out to be Tailwind's own default theme, at
 * 0.5rem. It looked right, it tested green, and it was 8px by coincidence rather
 * than by decision. An undefined token is not a subtle bug that shows up as a
 * wrong corner; it is a corner the app does not own, and the next dependency bump
 * is entitled to move it.
 *
 * So the assertion is not "these corners are 8px". It is "every radius this app
 * asks for is one this app declares".
 */

const RADIUS_TOKENS = /--radius-[\w-]+/g;

/** Comments stripped, so a token discussed in prose is not read as one in use. */
function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

describe('the radius vocabulary', () => {
  it('declares exactly two radii in tokens.css', () => {
    const declared = [...withoutComments(partial('tokens.css')).matchAll(/(--radius-[\w-]+)\s*:/g)].map(
      (match) => match[1],
    );
    expect(declared.sort()).toEqual(['--radius-md', '--radius-sm']);
  });

  it('never names a radius token the app does not declare', () => {
    // The whole stylesheet, not just the partials this pass touched: a name that
    // resolves through a dependency is the same defect wherever it is written.
    const undeclared = new Map<string, string[]>();
    for (const name of partialNames()) {
      const used = [...new Set(withoutComments(partial(name)).match(RADIUS_TOKENS) ?? [])].filter(
        (token) => token !== '--radius-sm' && token !== '--radius-md',
      );
      if (used.length > 0) undeclared.set(name, used);
    }
    expect([...undeclared]).toEqual([]);
  });
});

/**
 * Every corner that is a corner rather than a shape, in the partials this pass
 * reached, with the exceptions named one at a time.
 *
 * A shape is not a radius: `50%` is a circle, `999px` is a pill and `0` is a
 * square, and none of the three is choosing a rounding. What is left are the
 * values that ARE choosing one, and the six that were choosing their own -- 5px
 * twice, 6px twice, 7px and 9px -- were doing it silently, so a reader had no way
 * to tell a considered exception from a number somebody typed.
 *
 * The exceptions below are the considered ones, and they carry their reason.
 */
const SHAPES = new Set(['50%', '999px', '0']);

/**
 * The two radii, in either spelling.
 *
 * `--ast-radius-control` and `--ast-radius-card` are the astrolabe names for the
 * same two corners, and `astrolabe-tokens.test.ts` holds each equal to its
 * `--radius-*` twin while both sets are live. So a rule written in the astrolabe
 * spelling is not a third radius: it is one of these two, asked for by the name
 * the rebuild uses. Accepting both is what lets a surface be converted a
 * stylesheet at a time without either spelling reading as a stray.
 */
const TWO_RADII = /^var\(--(?:radius-(?:sm|md)|ast-radius-(?:control|card))\)$/;

const EXCEPTIONS: Record<string, { value: string; because: string }[]> = {
  'ask.css': [
    {
      value: '8px 8px 2px 8px',
      because: 'the panel radius on three corners and a near-square notch on the one pointing at the avatar',
    },
  ],
  // rail.css had one: the conversation row's literal 8px, which equalled
  // --radius-md and predated this system. The row is a card now and asks for the
  // token by name, so the exception is retired rather than carried.
  'timeline.css': [
    { value: '2px', because: 'a 10px Gantt bar; 4px would round it into a lozenge' },
    { value: '2px', because: 'the same bar in the trace timeline' },
    { value: '2px', because: 'the run envelope drawn around it, which has to match' },
  ],
  'runs.css': [
    {
      value: '3px',
      because: 'inline identifier chips on a stored answer; 4px would round a one-line mark into a lozenge',
    },
  ],
};

describe('two radii, and the exceptions say why they are exceptions', () => {
  const OWNED = [
    'animation.css',
    'architecture.css',
    'ask.css',
    'benchmark.css',
    'composer.css',
    'connections.css',
    'gate.css',
    'rail.css',
    'runs.css',
    'timeline.css',
    'tokens.css',
  ];

  for (const name of OWNED) {
    it(`${name} writes every corner as a token, a shape, or a documented exception`, () => {
      const radii = [...withoutComments(partial(name)).matchAll(/border-radius:\s*([^;]+);/g)].map((match) =>
        match[1].trim(),
      );
      const allowed = (EXCEPTIONS[name] ?? []).map((exception) => exception.value);
      const stray = radii.filter(
        (value) => !TWO_RADII.test(value) && !SHAPES.has(value) && !allowed.includes(value),
      );
      expect(stray).toEqual([]);
      // And the exception list does not outlive the exceptions: an entry that no
      // longer matches anything is a comment claiming a decision nobody made.
      for (const { value } of EXCEPTIONS[name] ?? []) expect(radii).toContain(value);
    });
  }

  it('leaves the 2px bars alone, because 4px would round them into lozenges', () => {
    // Both are 10px tall. This is the one place a value outside the two radii is
    // the right answer, and it is worth pinning so a tidy-up does not take it.
    const timeline = withoutComments(partial('timeline.css'));
    for (const selector of ['.trace-bar', '.trace-bar-run']) {
      const body = timeline.match(new RegExp(`(^|\\})\\s*\\${selector}\\s*\\{([^}]*)\\}`, 'm'))?.slice(2);
      expect(body, `timeline.css has no rule for ${selector}`).toBeDefined();
      expect(body![0]).toMatch(/border-radius:\s*2px/);
      expect(body![0]).toMatch(/height:\s*10px/);
    }
  });
});

describe('the architecture page, which is where the undeclared one was', () => {
  const CSS = withoutComments(partial('architecture.css'));

  /**
   * There were six panels here and there are four, because the rebuild replaced
   * the status line, the two paired columns and the visible text equivalent with
   * a tile strip, one drawing and two rails. The number is pinned rather than
   * bounded so that a panel arriving without a decision about its corner fails
   * here.
   */
  it('draws its four panels at the card radius', () => {
    // A tile, the panel the drawing sits in, a node card, a rail.
    const radii = [...CSS.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(radii.filter((value) => value === 'var(--radius-md)')).toHaveLength(4);
    expect(radii.filter((value) => !/^var\(--radius-(sm|md)\)$/.test(value) && value !== '50%')).toEqual([]);
  });

  it('rounds the two things that are dots, and only those', () => {
    // The travelling dot on an edge and the swatch beside a legend entry. Both
    // are 7px circles; a radius token on either would draw a rounded square.
    const radii = [...CSS.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(radii.filter((value) => value === '50%')).toHaveLength(2);
  });
});
