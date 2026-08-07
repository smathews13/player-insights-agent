import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
 * Asserted against the stylesheet because the effect is a painted pixel and this
 * repo has no browser. That is a real limit: this proves the rules exist and
 * name a foreground as well as a background, which is the specific thing whose
 * absence caused the bug. It cannot prove the result is legible, and nothing
 * here should be read as saying it has been seen.
 */

const STYLESHEET = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8');

/** The body of the first rule whose selector list contains `selector`. */
function ruleFor(selector: string): string {
  const at = STYLESHEET.indexOf(selector);
  if (at === -1) return '';
  const open = STYLESHEET.indexOf('{', at);
  const close = STYLESHEET.indexOf('}', open);
  return open === -1 || close === -1 ? '' : STYLESHEET.slice(open + 1, close);
}

describe('selection is styled per surface, because the surfaces are inverses', () => {
  /**
   * The dark bubble and the light card cannot share one rule. Whatever is
   * legible on one is close to invisible on the other, which is how a single
   * global rule would leave the app half-fixed and looking handled.
   */
  it('styles the dark user bubble and the light answer card separately', () => {
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
    // Light on the dark bubble, ink on the light card. Same pair, each way up.
    expect(ruleFor('.user-bubble::selection')).toContain('var(--primary-foreground)');
    expect(ruleFor('.user-bubble::selection')).toContain('var(--pia-ink)');
    expect(ruleFor('.answer-card::selection')).toContain('var(--pia-ink)');
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
