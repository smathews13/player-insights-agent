import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The one thing this screen must never say.
 *
 * Verifying the user's own access is now the default and the primary action,
 * which makes it very easy for the next revision of this copy to slide into
 * "so the app runs as you". It does not. The orchestrator lives inside a Model
 * Serving endpoint that authenticates as the serving principal, and no button
 * on this screen changes that, reaching genuine on-behalf-of execution needs
 * a user auth policy, an app that forwards the caller's token on the
 * invocation, and a new model version.
 *
 * Asserted against the source rather than against a render because this repo
 * has no jsdom and no React testing library, and adding either the night
 * before a customer demo is a worse trade than a coarser check that runs. The
 * Playwright spec asserts the same constraint against the real DOM; this is
 * the half that still runs when a browser is not available.
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

describe('what the access gate promises about execution', () => {
  it('states that execution stays with the service principal whichever option is taken', () => {
    expect(PROSE).toContain('still runs as a service principal whichever option you take below');
  });

  it('claims only that the user could have read the data, never that they did', () => {
    expect(PROSE).toContain('have read the data behind an answer');
    expect(PROSE).toContain('not that you did');
  });

  /**
   * Affirmative claims only. The negated forms are honest and are used
   * deliberately elsewhere on this screen: "Nothing was run as you" and "the
   * app could not ask on your behalf" are both true and both worth saying, so
   * a pattern broad enough to catch them would forbid the copy that is right.
   */
  it('never claims the app executes as the signed-in user', () => {
    for (const claim of [
      /\bruns as you\b/i,
      /\bexecutes as you\b/i,
      /\bexecuting as you\b/i,
      /\brunning as you\b/i,
      /\bas your own identity\b/i,
      /\byour own permissions are enforced\b/i,
      /\bqueries run under your\b/i,
    ]) {
      expect(PROSE).not.toMatch(claim);
    }
  });

  it('keeps the fallback honest about establishing nothing', () => {
    expect(PROSE).toContain('claims nothing about your own access');
  });
});
