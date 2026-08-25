import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { partial, stylesheet } from './styles/stylesheet';
import {
  CARD_CONSTELLATION,
  OPENING_CONSTELLATION,
  SPLASH_CONSTELLATION,
  glyphPath,
  hopPath,
  type Constellation,
} from './constellation';
import { INLINE_WORKING_LABEL, WORKING_LABEL, elapsedSeconds, seatForTranscript } from './working-animation';
import type { FlickerSeat } from './astrolabe-mark';

/**
 * The working state, as the constellation loaders.
 *
 * WHAT THIS FILE USED TO HOLD, so the deletion is on the record. It tested the
 * controller-to-database-to-robot scene: three dots running a 203px track,
 * flipping blue to orange at 46-54% while hidden behind an opaque plate the
 * colour of the chip, a robot lighting up on the far side, and a set of rules
 * about where orange was and was not allowed to be. That scene is retired
 * (`loading-animation.md`, first line) and the robot with it -- the mark is the
 * agent now -- so none of those claims has anything left to be true about.
 *
 * What replaces them is the same kind of claim about the same kind of risk. The
 * constellations are drawings with coordinates, and the two failures that would
 * ship unnoticed are a line that ends nowhere and a star outside its panel:
 * neither is visible in a diff, both are visible to a customer.
 */

const HERE = new URL('.', import.meta.url);
const LOADERS = partial('astrolabe-loaders.css');
const RESPONSIVE = partial('responsive.css');
const HOME = readFileSync(new URL('HomePage.tsx', HERE), 'utf8');
const INLINE_ROW = readFileSync(new URL('WorkingInlineRow.tsx', HERE), 'utf8');

function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * One rule's body, by exact selector, with comments stripped first so a value
 * discussed in prose is not read as one that is declared.
 */
function body(selector: string, css: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(css).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

/** The contents of one `@media (max-width: Npx)` block of responsive.css. */
function atWidth(px: number) {
  const source = withoutComments(RESPONSIVE);
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

const NAMED: [string, Constellation][] = [
  ['splash', SPLASH_CONSTELLATION],
  ['working card', CARD_CONSTELLATION],
  ['opening sequence', OPENING_CONSTELLATION],
];

describe('which seating the loader takes', () => {
  it('fills the panel while the answer column has nothing in it', () => {
    expect(seatForTranscript([])).toBe('splash');
    expect(seatForTranscript([{ role: 'user' }])).toBe('splash');
  });

  it('shrinks to a strip once there is an answer above it to read', () => {
    expect(seatForTranscript([{ role: 'user' }, { role: 'assistant' }])).toBe('card');
  });

  it('reads the transcript rather than a count of runs', () => {
    // A cleared conversation is an empty answer column again, so the splash
    // comes back without anything having to remember that it should.
    expect(seatForTranscript([{ role: 'assistant' }, { role: 'user' }])).toBe('card');
    expect(seatForTranscript([])).toBe('splash');
  });

  it('seats every one of the flicker seatings somewhere in the app', () => {
    // `loading-suite.md` gives four (72px splash, 20px inline row, 14px in-button,
    // 18-24px on a dark strip) and the agent path's foot is a fifth; the suite is
    // not implemented until each one is on a real surface. Two of them sat in
    // FLICKER_SIZES unreferenced for a while, which is the failure this test is
    // for: a seating that exists only as a number in a record is a seating nobody
    // has drawn.
    const seated = [
      HOME,
      INLINE_ROW,
      readFileSync(new URL('WorkingConstellation.tsx', HERE), 'utf8'),
      readFileSync(new URL('AgentConstellation.tsx', HERE), 'utf8'),
    ].join('\n');
    for (const seat of ['splash', 'inline', 'button', 'strip', 'status'] satisfies FlickerSeat[]) {
      expect(seated, `the ${seat} seating is drawn somewhere`).toContain(`seat="${seat}"`);
    }
  });
});

describe('the inline row is the narrow seating, and says a real number', () => {
  it('is the spec’s own words rather than the panel’s', () => {
    // "Working on your question" is `loading-suite.md`'s label for this seating.
    // The panels say "Working on it", and the difference is what each sits next
    // to: the panel has already said what the agent is connecting, and this row
    // is alone in a column with no other copy in it.
    expect(INLINE_WORKING_LABEL).toBe('Working on your question');
    expect(INLINE_WORKING_LABEL).not.toBe(WORKING_LABEL);
  });

  it('sets the count in mono and pins it right without recentring the label', () => {
    // Mono because it changes in place every second. Pinned by the count's own
    // `margin-left: auto` rather than by `space-between` on the row: with no count
    // yet -- the first two seconds -- a `space-between` row would centre the label
    // and then shift it left when the number arrived.
    expect(INLINE_ROW).toMatch(/className="ast-num ast-flick-row-count"/);
    expect(body('.ast-flick-row-count', LOADERS)).toMatch(/margin-left:\s*auto/);
    expect(body('.ast-flick-row', LOADERS)).not.toMatch(/justify-content/);
  });

  it('does not add a second live region to a column that already has one', () => {
    // §5 allows ONE `aria-live="polite"` per surface, and the inspector spends it
    // on `RunStatusPill`, which is a `role="status"`. A second region six pixels
    // below it, saying the same run is in flight in different words, would
    // interrupt the first every time the count ticked.
    // Comments stripped: the file explains at some length WHY it is not a live
    // region, and a test that read the prose would fail on the explanation.
    const markup = withoutComments(INLINE_ROW);
    expect(markup).not.toMatch(/aria-live/);
    expect(markup).not.toMatch(/role="status"/);
  });

  it('replaces a spinner rather than adding a loader beside one', () => {
    // The inspector drew a lucide `Loader2` in a washed tile while a run was in
    // flight: a generic glyph standing in for the agent, which §1 retires -- the
    // mark is the agent. The empty state below it kept `Workflow`, which is not
    // the agent and is not claiming to be: it labels an empty list.
    // Comments stripped, because the note in place says what was removed and
    // names it: the strings below have to be absent from the MARKUP.
    const inspector = withoutComments(HOME.slice(HOME.indexOf('<aside className="trace-inspector">')));
    expect(inspector).not.toMatch(/Loader2/);
    expect(inspector).toMatch(/<WorkingInlineRow elapsed=\{elapsed\} \/>/);
    // And the empty-state heading does not follow the loader in: a run that is
    // going does not need a line telling the reader there are no steps yet.
    expect(inspector).not.toMatch(/No steps yet/);
  });
});

describe('the splash flicker is the splash’s drawing, not a second loader', () => {
  it('is on at every width, with no panel left to swap it for', () => {
    // `#5ar`'s 520x220 panel used to be the splash's drawing and the flicker its
    // narrow-window alternative. The panel is gone from this seating: it sits in
    // a transcript, and 220px of night sky between the question and the step
    // list pushed both off the fold. So the flicker is on by default and the
    // 480px query has nothing to say about either half.
    expect(body('.ast-flick-splash', LOADERS)).toMatch(/display:\s*grid/);
    expect(atWidth(480)).not.toMatch(/ast-flick-splash|ast-working/);
    expect(HOME).toMatch(/<ConceptFlicker seat="splash" \/>/);
    expect(HOME).not.toMatch(/<WorkingConstellation seat="splash"/);
  });

  it('leaves the copy and the bar where they were', () => {
    // What changed is the drawing. A second copy of the count or the label at
    // any width would be the same figure on screen twice.
    expect(atWidth(480)).not.toMatch(/ast-splash-copy|ast-splash-run/);
  });

  it('keeps the splash tight enough to read as part of the transcript', () => {
    // The 48/40/40 inset and the 24px gap were set around the panel, and with it
    // gone they are a third of a viewport of nothing above "Working on it". Top
    // has to clear the 72px mark off the card hairline (28) without growing
    // back into that band. The gap ceiling is what the block may not reopen.
    const splash = body('.ast-splash', LOADERS);
    const [top] = splash.match(/padding:\s*(\d+)px/)?.slice(1) ?? [];
    expect(Number(top)).toBeGreaterThanOrEqual(24);
    expect(Number(top)).toBeLessThanOrEqual(32);
    expect(Number(splash.match(/gap:\s*(\d+)px/)?.[1])).toBeLessThanOrEqual(16);
  });
});

describe('the wait is counted, and never mimed', () => {
  it('reports real seconds', () => {
    const start = 1_000_000;
    expect(elapsedSeconds(start, start + 5_000)).toBe('5s');
    expect(elapsedSeconds(start, start + 27_000)).toBe('27s');
  });

  it('keeps moving past the point the old bar froze at', () => {
    // The specific failure this replaced: a bar that filled in 2.6 seconds and
    // then sat full and static for another 23. Every one of these must differ.
    const start = 1_000_000;
    const counts = [3, 10, 20, 27].map((s) => elapsedSeconds(start, start + s * 1000));
    expect(new Set(counts).size).toBe(4);
  });

  it('says nothing before there is a count worth showing', () => {
    const start = 1_000_000;
    expect(elapsedSeconds(start, start + 500)).toBeNull();
    expect(elapsedSeconds(null, start)).toBeNull();
  });

  it('never reports a negative wait if the clock moves backwards', () => {
    expect(elapsedSeconds(1_000_000, 999_000)).toBeNull();
  });

  it('states no percentage anywhere, and keeps the bar indeterminate', () => {
    // loading-suite.md: "Elapsed time is real ... Never a percentage." The run
    // reports each step on finishing it, so the client knows what has happened
    // and never how much is left.
    expect(HOME).toMatch(/<Progress value=\{null\}/);
    expect(WORKING_LABEL).not.toMatch(/%/);
  });

  it('keeps the reassuring clause out, which the handoff asks back and does not get', () => {
    // "Still going; complex questions take this long" was in the app once and
    // was cut: the count already says the wait is long and that nothing has
    // hung. The animation handoff asks for it back past ~20s. Still declined.
    expect(WORKING_LABEL).not.toMatch(/still going|complex questions/i);
  });

  it('punctuates the count with the separator rather than an em dash', () => {
    // This was one string, "Working on it — 23s", and the em dash was live UI
    // copy on the surface a reader looks at longest. §3 and §7 make the
    // separator " · ", and `.ast-sep` generates it so it is written once.
    expect(WORKING_LABEL).not.toMatch(/[—–]/);
    expect(HOME).toMatch(/<span className="ast-sep" \/>/);
  });

  it('sets the count in mono, because it changes in place every second', () => {
    // DM Sans has no `tnum` feature and its digits are proportional -- a `1` is
    // 342 units against a `0` at 656 -- so a counter set in it jitters by most
    // of a digit width as it ticks. `.ast-num` is the mono family.
    expect(HOME).toMatch(/className="ast-num"/);
    expect(readFileSync(new URL('WorkingConstellation.tsx', HERE), 'utf8')).toMatch(/className="ast-num"/);
  });
});

describe('the constellations are drawings that hold together', () => {
  for (const [name, shape] of NAMED) {
    it(`draws every ${name} hop between two of its own stars`, () => {
      // A line that ends nowhere is the failure a diff cannot show and a
      // customer can. Every endpoint has to be a star, or the sky has a stroke
      // running off into it.
      const stars = new Set(shape.stars.map((star) => `${star.x},${star.y}`));
      const dangling = shape.hops
        .flatMap((hop) => [hop.from, hop.to])
        .map((point) => point.join(','))
        .filter((point) => !stars.has(point));
      expect(dangling).toEqual([]);
    });

    it(`connects every ${name} star to something`, () => {
      // The other direction. A star nothing reaches pops out of an empty sky on
      // a delay nobody chose, which reads as a rendering fault.
      const touched = new Set(shape.hops.flatMap((hop) => [hop.from.join(','), hop.to.join(',')]));
      const orphans = shape.stars.map((star) => `${star.x},${star.y}`).filter((point) => !touched.has(point));
      expect(orphans).toEqual([]);
    });

    it(`keeps every ${name} star and its glyph inside the panel`, () => {
      // Measured with the glyph's own size rather than from its centre: a
      // sparkle at x=8 with a size of 8 is half outside the panel, and the SVG
      // clips it without complaining.
      for (const star of [...shape.stars]) {
        expect(star.x - star.size, `${name} star at ${star.x},${star.y}`).toBeGreaterThanOrEqual(0);
        expect(star.y - star.size, `${name} star at ${star.x},${star.y}`).toBeGreaterThanOrEqual(0);
        expect(star.x + star.size).toBeLessThanOrEqual(shape.width);
        expect(star.y + star.size).toBeLessThanOrEqual(shape.height);
      }
      for (const dot of shape.backdrop) {
        expect(dot.x).toBeGreaterThan(0);
        expect(dot.x).toBeLessThan(shape.width);
        expect(dot.y).toBeGreaterThan(0);
        expect(dot.y).toBeLessThan(shape.height);
      }
    });

    it(`finishes every ${name} delay inside the loop`, () => {
      // A star that pops after the loop has restarted never appears at all.
      for (const hop of shape.hops) expect(hop.delay).toBeLessThan(shape.loopSeconds);
      for (const star of shape.stars) expect(star.delay).toBeLessThan(shape.loopSeconds);
    });

    it(`starts each ${name} star no earlier than the first line to touch it`, () => {
      // The story the animation tells is that a line arrives and the star lights
      // up. A star ahead of every connector that touches it tells it backwards.
      //
      // BOTH ENDPOINTS COUNT, not just the arriving one, and the opening
      // sequence's upper-left loop is why: it closes, so its origin star is the
      // `to` of the seventh hop as well as the `from` of the first. Measured on
      // arrivals alone, the star that starts the chain would have to wait for
      // the chain to come back round to it.
      const touched = new Map<string, number>();
      for (const hop of shape.hops) {
        for (const point of [hop.from, hop.to]) {
          const key = point.join(',');
          touched.set(key, Math.min(touched.get(key) ?? Infinity, hop.delay));
        }
      }
      for (const star of shape.stars) {
        const reached = touched.get(`${star.x},${star.y}`);
        if (reached === undefined) continue;
        expect(star.delay, `star at ${star.x},${star.y}`).toBeGreaterThanOrEqual(reached);
      }
    });
  }

  it('gives the opening sequence five separate patterns rather than one chain', () => {
    // §5 and loading-suite.md: "five separate constellation patterns drawing on
    // staggered delays". Counted as connected components over the hops, so a
    // hop added between two of them fails here rather than turning the sky into
    // a diagram nobody notices has become one.
    const parent = new Map<string, string>();
    const find = (node: string): string => {
      const up = parent.get(node);
      if (!up || up === node) return node;
      const root = find(up);
      parent.set(node, root);
      return root;
    };
    for (const hop of OPENING_CONSTELLATION.hops) {
      const [a, b] = [hop.from.join(','), hop.to.join(',')];
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      parent.set(find(a), find(b));
    }
    const groups = new Set([...parent.keys()].map(find));
    expect(groups.size).toBe(5);
  });

  it('draws a hop as a straight segment between its two points', () => {
    expect(hopPath({ from: [60, 120], to: [150, 60], delay: 0 })).toBe('M60 120 150 60');
  });

  it('generates a glyph from its centre, so one drawing serves both its sizes', () => {
    // The reference draws the same cross at 5 units in the 520px splash and at 4
    // in the 56px strip. Two hand-written paths would be two drawings that agree
    // until one of them is adjusted.
    const wide = glyphPath({ x: 150, y: 60, glyph: 'cross', delay: 0, size: 5 });
    const tight = glyphPath({ x: 150, y: 60, glyph: 'cross', delay: 0, size: 4 });
    expect(wide).toBe('M145 55l10 10M155 55l-10 10');
    expect(tight).toBe('M146 56l8 8M154 56l-8 8');
  });

  it('has no path for a product icon, which is a file rather than a shape', () => {
    // The recoloured copies in assets/logo/theme are the official geometry and
    // may not be redrawn, so the renderer places them as an <image>.
    expect(glyphPath({ x: 250, y: 130, glyph: 'genie', delay: 0, size: 7 })).toBeNull();
  });
});

describe('the loaders are decorative, and freeze when asked to', () => {
  it('hides every drawing from a screen reader and keeps one live string', () => {
    // §5: everything decorative is aria-hidden, with ONE aria-live="polite"
    // status. A second live region interrupts the first, and twelve connectors
    // narrating at once say less than nothing.
    // Comments stripped, because each of these files explains the rule in prose
    // and quotes the attribute to do it -- so the file that reasoned itself into
    // compliance would be the one reported as having two live regions.
    const field = withoutComments(readFileSync(new URL('ConstellationField.tsx', HERE), 'utf8'));
    const working = withoutComments(readFileSync(new URL('WorkingConstellation.tsx', HERE), 'utf8'));
    const flicker = withoutComments(readFileSync(new URL('ConceptFlicker.tsx', HERE), 'utf8'));
    expect(field).toMatch(/aria-hidden="true"/);
    expect(flicker).toMatch(/aria-hidden="true"/);
    expect(working.match(/aria-live=/g) ?? []).toHaveLength(1);
    expect(working).toMatch(/aria-live="polite"/);
  });

  it('names its animations through the prefix the freeze covers', () => {
    // The guard at the foot of astrolabe-animation.css matches
    // [class*='ast-anim-'], so a class named to that convention is covered the
    // day it is written rather than the day somebody remembers to extend the
    // guard. This is the assertion that the convention is actually followed.
    const named = [...withoutComments(LOADERS).matchAll(/animation-name:\s*(ast-[\w-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const animation of named) {
      expect(withoutComments(LOADERS), animation).toMatch(
        new RegExp(`\\.ast-anim-${animation.replace('ast-', '')}\\s*\\{[^}]*animation-name:\\s*${animation}`)
      );
    }
  });

  it('leaves the duration to the seating rather than to the keyframe', () => {
    // The splash's constellation is a 7s loop, the strip's is 5s and the opening
    // sequence's is 10s. Same keyframes, three rhythms, so a duration written
    // into a class here would be one of the three being right.
    expect(withoutComments(LOADERS)).not.toMatch(/\.ast-anim-[\w-]+\s*\{[^}]*animation-duration/);
    expect(SPLASH_CONSTELLATION.loopSeconds).toBe(7);
    expect(CARD_CONSTELLATION.loopSeconds).toBe(5);
    expect(OPENING_CONSTELLATION.loopSeconds).toBe(10);
  });

  it('marks one mark of a flicker slot as the frozen frame', () => {
    // CSS cannot choose between four stacked drawings, so the markup says which.
    // A slot that marks none renders nothing frozen, which fails visibly rather
    // than showing four marks in a pile.
    expect(readFileSync(new URL('ConceptFlicker.tsx', HERE), 'utf8')).toMatch(/rest=\{concept === FLICKER_REST\}/);
    expect(withoutComments(stylesheet())).toMatch(/\.ast-flick-slot > \[data-ast-rest\]/);
  });
});

describe('the retired scene is gone rather than unreferenced', () => {
  it('leaves no controller, database or robot loading markup behind', () => {
    const sheet = withoutComments(stylesheet());
    for (const selector of ['.pia-working', '.pia-track', '.pia-dot', '.pia-plate', '.pia-db']) {
      expect(sheet, selector).not.toContain(selector);
    }
  });

  it('leaves no keyframe of it either, and no orange for it to be drawn in', () => {
    const sheet = withoutComments(stylesheet());
    expect(sheet).not.toContain('pia-dot-run');
    expect(sheet).not.toContain('pia-icon-wake');
    expect(sheet).not.toContain('pia-db-ring');
  });
});
