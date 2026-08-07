import { describe, expect, it } from 'vitest';
import { executionStatus, isOpaqueId, principalLabel, withoutRepeatedPrincipal } from './execution-identity';

/**
 * The banner that stands above every page for the whole session.
 *
 * It began as a sentence explaining a choice the reader had made: "questions
 * run as the agent's service principal, not as you", with the decision restated
 * underneath. Accurate, and the wrong register: a standing banner is read as a
 * status line, and a status line that argues with you is one people stop
 * seeing. It now reports a state, in the shape a reader already knows how to
 * skim, and it is one line.
 *
 * Two rules are why this file exists:
 *
 *   IT NEVER PRINTS A FULL IDENTIFIER. The uuid appears at most once on a
 *   screen, and this is not that place: the banner abbreviates, the
 *   Connections page records.
 *
 *   IT DOES NOT SPEAK FOR THE EXECUTION LAYER. Which identity actually runs a
 *   question is decided per release, server-side, and reported on the
 *   Connections page from what the server said.
 *
 * The second rule is the interesting one, because it is the reversal of what
 * stood here this morning and the reversal took less than a day.
 *
 * The original sin was copy that foreclosed a future: "not as you, by design"
 * asserted the service principal was the only way the app could execute. That
 * was replaced with "in X mode", which states a route and leaves room for
 * others, and, for the verified case, with a second field spelling out that
 * the service principal was still the one executing, on the reasoning that
 * "your access was verified" standing alone reads as though the reader's own
 * identity is running the queries.
 *
 * Then on-behalf-of execution shipped, and that field became false on every
 * deployment carrying it. The safeguard had turned into the error it was built
 * to prevent, by the same mechanism as the sentence it replaced: a client-side
 * constant describing a server-side arrangement is wrong on exactly the release
 * that changes the arrangement.
 *
 * So the banner says what the gate established and stops. It is the narrower
 * claim, and narrow is the only kind this file has managed to keep true.
 */

const MODES = ['user-verified', 'skipped', 'service-principal'] as const;

/**
 * A fabricated uuid, not this deployment's. The assertions below are about the
 * SHAPE of what may be printed, so naming the real serving principal here bought
 * nothing and put the app's service principal id in a tracked file that the
 * customer can read.
 */
const SERVING = '00000000-0000-4000-8000-000000000000';

/** Every string the banner can render, for the rules that hold across all of them. */
function everyLine() {
  return MODES.map((mode) => executionStatus(mode).label);
}

describe('the status line above every page', () => {
  it('is one line per mode, and says what happened at the gate', () => {
    expect(executionStatus('service-principal').label).toBe('Operating in service principal mode');
    expect(executionStatus('user-verified').label).toBe('Your access was verified and confirmed');
    expect(executionStatus('skipped').label).toBe('Access check skipped');
  });

  it('never prints a principal id, in full or truncated', () => {
    for (const text of everyLine()) {
      expect(text).not.toContain(SERVING);
      expect(text).not.toContain(SERVING.slice(0, 8));
      // No id of any shape, so this does not become a test of one uuid.
      expect(text).not.toMatch(/[0-9a-f]{8}/i);
    }
  });

  /**
   * Still asserted, and now for the opposite reason.
   *
   * It used to be here because the app could NOT run as the reader and saying
   * so would have been false. On-behalf-of execution has shipped, so on some
   * deployments it can, and the banner still must not say it, because this
   * module cannot tell which deployment it is running on. Wrong in the other
   * direction is no better.
   */
  it('never claims the signed-in user is the one executing', () => {
    for (const text of everyLine()) {
      expect(text).not.toMatch(/\bruns? as you\b/i);
      expect(text).not.toMatch(/\bexecutes? as you\b/i);
      expect(text).not.toMatch(/\bunder your own identity\b/i);
      expect(text).not.toMatch(/\bas the signed-in user\b/i);
    }
  });

  /**
   * The new one. A second execution mode is being built; copy that forecloses
   * it has to be unwritten the day it ships, and the version that ships in
   * between is wrong.
   */
  it('does not assert the service principal is the only way to execute', () => {
    for (const text of everyLine()) {
      expect(text).not.toMatch(/\bby design\b/i);
      expect(text).not.toMatch(/\bonly\b/i);
      expect(text).not.toMatch(/\balways\b/i);
    }
  });

  /**
   * The rule that replaced its opposite, and the more important of the two.
   *
   * A field here used to REQUIRE every mode to name the executing identity,
   * because "Your access was verified and confirmed" standing alone reads as
   * though the reader's own identity is running the queries, and at the time
   * it was not. On-behalf-of execution then shipped and the safeguard became
   * the false claim it was guarding against.
   *
   * So the rule inverts: this module does not speak for the execution layer at
   * all. Which identity ran a question is decided per release by the agent and
   * the server, and is reported on the Connections page from what the server
   * said. A constant compiled into the client is wrong on precisely the release
   * that changes the arrangement, which is the release where it matters.
   */
  it('does not assert which identity executes, beyond naming its own mode', () => {
    expect(executionStatus('user-verified').label).not.toMatch(/execut/i);
    expect(executionStatus('skipped').label).not.toMatch(/execut/i);
    // The one mode allowed to name an identity is the one whose name IS the
    // identity, and it still states a mode rather than an execution guarantee.
    expect(executionStatus('service-principal').label).toBe('Operating in service principal mode');
  });

  it('does not let a skipped check read as a passed one', () => {
    expect(executionStatus('skipped').label).toContain('skipped');
    expect(executionStatus('skipped').label).not.toContain('verified');
  });

  /**
   * A rolling deploy puts a newer server in front of an older client for a few
   * minutes. Blanking the banner then would hide the part we can still speak
   * to (which identity executes), to avoid overstating the part we cannot.
   */
  it('degrades to the plain status for a mode it does not know', () => {
    expect(executionStatus('some-mode-a-later-release-adds').label).toBe('Operating in service principal mode');
  });
});

describe('the abbreviated principal beside it', () => {
  it('never returns a full uuid', () => {
    const label = principalLabel(SERVING);
    expect(label).not.toContain(SERVING);
    expect(label).toBe('00000000\u2026');
    // Long enough to tell two principals apart, short enough not to be the
    // first thing read on every screen.
    expect(label.length).toBeLessThan(12);
  });

  it('shows a name whole, because a name is worth reading', () => {
    expect(principalLabel('player-insights-serving-sp')).toBe('player-insights-serving-sp');
  });

  it('truncates a name too long for a status row', () => {
    const label = principalLabel('an-extremely-long-service-principal-display-name');
    expect(label).toHaveLength(28);
    expect(label.endsWith('\u2026')).toBe(true);
  });

  it('returns nothing for nothing, rather than a placeholder identity', () => {
    // A stored placeholder in a governance record looks like an identity, which
    // is the failure this app is most careful about.
    for (const empty of [null, undefined, '', '   ']) {
      expect(principalLabel(empty)).toBe('');
    }
  });

  it('knows an opaque id from a name, so a settings row can say which it is', () => {
    expect(isOpaqueId(SERVING)).toBe(true);
    expect(isOpaqueId('player-insights-serving-sp')).toBe(false);
    expect(isOpaqueId(null)).toBe(false);
  });
});

/**
 * The paragraph that used to sit under the banner and now sits on the
 * Connections page, beside the principal it names.
 *
 * Verbatim from the server except for one substitution, because the id is
 * printed in a field of its own directly above it and the standing rule is that
 * a screen shows the full identifier at most once.
 */
describe('the verification detail, moved into settings', () => {
  const DETAIL =
    'Verified you hold CAN_USE on the SQL warehouse and SELECT on 10 tables under your own token; ' +
    `execution still runs as ${SERVING}. CAN RUN confirmed on 2 of 2 Genie spaces under the same ` +
    'token. Row-level filters and column masks were not checked and are not covered by this.';

  it('abbreviates the principal it repeats, and leaves everything else alone', () => {
    const shown = withoutRepeatedPrincipal(DETAIL, SERVING);
    expect(shown).not.toContain(SERVING);
    expect(shown).toContain('execution still runs as 00000000\u2026');
    expect(shown).toContain('CAN_USE on the SQL warehouse and SELECT on 10 tables');
    expect(shown).toContain('CAN RUN confirmed on 2 of 2 Genie spaces');
  });

  /**
   * The honest limit of what was checked. Keeping the grants and dropping this
   * would turn a partial check into a clean bill of health, which is the exact
   * overstatement the access gate exists to prevent.
   */
  it('keeps the row-filter and column-mask caveat', () => {
    expect(withoutRepeatedPrincipal(DETAIL, SERVING)).toContain('Row-level filters and column masks were not checked and are not covered by this.'
    );
  });

  it('still does not claim the reader is the one executing', () => {
    const shown = withoutRepeatedPrincipal(DETAIL, SERVING);
    expect(shown).not.toMatch(/\bruns? as you\b/i);
    expect(shown).not.toMatch(/\bexecutes? as you\b/i);
    expect(shown).toContain('execution still runs as');
  });

  it('matches the id whatever case it arrives in', () => {
    // The id and the sentence reach the client by different code paths. A rule
    // that quietly matches nothing is worse than no rule, and this repo has
    // shipped two of those.
    const shouty = DETAIL.replace(SERVING, SERVING.toUpperCase());
    expect(withoutRepeatedPrincipal(shouty, SERVING)).not.toContain(SERVING.toUpperCase());
  });

  it('leaves the sentence untouched when there is no principal to abbreviate', () => {
    const noPrincipal = 'Verified you hold CAN_USE; execution still runs as the agent serving principal.';
    expect(withoutRepeatedPrincipal(noPrincipal, null)).toBe(noPrincipal);
    expect(withoutRepeatedPrincipal(noPrincipal, '  ')).toBe(noPrincipal);
    expect(withoutRepeatedPrincipal('', SERVING)).toBe('');
  });
});
