import { describe, expect, it } from 'vitest';

import { partial, partialNames } from './styles/stylesheet';

/**
 * One set of widths, and the exception to it named rather than merely present.
 *
 * responsive.css opens by saying it centralises the app's breakpoints, and the
 * reason that claim is worth a test is the defect it was written to fix: there
 * used to be two sets, Tailwind's and this one, both live and neither chosen, so
 * the nav collapsed 100px after the column it shares a header with. A stray query
 * in a page partial is the same failure starting again, and it is invisible until
 * somebody resizes a window to exactly the wrong width.
 *
 * There used to be a documented exception: the architecture graph collapsed into
 * a list at 1024px, a width that was a property of its own drawing. It is gone,
 * and the way it went is worth knowing rather than just recording -- the graph now
 * keeps one fixed layout at every width and a narrow viewport scrolls it, so there
 * is no second arrangement to pick a width for. The tests below insist there is no
 * width query left in that partial, because an exception nobody needs is the same
 * shape as the leftover this file exists to prevent.
 */

const DECLARED = [1365, 1180, 800, 480];
const ROUTE_EXCEPTIONS = new Map<string, number[]>([
  // Dense configured/measured pairs and settings dialogs need one local
  // single-column handoff before the app-wide 480px phone band.
  ['connections.css', [720]],
  ['settings.css', [720]],
  // The cost assumptions row and the four-segment Monitoring control are
  // component geometries, not navigation/layout breakpoints.
  ['ops.css', [640]],
  ['responsive-monitoring.css', [380]],
]);

/** Every width-based media query in a partial, in the order it declares them. */
function widthQueries(css: string): number[] {
  return [...css.matchAll(/@media\s*\((?:max|min)-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));
}

describe('the app has one set of breakpoints', () => {
  it('declares them in responsive.css, largest first', () => {
    // Largest first is not decoration: a narrower rule has to follow the wider one
    // it overrides, because they score the same and only order separates them.
    expect(widthQueries(partial('responsive.css'))).toEqual(DECLARED);
  });

  it('keeps route-owned structural queries on the same declared widths', () => {
    const stray = new Map<string, number[]>();
    for (const name of partialNames()) {
      const found = widthQueries(partial(name));
      const permitted = [...DECLARED, ...(ROUTE_EXCEPTIONS.get(name) ?? [])];
      const unsupported = found.filter((width) => !permitted.includes(width));
      if (unsupported.length > 0) stray.set(name, unsupported);
      expect(found, `${name} keeps larger breakpoints before smaller ones`).toEqual([...found].sort((a, b) => b - a));
    }
    expect([...stray]).toEqual([]);
    for (const [name, expected] of ROUTE_EXCEPTIONS) {
      expect(widthQueries(partial(name)).filter((width) => !DECLARED.includes(width))).toEqual(expected);
    }
  });

  it('folds the ones that were measured against nothing into the declared bands', () => {
    // Connections had its own 640px query for the configured-beside-measured pair,
    // and Architecture had a 900px one for its paired columns and then a 1024px
    // one for the graph. None of those numbers came from anywhere.
    const connections = partial('responsive-connections.css');
    const architecture = partial('responsive-architecture.css');
    expect(connections).toMatch(
      /@media \(max-width: 800px\)[\s\S]*\.connection-pair\s*\{[^}]*grid-template-columns:\s*1fr/
    );
    expect(architecture).toMatch(
      /@media \(max-width: 800px\)[\s\S]*\.arch-loop-tiles\s*\{[^}]*grid-template-columns:\s*repeat\(2/
    );
    expect(architecture).toMatch(
      /@media \(max-width: 1180px\)[\s\S]*\.arch-rails\s*\{[^}]*grid-template-columns:\s*1fr/
    );
    for (const name of ['connections.css', 'architecture.css']) {
      expect(widthQueries(partial(name))).not.toContain(640);
      expect(widthQueries(partial(name))).not.toContain(900);
    }
  });
});

describe('the exception that went away', () => {
  const ARCHITECTURE = partial('architecture.css');

  it('leaves the architecture partial with no width of its own', () => {
    // The 1024px collapse turned eleven absolutely-positioned cards into a list,
    // which meant the page had two layouts and a reader on a laptop saw the one
    // nobody had looked at. The canvas is a fixed size now.
    expect(widthQueries(ARCHITECTURE)).toEqual([]);
    expect(ARCHITECTURE).not.toMatch(/\.arch-node\s*\{[^}]*position:\s*static/);
  });

  it('says what replaced it, in both files', () => {
    // A reader auditing the breakpoint set from either end finds the same answer,
    // which is what the deleted exception's note used to be for.
    expect(ARCHITECTURE).toMatch(/scroll/i);
    expect(ARCHITECTURE).toContain('responsive.css');
    expect(partial('responsive.css')).toContain('architecture.css');
  });

  it('still reshapes the one thing on that page that is a column', () => {
    expect(partial('responsive-architecture.css')).toMatch(/\.arch-rails\s*\{/);
  });
});
