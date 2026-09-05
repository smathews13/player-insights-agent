import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PIA_SIMPLIFIED_CUTOFF } from './pia-mark';
import { partial, stylesheet } from './styles/stylesheet';

/**
 * The agent's mark: one robot, drawn in five places.
 *
 * The transcript's avatar, the chip that introduces the agent on an empty page,
 * and the figure at the end of the working strip are all the same drawing, and
 * this file is what keeps them one drawing. Overview's stored-answer card no
 * longer seats the mark: the live-response badge is the first thing in that
 * card.
 *
 * The claim worth the most here is the boring one: THE MARKUP EXISTS ONCE. A
 * pasted second copy is correct on the day it is pasted, drifts on the first
 * retune of either, and shows nothing at all on screen until somebody who has
 * seen both notices that the loading robot and the answer robot are not quite
 * the same animal -- which nobody will, because the two are never visible
 * together. So the check is not "does the avatar look right", which no test can
 * answer, but "is there anywhere else this geometry could be edited".
 *
 * The rest divides into three:
 *
 *   - The seats. Every place an agent identity mark is drawn draws THIS one, and
 *     none of them has quietly kept a lucide glyph -- which is where this began:
 *     a sparkle beside the answers and a robot in the animation, so the app
 *     introduced itself with one figure and reported with another.
 *   - The window. Derived from the shapes rather than trusted as a string, so a
 *     mark that is off-centre, clipped or scaled unevenly at avatar size fails
 *     here instead of being seen by a customer. This is the part nothing else
 *     can catch: at 32px, four units of misplacement is two pixels.
 *   - The stillness. Only the strip is allowed to move. The mark's classes carry
 *     an antenna pulse and a blink, and both are scoped so that a mark signing a
 *     finished answer does not blink at a reader who has finished reading it --
 *     before `prefers-reduced-motion` is consulted at all, which is the only
 *     honest way to hold that line: a reduced-motion rule stops the reader who
 *     asked, and this stops it for the reader who never thought to.
 */

const HERE = new URL('.', import.meta.url);

const MARK = readFileSync(new URL('PiaRobotMark.tsx', HERE), 'utf8');
const ANIMATION = partial('animation.css');
const STYLESHEET = stylesheet();

/** Comments stripped, so a size or a colour discussed in prose is not read as one on screen. */
function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** One rule's body, by exact selector, over the whole stylesheet. */
function body(selector: string, css: string = STYLESHEET) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(css).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

/**
 * Every shipped TypeScript source under client/src, by path relative to it.
 *
 * Read off the directory rather than from a list of files, because a list is
 * exactly what a second copy of the mark would be added without.
 *
 * Tests are excluded, and this file is why: the check below looks for the mark's
 * markup, so it has to contain the markup to look for, and a suite that quoted
 * the drawing in order to find it would find itself and call it a duplicate. A
 * string in an assertion is not something the app can draw.
 */
function sources(): Map<string, string> {
  const root = fileURLToPath(HERE);
  const found = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    found.set(relative(root, path), readFileSync(path, 'utf8'));
  }
  return found;
}

const SOURCES = sources();

/**
 * The seats that still draw the ROBOT, and the file each is in.
 *
 * THE LIST IS EMPTY, WHICH IS THE END OF IT. §1 retires the orange robot -- "The
 * mark is the agent", and an agent-decision chip carries the small cut of the
 * astrolabe mark on Ice -- and as of this edit nothing in the app draws it.
 * HomePage.tsx's hero chip and clarification avatar went first, then the working
 * loader, which drew the robot at the end of a dot track and is now a
 * constellation; then the answer card and the plan card; and last the Run
 * Explorer's stored answer and the two seats inside the trace map, which drew it
 * in a node rather than in a named seat class.
 *
 * WHAT IS LEFT IS NOT IN THIS FILE. `PiaRobotMark.tsx` is still on disk and still
 * correct, and `animation.css` still carries two orange fills that paint it --
 * `.pia-robot-head` and `.pia-antenna` -- along with a header comment naming
 * files that no longer seat it. That file is held by the lane recolouring the
 * working dots, so the fills and the note go with that change rather than with
 * this one. When they do, this whole file goes too: the seats it guards are gone
 * and the geometry it checks is a drawing nothing renders.
 *
 * Kept empty rather than deleted in the meantime because the emptiness is a
 * claim. A new file drawing the robot fails the check below, which is worth
 * having for exactly as long as the component exists to be reached for.
 */
const SEATS: ReadonlyArray<[string, string]> = [];

/**
 * Every file that still renders the robot at all.
 *
 * A superset of `SEATS` while it had entries, because TraceDag.tsx drew the robot
 * inside a node rather than in one of the named seat classes. Both are empty now
 * and the distinction is history; the list stays so that a file reaching for the
 * retired mark has something to fail against.
 */
const ROBOT_FILES: string[] = [];

type Rect = { x: number; y: number; width: number; height: number };

/** The mark's shapes, as numbers, so a claim about the drawing is about the drawing. */
function shapes(): Rect[] {
  return [...MARK.matchAll(/<rect[^>]*\/>/g)].map((tag) => {
    const read = (name: string) => {
      const found = tag[0].match(new RegExp(`\\b${name}="(-?[\\d.]+)"`));
      if (!found) throw new Error(`<rect> in PiaRobotMark.tsx has no ${name}: ${tag[0]}`);
      return Number(found[1]);
    };
    return { x: read('x'), y: read('y'), width: read('width'), height: read('height') };
  });
}

/** The box the drawing actually occupies, which is not the box it is drawn in. */
function artwork() {
  const parts = shapes();
  return {
    left: Math.min(...parts.map((part) => part.x)),
    right: Math.max(...parts.map((part) => part.x + part.width)),
    top: Math.min(...parts.map((part) => part.y)),
    bottom: Math.max(...parts.map((part) => part.y + part.height)),
  };
}

/** One of the two windows the component names, as four numbers. */
function viewBox(name: 'GRID_VIEW_BOX' | 'MARK_VIEW_BOX') {
  const found = MARK.match(new RegExp(`${name} = '([-\\d. ]+)'`));
  expect(found, `${name} is declared in PiaRobotMark.tsx`).not.toBeNull();
  const [x, y, width, height] = found![1].split(' ').map(Number);
  return { x, y, width, height };
}

describe('the mark exists once', () => {
  it('draws the robot in exactly one source file', () => {
    // The head, which no other drawing in the app has a reason to contain. If this
    // ever names two files, one of them is a copy that will diverge: the geometry is
    // the design's to the half pixel and nothing on screen compares the two.
    const head = '<rect className="pia-robot-head" x="16" y="16" width="40" height="36" rx="8" />';
    const holders = [...SOURCES].filter(([, source]) => source.includes(head)).map(([path]) => path);
    expect(holders).toEqual(['PiaRobotMark.tsx']);
  });

  it('leaves no component drawing the robot’s parts by hand', () => {
    // A partial copy is worse than a whole one, because it looks like a variant
    // rather than like duplication: an avatar with the head and no antenna reads as
    // a deliberate simplification of the mark and is a paste that lost two lines.
    const painted = [...SOURCES]
      .filter(([path]) => path !== 'PiaRobotMark.tsx')
      .filter(([, source]) => /className="pia-(robot-head|antenna|cutout|eyes)"/.test(source))
      .map(([path]) => path);
    expect(painted).toEqual([]);
  });

  it('writes no colour of its own, so one rule paints every seating', () => {
    // The fills are classes, painted from tokens in animation.css. A `fill="#FF3621"`
    // here would be a second orange that no palette check reaches, because it would
    // not be in the stylesheet at all.
    expect(MARK).not.toMatch(/fill=|#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('every seat draws the shared mark', () => {
  for (const [seat, file] of SEATS) {
    it(`signs .${seat} in ${file} with the shared robot`, () => {
      const source = SOURCES.get(file);
      expect(source, `${file} is under client/src`).toBeDefined();
      // Each occurrence of the class, and what is rendered inside it. The mark used
      // to differ per seat -- a sparkle on an answer, a workflow glyph on a plan, a
      // question mark on a clarification -- which made it decoration rather than an
      // identity. What kind of turn it is, the badge beside it says.
      const seated = [...source!.matchAll(new RegExp(`className="${seat}"[^>]*>\\s*<([\\w-]+)`, 'g'))].map(
        (match) => match[1]
      );
      expect(seated.length).toBeGreaterThan(0);
      expect([...new Set(seated)]).toEqual(['PiaRobotMark']);
    });
  }

  it('imports it in every file that seats it', () => {
    const importers = [...SOURCES]
      .filter(([, source]) => source.includes('<PiaRobotMark'))
      .filter(([, source]) => !/import \{ PiaRobotMark \} from '\.\/PiaRobotMark'/.test(source))
      .map(([path]) => path);
    expect(importers).toEqual([]);
  });

  it('is drawn in exactly the files that have not converted yet', () => {
    // The list is the thing worth pinning, in both directions. A new file
    // drawing the robot is a new use of a retired mark; a file dropping out
    // without this list being updated means the conversion happened and nobody
    // recorded it, which is how animation.css and the last of the orange end up
    // outliving their last reader.
    const drawing = [...SOURCES]
      .filter(([, source]) => source.includes('<PiaRobotMark'))
      .map(([path]) => path)
      .filter((path) => path !== 'PiaRobotMark.tsx')
      .sort();
    expect(drawing).toEqual(ROBOT_FILES);
  });

  it('leaves no lucide glyph standing in for the agent', () => {
    // Bot and Sparkles remain in the app, and deliberately: they label the KIND of a
    // step in a trace, in a monochrome set beside a wrench and a magnifier, and they
    // sit inside the ask button, which is an affordance rather than a report. Neither
    // is an identity mark, and neither may be drawn in the working colour -- orange on
    // a finished step would say that step is running now.
    for (const [, file] of SEATS) {
      const source = SOURCES.get(file)!;
      for (const [seat] of SEATS) {
        expect(source).not.toMatch(new RegExp(`className="${seat}"[^>]*>\\s*<(Sparkles|Bot|Workflow|HelpCircle)`));
      }
    }
  });
});

describe('the window the mark is drawn through', () => {
  it('centres the drawing in its own square, which the design’s grid does not', () => {
    // The robot occupies y 8-52 of a 72-unit grid: centred across it and high in it,
    // because the grid leaves room below for a controller's body. Rendered through the
    // full grid at 32px the mark lands two pixels above the middle of its box and
    // draws smaller than the space it was given, which is what the glyph it replaces
    // looked like. Derived from the shapes, so moving one fails here.
    const drawing = artwork();
    const window = viewBox('MARK_VIEW_BOX');
    expect(Math.abs((drawing.left + drawing.right) / 2 - (window.x + window.width / 2))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((drawing.top + drawing.bottom) / 2 - (window.y + window.height / 2))).toBeLessThanOrEqual(0.5);
  });

  it('keeps the drawing clear of every edge, so nothing is clipped at any size', () => {
    // An SVG clips at its viewBox. Two units of the 64 is one pixel at 32px, and an
    // ear shaved by one pixel does not read as a tight crop -- it reads as a
    // rendering fault in the mark.
    const drawing = artwork();
    const window = viewBox('MARK_VIEW_BOX');
    expect(drawing.left - window.x).toBeGreaterThanOrEqual(2);
    expect(window.x + window.width - drawing.right).toBeGreaterThanOrEqual(2);
    expect(drawing.top - window.y).toBeGreaterThanOrEqual(2);
    expect(window.y + window.height - drawing.bottom).toBeGreaterThanOrEqual(2);
  });

  it('takes a square window into a square box, so the robot cannot arrive squashed', () => {
    // A square viewBox and a square element mean one scale on both axes. A 64 by 48
    // window in a 32 by 32 box would stretch the head by a third and nothing would
    // fail: preserveAspectRatio's default letterboxes instead, which loses the size.
    const window = viewBox('MARK_VIEW_BOX');
    expect(window.width).toBe(window.height);
    for (const seat of ['.agent-avatar svg']) {
      const rule = body(seat);
      const width = rule.match(/width:\s*(\d+)px/)?.[1];
      const height = rule.match(/height:\s*(\d+)px/)?.[1];
      expect(width, `${seat} states a width`).toBeDefined();
      expect(height, `${seat} states a height`).toEqual(width);
    }
  });

  it('fits the design’s grid too, for the seating that shares it with two other figures', () => {
    const drawing = artwork();
    const grid = viewBox('GRID_VIEW_BOX');
    expect(grid).toEqual({ x: 0, y: 0, width: 72, height: 72 });
    expect(drawing.left).toBeGreaterThanOrEqual(grid.x);
    expect(drawing.right).toBeLessThanOrEqual(grid.x + grid.width);
    expect(drawing.top).toBeGreaterThanOrEqual(grid.y);
    expect(drawing.bottom).toBeLessThanOrEqual(grid.y + grid.height);
  });

  it('sits on the surface rather than in a plate the orange would hide', () => {
    // The tile was orange because the sparkle inside it had no colour of its own. The
    // robot's body IS the orange, so an orange plate hides the mark and any other
    // plate needs the mark inverted to sit on it -- a second version of the drawing,
    // which is the defect this whole change exists to remove.
    for (const seat of ['.agent-avatar']) {
      expect(body(seat), seat).not.toMatch(/background|color:/);
    }
  });
});

describe('the mark that replaced it', () => {
  it('signs the two seats on the Ask page with the astrolabe mark', () => {
    // §1: "The mark is also the agent: agent-decision chips carry the small cut.
    // The orange robot is retired." The hero chip that introduces the agent on
    // an empty transcript, and the avatar on a clarification card, are the two
    // seats on this page and both draw the app's own mark now.
    const home = SOURCES.get('HomePage.tsx')!;
    expect(home).not.toContain('PiaRobotMark');
    expect(home).toMatch(/className="ask-hero-chip-mark">\s*<PiaAvatar size=\{24\} \/>/);
    expect(home).toMatch(/className="agent-avatar">\s*<PiaAvatar size=\{32\} \/>/);
  });

  it('signs the answer card and the plan card with it too', () => {
    // The transcript's two cards, and the last two seats outside the Ask page.
    // Every turn the agent takes is now signed with the same drawing: the mark
    // used to differ per kind of turn -- a sparkle on an answer, a workflow
    // glyph on a plan -- which made it decoration rather than an identity.
    const answer = SOURCES.get('AnswerCard.tsx')!;
    expect(answer).not.toContain('PiaRobotMark');
    expect(answer).toMatch(/className="answer-card-mark"[^>]*>\s*<PiaAvatar size=\{28\} tone="light" \/>/);
    const plan = SOURCES.get('PlanCard.tsx')!;
    expect(plan).not.toContain('PiaRobotMark');
    expect(plan).toMatch(/className="agent-avatar">\s*<PiaAvatar size=\{\d+\} \/>/);
  });

  it('asks each avatar for the size that seat actually paints', () => {
    // THE SIZE PROP CHOOSES THE DRAWING, NOT ONLY THE BOX. markElements() drops
    // the graduation ring below GRADUATION_FLOOR and thickens the rim, so a seat
    // that asks for 18 and is then painted at 32 by `.agent-avatar svg` gets the
    // small cut enlarged: a blunter mark, at the one size the graduations were
    // drawn to be read at. Nothing would look broken and no other check here
    // would fire, because the box would be exactly the right size.
    //
    // Read off the stylesheet rather than written as 32, so the seat and the
    // three callers cannot drift apart in the direction where they still agree
    // on the number but no longer agree with the rule that paints them.
    const painted = Number(body('.agent-avatar svg').match(/width:\s*(\d+)px/)?.[1]);
    expect(painted, 'the avatar states the width it paints').toBeGreaterThanOrEqual(PIA_SIMPLIFIED_CUTOFF);
    for (const file of ['PlanCard.tsx', 'HomePage.tsx']) {
      const asked = [...SOURCES.get(file)!.matchAll(/className="agent-avatar">\s*<PiaAvatar size=\{(\d+)\}/g)].map(
        (match) => Number(match[1])
      );
      expect(asked.length, `${file} seats the mark in an avatar`).toBeGreaterThan(0);
      for (const size of asked) expect(size, `${file} asks the avatar for its painted size`).toBe(painted);
    }
    expect(SOURCES.get('AnswerCard.tsx')).toContain('<PiaAvatar size={28} tone="light" />');
  });

  it('sits the agent chip on Ice, which is what replaced oat', () => {
    const chip = body('.ask-hero-chip');
    expect(chip).toMatch(/background:\s*var\(--ast-ice\)/);
    expect(chip).not.toMatch(/--db-warm/);
  });

  it('turns the composer action into Stop without presenting the run as a passive loader', () => {
    // The submit button used to carry a sparkle, then a flickering "Running"
    // state. It is now the cancellation control while this conversation is busy:
    // explicit Stop copy, still pressable, and no animated mark competing with
    // the action. Button flicker remains a supported seat for non-cancellable
    // work such as applying resource tags.
    const home = SOURCES.get('HomePage.tsx')!;
    expect(home).not.toContain('<Sparkles />');
    expect(home).not.toMatch(/<ConceptFlicker seat="button" \/>/);
    expect(home).toMatch(/<Button type="submit" disabled=\{loading \? stopping : !canAsk\}>/);
    expect(home).toMatch(/\{loading \? \([\s\S]{0,220}'Stop'/);

    const resourceTags = SOURCES.get('ResourceTagsPanel.tsx')!;
    expect(resourceTags).toMatch(/\{running \? <PiaFlicker seat="button" \/> : null\}/);
  });
});

describe('nothing moves any more', () => {
  it('leaves no animation on the mark’s classes at all', () => {
    // The antenna pulse and the eye blink belonged to a run in flight and were
    // scoped under `.pia-anim`, which only the retired strip carried -- so both
    // became unreachable the moment it went. A mark that signs a finished answer
    // was never entitled to move, and now cannot.
    const rules = [...withoutComments(ANIMATION).matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/g)];
    const moving = rules
      .filter(([, , declarations]) => /\banimation(-delay|-duration|-name)?\s*:/.test(declarations))
      .map(([, selector]) => selector.trim());
    expect(moving).toEqual([]);
  });

  it('leaves the mark’s own fills unscoped, so every surviving seating is painted', () => {
    // An unpainted robot is a black silhouette on white rather than the agent's
    // mark, so the fills stay while any component still seats it. Read as exact
    // selectors, so a descendant rule cannot answer for the base one.
    expect(body('.pia-robot-head', ANIMATION)).toMatch(/fill:\s*var\(--db-orange\)/);
    expect(body('.pia-antenna', ANIMATION)).toMatch(/fill:\s*var\(--db-orange\)/);
    // Ice rather than the oat it was. §2 retires oat app-wide, and the cutouts
    // read as holes in the head only while they match the surface behind it.
    expect(body('.pia-cutout', ANIMATION)).toMatch(/fill:\s*var\(--ast-ice\)/);
  });

  it('gives no seat of the still mark a transition or an animation of its own', () => {
    for (const seat of ['.agent-avatar', '.agent-avatar svg']) {
      expect(body(seat), seat).not.toMatch(/animation|transition/);
    }
  });

  it('has nothing left in this partial for a reduced-motion guard to stop', () => {
    // The guard here placed every dot of the retired scene by hand, because
    // switching the animation off stacked all of them at the left edge of the
    // track. The scene is gone and this partial is four fills; the guard that
    // matters now is the `[class*='ast-anim-']` one at the foot of
    // astrolabe-animation.css, which covers the loaders that replaced it.
    expect(withoutComments(ANIMATION)).not.toMatch(/@media \(prefers-reduced-motion/);
    expect(withoutComments(STYLESHEET)).toMatch(/\[class\*='ast-anim-'\]\s*\{\s*animation:\s*none\s*!important/);
  });
});
