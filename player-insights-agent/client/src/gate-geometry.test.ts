import { describe, expect, it } from 'vitest';

import { partial } from './styles/stylesheet';

/**
 * What the access gate's shape has to keep saying.
 *
 * It is the app's only real modal, and the first thing a new reader ever sees, so
 * two of the revamp's rules meet here and pull in opposite directions. Nothing in
 * the app floats or is translucent any more -- but a modal scrim is translucent by
 * definition, because it is showing you the page you are being held back from, and
 * a dialog that does not float is not a dialog. Both exceptions are deliberate and
 * both are narrow: the scrim and the panel's shadow, and nothing else on the
 * screen.
 *
 * The rest is about which of three states may be coloured. A refusal is red, the
 * limits of the check are amber, and the gate itself -- a question the app asks
 * everybody, every time -- is ordinary chrome. Getting that wrong in either
 * direction is the same defect: a screen where the reader cannot tell whether
 * anything has actually gone wrong.
 *
 * Read against the stylesheet, in the pattern palette.test.ts established, because
 * this repo has no jsdom. What a browser would have to confirm is in the handover.
 */

const CSS = partial('gate.css');

/**
 * Everything one selector declares, and a throw rather than an empty string when
 * the selector is absent. Several assertions here are negative -- that a rule does
 * NOT paint red, that it is NOT translucent -- and a missing selector would satisfy
 * every one of them while the screen said nothing at all.
 *
 * Every matching block, not the first: `.access-gate-raw pre` is declared once
 * alongside the remedy panel and again on its own to take back the one property
 * the two panels disagree about. Reading only the first block would be reading half
 * of what the browser will apply.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bodies = [...CSS.matchAll(new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gm'))].map(
    ([, , body]) => body
  );
  if (bodies.length === 0) throw new Error(`gate.css has no rule for ${selector}`);
  return bodies.join('\n');
}

describe('the panel', () => {
  it('is the handoff’s 640px card, at the card radius', () => {
    const panel = rule('.access-gate-panel');
    expect(panel).toMatch(/width:\s*640px/);
    // On a phone the fixed width has to give way, or the panel is wider than the
    // screen and the buttons at the bottom of it cannot be reached.
    expect(panel).toMatch(/max-width:\s*100%/);
    expect(panel).toMatch(/border-radius:\s*var\(--radius-md\)/);
  });

  it('uses neutral dialog chrome rather than a decorative blue stripe', () => {
    const panel = rule('.access-gate-panel');
    expect(panel).toMatch(/border:\s*1px solid var\(--ast-border-input\)/);
    expect(panel).not.toMatch(/border-top|--(?:db-blue|ast-blue|primary)/);
    expect(CSS).toMatch(
      /\.access-gate-panel\.ast-dialog-panel:focus,\s*\.access-gate-panel\.ast-dialog-panel:focus-visible\s*\{[^}]*outline:\s*none/
    );
  });

  it('keeps exactly two exceptions to the flat, opaque rule: the scrim and the panel’s shadow', () => {
    // Both are the app's darkest fill held at a fraction, rather than a hand-typed
    // `rgba(17, 23, 28, ...)` that no longer knows it is a palette colour.
    expect(rule('.access-gate')).toMatch(/background:\s*color-mix\(in oklab, var\(--db-ink-deep\) 50%, transparent\)/);
    expect(rule('.access-gate-panel')).toMatch(
      /box-shadow:\s*0 18px 48px color-mix\(in oklab, var\(--db-ink-deep\) 22%, transparent\)/
    );
    // And nowhere else. A mix against `transparent` or the shared hover tint are
    // the tells now that neither is spelled out; the third permitted use is that
    // hover tint, a wash of the action colour on a control.
    const translucent = [
      ...CSS.matchAll(/^\s*(background|box-shadow|border-color)[^;]*(color-mix\(|--db-hover-tint|rgba\()[^;]*;/gm),
    ].map(([line]) => line.trim());
    expect(translucent).toHaveLength(3);
  });

  it('writes the hover wash as the shared token, so it follows the blue', () => {
    // It was `rgba(34, 114, 180, 0.08)` here and at three other call sites, none
    // of which could see each other. 34, 114, 180 is #2272B4 is --db-blue-600, so
    // moving the action colour would have left four hover states behind.
    // `:not(.refresh-button)` is in the selector because the re-check is the
    // app's shared Refresh control once a check has failed, and that control is
    // filled blue -- a hover WASH on a fill is close to invisible, so it takes
    // its own darker rung in page-shell.css and has to be excluded from these.
    expect(rule('.access-gate-actions button:not(.refresh-button):hover:not(:disabled)')).toMatch(
      /background:\s*var\(--db-hover-tint\)/
    );
    expect(CSS).not.toMatch(/rgba\(34,\s*114,\s*180/);
  });
});

describe('which of the three states is allowed colour', () => {
  it('paints the refusal in red, wash and line and verdict', () => {
    const bad = rule('.access-gate-result-bad');
    expect(bad).toMatch(/background:\s*var\(--db-red-wash\)/);
    expect(bad).toMatch(/border:\s*1px solid var\(--db-red-line\)/);
    // The classification of the failure decides who the reader has to go and talk
    // to, and it is the one line on the panel that is red as type.
    expect(rule('.access-gate-verdict')).toMatch(/color:\s*var\(--db-red-600\)/);
  });

  it('paints the limits of the check in amber, because a limit is not a failure', () => {
    const neutral = rule('.access-gate-result-neutral');
    expect(neutral).toMatch(/background:\s*var\(--db-amber-wash\)/);
    expect(neutral).toMatch(/border:\s*1px solid var\(--db-amber-line\)/);
    // Colouring these like a failure would teach the reader to skip the two things
    // on this screen that cannot fail loudly.
    expect(neutral).not.toMatch(/red/);
  });

  it('leaves the gate itself on neutral elevated glass', () => {
    // Every session that has the grant sees this panel and nothing else. If the
    // panel were tinted, having access would look like a problem.
    const panel = rule('.access-gate-panel');
    expect(panel).toMatch(/background:\s*var\(--ast-surface-elevated\)/);
    expect(panel).not.toMatch(/red|amber|orange/);
  });
});

describe('the three doors', () => {
  it('gives the recommended one the action fill, as a class the markup can move', () => {
    // Which door is recommended changes once a check has failed: re-running a probe
    // that just failed for a missing grant is not where that reader should be sent.
    // So this is a class, not a position, and the component moves it.
    const primary = rule('.access-gate-primary');
    expect(primary).toMatch(/background:\s*var\(--primary\)/);
    expect(primary).toMatch(/color:\s*var\(--primary-foreground\)/);
  });

  it('keeps the second line of the primary button readable on the fill', () => {
    // It was white at 86%, which was 15:1 on the old black fill and 4.20:1 on the
    // new blue -- a fail at 12px. Solid white is 5.08:1. The line is subordinate to
    // the label by weight and size, which is enough hierarchy without the alpha.
    expect(rule('.access-gate-primary span')).toMatch(/color:\s*var\(--primary-foreground\)/);
  });

  it('marks the lesser door as lesser without hiding it', () => {
    // An option nobody can find is not a choice, it is a maze. An option that looks
    // exactly as endorsed as the one beside it is not a hierarchy.
    expect(rule('.access-gate-skip')).toMatch(/border-style:\s*dashed/);
  });

  it('never puts the evaluation colour on something you press', () => {
    // Amber is evaluation only. These three buttons decide whose authority answers
    // are taken under; none of them is a judge score.
    expect(rule('.access-gate-actions button:not(.refresh-button)')).not.toMatch(/amber|warning/);
    expect(rule('.access-gate-actions button:not(.refresh-button):hover:not(:disabled)')).toMatch(
      /border-color:\s*var\(--db-blue-600\)/
    );
  });
});

describe('the parts a reader has to be able to use', () => {
  it('makes the remedy selectable in one gesture and the raw reply selectable by hand', () => {
    // The GRANT is meant to be lifted out whole, so one click takes all of it. The
    // service's own reply is there to be read against the classification above it,
    // so it stays ordinary text.
    expect(rule('.access-gate-remedy pre,\n.access-gate-raw pre')).toMatch(/user-select:\s*all/);
    expect(rule('.access-gate-raw pre')).toMatch(/user-select:\s*text/);
  });

  it('restates the bullet list’s markers, which the app’s reset clears', () => {
    // With three refusals on screen, the boundary between one object's fix and the
    // next is the only thing keeping them from reading as one paragraph.
    expect(rule('.access-gate-result ul')).toMatch(/list-style:\s*disc outside/);
  });

  it('divides the way out from the refusal with a line that can actually be seen', () => {
    // Not `--db-red-line`: this sits on the red wash, and #FBD0D8 over #FFF5F7 is a
    // few steps per channel. A rule nobody can see does not separate anything.
    expect(rule('.access-gate-fallback')).toMatch(/border-top:\s*1px solid color-mix\(in oklab, var\(--db-red-600\)/);
  });
});

describe('two radii, and no third', () => {
  it('writes every corner as one of the two tokens', () => {
    const radii = [...CSS.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(radii.length).toBeGreaterThan(4);
    expect(radii.filter((value) => !/^var\(--radius-(sm|md)\)$/.test(value))).toEqual([]);
  });
});
