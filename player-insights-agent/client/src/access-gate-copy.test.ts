import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What this screen must and must not say about verification vs execution.
 *
 * The gate checks the reader's own access under their token. Who runs later
 * asks is analyticalExecution on Connections, not a switch on these buttons.
 * Asserted against the source rather than against a render because this repo
 * has no jsdom and no React testing library. The Playwright spec asserts the
 * same constraints against the real DOM; this is the half that still runs
 * when a browser is not available.
 */
const SOURCE = readFileSync(new URL('./AccessGate.tsx', import.meta.url), 'utf8');

/**
 * What a person actually reads: comments dropped, and every run of whitespace
 * flattened, because JSX wraps a sentence across lines wherever the formatter
 * happened to break it and the reader never sees that.
 */
const PROSE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s+/g, ' ');

describe('what the access gate promises about verification', () => {
  it('states that the screen checks the reader under their own token', () => {
    expect(PROSE).toContain('checks your access under your own token');
  });

  it('says the gate does not decide who runs later asks', () => {
    expect(PROSE).toContain('does not decide who runs the questions that follow');
    expect(PROSE).toContain('reported on Connections');
  });

  it('claims only that the user could have read the data, never that they did', () => {
    expect(PROSE).toContain('have read the data behind an answer');
    expect(PROSE).toContain('not that you did');
  });

  /**
   * It is behind the limits disclosure now rather than in the opening paragraph.
   * It is a qualifier on a result, so it belongs beside the result; and a reader
   * deciding which of three doors to take does not need the epistemology of the
   * check first. Kept as an assertion because the sentence is what stops somebody
   * over-claiming a pass afterwards, and it must not be lost in the shortening.
   */
  it('keeps that qualifier with the result it qualifies, not in the way of the door', () => {
    const limits = PROSE.slice(PROSE.indexOf('export function LimitsReport'));
    expect(limits).toContain('have read the data behind an answer');
    const intro = PROSE.slice(PROSE.indexOf('export function GateIntro'), PROSE.indexOf('interface Failure'));
    expect(intro).not.toContain('have read the data behind an answer');
  });

  /**
   * Affirmative claims only. The gate must not invent an execution identity.
   * Connections / analyticalExecution is where that lives.
   */
  it('never claims asks still run as a service principal whichever option is taken', () => {
    expect(PROSE).not.toMatch(/still runs as a service principal/i);
    expect(PROSE).not.toMatch(/Execution still happens as the service principal/i);
    expect(PROSE).not.toMatch(/Questions execute as/i);
  });

  /**
   * Both doors verify the same amount, which is none. The wording is much shorter
   * than it was, so what is asserted is the part that cannot go: neither of them
   * may read as having established something, and the skip has to stay
   * distinguishable from the fallback by how it is RECORDED.
   */
  it('keeps the fallback honest about establishing nothing about the reader', () => {
    expect(PROSE).toContain('claims nothing about your own access');
    expect(PROSE).toContain('Establishes nothing about your own access');
    expect(PROSE).toContain('recorded as a skip rather than as the fallback');
  });
});

describe('the screen says its premise once', () => {
  /** The paragraph directly under the heading, before anything else is on screen. */
  const INTRO = PROSE.slice(PROSE.indexOf('export function GateIntro'), PROSE.indexOf('interface Failure'));

  it('opens with one paragraph rather than two that say the same thing first', () => {
    // These were two, and each of them opened by saying the screen checks your own
    // access under your own token. A reader who has just been told the premise and
    // is then told it again learns to skim the second one, and the second one is
    // where the two limits of the check were.
    expect(INTRO.match(/<p(?:\s|>)/g)).toHaveLength(1);
  });

  it('carries what the reader needs before choosing a door', () => {
    // Two facts change what somebody does next: what is checked, and that this
    // decides nothing about who runs the questions afterwards. Everything else the
    // paragraph used to carry is either said elsewhere once or behind a disclosure.
    for (const scope of ['SQL warehouse', 'tables behind answers', 'Genie spaces']) {
      expect(INTRO, `the enumeration dropped ${scope}`).toContain(scope);
    }
    expect(INTRO).toContain('does not decide who runs the questions that follow');
    expect(INTRO).toContain('reported on Connections');
  });

  /**
   * Said once, on the whole screen.
   *
   * "Who runs the questions is a property of the deployment, reported on
   * Connections" was in the opening paragraph twice over, again under the
   * fallback button, and again as the third sentence of the Genie heading. Four
   * places is how a screen becomes a wall while every individual sentence still
   * looks defensible.
   */
  it('says who decides execution in one place rather than in four', () => {
    expect(PROSE.match(/reported on Connections/g)).toHaveLength(1);
  });
});
