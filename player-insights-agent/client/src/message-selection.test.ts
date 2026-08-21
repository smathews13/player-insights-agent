import { describe, expect, it } from 'vitest';

import { stylesheet } from './styles/stylesheet';

/**
 * Selecting text in a message has to be visible.
 *
 * A customer reported that dragging across their own question in the transcript
 * copied and pasted correctly but showed nothing at all: no colour change, no
 * I-beam. The cause was an absence rather than a rule -- neither this stylesheet
 * nor AppKit's declared `::selection` anywhere, so both surfaces fell through to
 * the browser default, which paints a pale wash and leaves the foreground
 * colour alone. White text on a near-black bubble stays white, on pale blue.
 *
 * The bubble is a light fill now, so its pair runs the same way round as the
 * answer card's. What is asserted is still that each surface names both halves
 * and inverts its own background -- not that the two differ from each other.
 *
 * Asserted against the stylesheet because the effect is a painted pixel and this
 * repo has no browser. That is a real limit: this proves the rules exist and
 * name a foreground as well as a background, which is the specific thing whose
 * absence caused the bug. It cannot prove the result is legible, and nothing
 * here should be read as saying it has been seen.
 */

const STYLESHEET = stylesheet();

/** The body of the first rule whose selector list contains `selector`. */
function ruleFor(selector: string): string {
  const at = STYLESHEET.indexOf(selector);
  if (at === -1) return '';
  const open = STYLESHEET.indexOf('{', at);
  const close = STYLESHEET.indexOf('}', open);
  return open === -1 || close === -1 ? '' : STYLESHEET.slice(open + 1, close);
}

describe('selection is styled per surface, because each inverts its own fill', () => {
  /**
   * Each surface keeps its own rule. They happen to carry the same pair while
   * both fills are light, but the bubble's fill is the one the design keeps
   * moving, and a single shared rule would follow one surface and silently
   * stop matching the other the next time it does.
   */
  it('styles the user bubble and the answer card separately', () => {
    expect(STYLESHEET).toContain('.user-bubble::selection');
    expect(STYLESHEET).toContain('.answer-card::selection');
  });

  it('reaches nested elements as well as the surface itself', () => {
    // `::selection` matches the element the selected text belongs to, so a
    // bubble whose content is wrapped in a span falls through without this.
    expect(STYLESHEET).toContain('.user-bubble ::selection');
    expect(STYLESHEET).toContain('.answer-card ::selection');
  });

  /**
   * The default already supplies a background. Setting one without a foreground
   * reproduces the bug in a different colour, so both halves are required.
   */
  it('sets a foreground as well as a background on each surface', () => {
    for (const selector of ['.user-bubble::selection', '.answer-card::selection']) {
      const rule = ruleFor(selector);
      expect(rule, selector).toMatch(/background:/);
      expect(rule, selector).toMatch(/color:/);
    }
  });

  it('inverts each surface rather than tinting it', () => {
    // Ink on both, because both fills are light now. The bubble was white-on-ink
    // while its fill was the darkest neutral in the app; the fill went to a light
    // near-opaque gray and the pair had to turn over with it, or the selection
    // would have been near-white on near-white -- the original bug, restaged.
    expect(ruleFor('.user-bubble::selection')).toContain('var(--db-ink)');
    expect(ruleFor('.user-bubble::selection')).toContain('#ffffff');
    expect(ruleFor('.answer-card::selection')).toContain('var(--db-ink)');
    expect(ruleFor('.answer-card::selection')).toContain('#ffffff');
  });
});

describe('the cursor says which text can be selected', () => {
  it('puts an I-beam over the question the user typed', () => {
    expect(ruleFor('.user-bubble {')).toContain('cursor: text');
  });

  it('puts one over the agent’s prose too', () => {
    expect(ruleFor('.answer-takeaway')).toContain('cursor: text');
  });

  /**
   * Scoped to the text elements on purpose. `cursor: text` on `.answer-card`
   * would cover the feedback stars, the SQL disclosure and every link in the
   * card, all of which should still say they are clickable.
   */
  it('does not put one over the whole answer card', () => {
    expect(ruleFor('.answer-card {')).not.toContain('cursor: text');
  });
});
