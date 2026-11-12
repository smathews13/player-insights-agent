import { describe, expect, it } from 'vitest';

import { partialNames, partial, stylesheet } from './styles/stylesheet';

/**
 * An AlertDescription is laid out by the library again, and the app no longer argues.
 *
 * This file used to assert the opposite. The stylesheet pinned
 * `[data-slot='alert-description']` to `display: block`, because AppKit ships the slot
 * as `grid justify-items-start gap-1`, which puts every direct child on a row of its
 * own and so turned a sentence with an inline <strong> in it into a list. The pin
 * worked, and it cost more than it saved: it is unlayered, Tailwind's utilities are
 * not, so it outranked them, and a `flex flex-col gap-1.5` written at a call site was
 * silently ignored. Flex children have no whitespace between them, because JSX drops
 * it, so the spacing that class was asking for was the only thing separating one
 * sentence from the next -- the storage banner shipped reading "Nothing stored
 * yet.Lakebase is connected", and the shared unavailable panel collapsed a heading, a
 * detail line, a timestamp and a retry button onto one unbroken line. Both looked like
 * a rendering fault, both were live in front of a customer, and both were one inert
 * class. The handoff records the pin as the defect behind them, and it is gone.
 *
 * Note that layering it rather than deleting it would have been the same thing as
 * deleting it. AppKit applies `grid` to the element as a utility class, so any rule of
 * ours inside a layer loses to it. There was no half measure available here.
 *
 * What that hands back is the row-per-child behaviour, which is right for the call
 * sites that stack a heading over a detail and wrong for the ones that write a
 * sentence across a <strong> and the text after it. Those read as one paragraph today
 * and will read as two rows now. The answer is to wrap the sentence in one child,
 * which is what UnavailablePanel already does; it is call-site work in .tsx and is
 * recorded in the handover rather than done here.
 *
 * So this file asserts what is now true: that the app does not pin the slot's layout
 * from anywhere, and that the two rules which are about the alert running off the
 * right edge -- the half of the original complaint that had nothing to do with
 * display -- are still there. Those two are the invariant worth keeping.
 */

const STYLESHEET = stylesheet();

/** The body of the app's own rule for the description slot. */
function descriptionRule() {
  return STYLESHEET.match(/\[data-slot='alert-description'\]\s*\{([^}]*)\}/)?.[1] ?? '';
}

describe('the alert description is laid out by the library, not by the app', () => {
  it('no longer pins the slot to a display of the app’s choosing', () => {
    // The direct assertion of the fix. If someone reintroduces this to quiet a
    // stacked sentence, they will take every flex and grid utility inside every
    // alert in the app down with it, which is a trade nobody makes on purpose.
    expect(descriptionRule()).not.toMatch(/display:/);
  });

  it('does not pin it from somewhere else in the stylesheet either', () => {
    // The rule above is one selector. This is the same check over the whole split
    // stylesheet, so moving the declaration into another partial does not slip past.
    const offenders = partialNames()
      .map((name) => [name, partial(name)] as const)
      .filter(([, source]) =>
        [...source.matchAll(/([^{}]*alert-description[^{}]*)\{([^}]*)\}/g)].some(([, , body]) => /display:/.test(body))
      )
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('keeps alert copy able to wrap a token longer than its column', () => {
    // The Alert root is a grid whose second track is `1fr`, and an fr track floors at
    // the item's min-content, so one long unbroken string -- a connection string in a
    // server error, a path in a remedy -- widens the grid past the viewport instead of
    // wrapping. This is the other half of the "text runs off the right edge"
    // complaint, it has nothing to do with display, and it survives the revamp.
    const rule = descriptionRule();
    expect(rule).toContain('min-width: 0');
    expect(rule).toContain('overflow-wrap: anywhere');
  });

  it('still states the copy colour, so the slot is not left to AppKit’s tinted grey', () => {
    // AppKit paints a destructive alert's description at `text-destructive/90`, a
    // partial-alpha red that DuBois does not have. The app states a solid body grey
    // instead and puts the red on the alert's edge and wash, which is the handoff's
    // recipe. Asserted because it is the reason the app has a rule here at all now.
    expect(descriptionRule()).toMatch(/color:\s*var\(--db-body\)/);
  });

  it('leaves the destructive alert its own edge and surface rather than red type', () => {
    const alerts = partial('alerts.css');
    expect(alerts).toMatch(/text-destructive[^{]*\{[^}]*--db-red-wash/);
  });
});
