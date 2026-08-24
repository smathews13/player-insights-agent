/**
 * What the header's release chip says, and where it sits.
 *
 * The placement assertions are index comparisons on rendered markup rather than
 * anything about pixels: this suite has no browser, so what it can pin is the
 * order of the elements and the words in them. Which is the half that regressed
 * -- the chip was drawn in the part of the header that gives, so its label was
 * cut off on an ordinary window.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { DeploymentTimeChip } from './DeploymentTimeChip';
import { deploymentLocalTime, deploymentTimeLabel, deploymentTimeTitle } from './deployment-time';
import { HeaderBrand, IdentityChips } from './Layout';
import { WORDMARK } from './astrolabe-mark';
import type { Identity } from './app-types';
import type { RoleResolution } from './role';
import { partial } from './styles/stylesheet';

const DEPLOYED_AT = '2026-08-20T16:51:23.456Z';
const DEPLOYED_BY = 'release.owner@example.test';
const BUILD_SHA = 'a1b2c3d4e5f60718';

const chipMarkup = () =>
  renderToStaticMarkup(<DeploymentTimeChip deployedAt={DEPLOYED_AT} deployedBy={DEPLOYED_BY} buildSha={BUILD_SHA} />);

/** What a reader is described by: the text of the element `aria-describedby` names. */
const tooltipTextOf = (markup: string): string => {
  const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1] ?? '';
  const tooltip = markup.match(/role="tooltip">([\s\S]*?)<\/span>/)?.[1] ?? '';
  // A description that names an id nothing carries is not a description.
  if (!describedBy || !markup.includes(`id="${describedBy}"`)) return '';
  return tooltip;
};
const identity: Identity = {
  signedInAs: 'current.viewer@example.test',
  executionIdentity: 'application service principal',
  executionMode: 'service-principal',
};
const role: RoleResolution = { state: 'super_admin', addedAdminsReadable: true };

describe('the header release chip', () => {
  it('draws the date and nothing else', () => {
    const markup = renderToStaticMarkup(<DeploymentTimeChip deployedAt={DEPLOYED_AT} buildSha={BUILD_SHA} />);

    expect(markup).toContain('data-testid="deployment-time-chip"');
    expect(markup).toContain('>Aug 20<');
    expect(markup).toContain('dateTime="2026-08-20T16:51:23.456Z"');
    // The three things the label used to carry and no longer does. Each was a
    // reason the chip needed more width than the header had for it.
    expect(deploymentTimeLabel(DEPLOYED_AT)).toBe('Aug 20');
    expect(deploymentTimeLabel(DEPLOYED_AT)).not.toContain('Deployed');
    expect(deploymentTimeLabel(DEPLOYED_AT)).not.toContain('2026');
    expect(deploymentTimeLabel(DEPLOYED_AT)).not.toMatch(/\d:\d/);
  });

  it('keeps the time, deployment creator and commit on the tooltip', () => {
    const title = deploymentTimeTitle(DEPLOYED_AT, BUILD_SHA, DEPLOYED_BY);

    expect(title).toContain('Deployed Aug 20, 2026, 4:51:23 PM UTC');
    expect(title).toContain(`by ${DEPLOYED_BY}`);
    expect(title).toContain('commit a1b2c3d4');
    expect(tooltipTextOf(chipMarkup())).toBe(title);
    expect(chipMarkup()).not.toContain(identity.signedInAs);
  });

  it('states the reader\u2019s own clock beside UTC, and states it once', () => {
    const title = deploymentTimeTitle(DEPLOYED_AT, BUILD_SHA);
    const local = deploymentLocalTime(DEPLOYED_AT);

    // Zone-agnostic, because the suite runs wherever it runs. A reader east or
    // west of UTC is owed both clocks; a reader already ON UTC is owed one, and
    // printing it twice would read as a rendering fault rather than agreement.
    if (local) {
      expect(title).toContain(local);
      expect(local).not.toContain('UTC');
    } else {
      expect(title.match(/4:51:23 PM/g)).toHaveLength(1);
    }
  });

  it('abbreviates the commit the way the Build card does, suffix and all', () => {
    // Same eight characters as the App row on Connections, and `+dirty` is the
    // build's opinion of its worktree rather than part of the hash.
    expect(deploymentTimeTitle(DEPLOYED_AT, `${BUILD_SHA}+dirty`)).toContain('commit a1b2c3d4');
    expect(deploymentTimeTitle(DEPLOYED_AT, BUILD_SHA)).not.toContain('a1b2c3d4e5');
  });

  it('omits the commit clause when the build carried no stamp', () => {
    const title = deploymentTimeTitle(DEPLOYED_AT, '');

    expect(title).toContain('Deployed Aug 20, 2026, 4:51:23 PM UTC');
    expect(title).not.toContain('commit');
    // An absent commit must not cost the reader the time as well.
    expect(renderToStaticMarkup(<DeploymentTimeChip deployedAt={DEPLOYED_AT} />)).toContain('>Aug 20<');
  });

  it('draws nothing when the Apps API did not report a usable time', () => {
    expect(renderToStaticMarkup(<DeploymentTimeChip deployedAt="" />)).toBe('');
    expect(renderToStaticMarkup(<DeploymentTimeChip deployedAt="not-a-date" />)).toBe('');
    expect(renderToStaticMarkup(<DeploymentTimeChip deployedAt="" buildSha={BUILD_SHA} />)).toBe('');
  });

  it('uses the same neutral badge recipe as the user and settings controls', () => {
    const css = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rule = css.match(/(?:^|})\s*\.deployment-time-chip\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/min-height:\s*30px/);
    expect(rule).toMatch(/border:\s*1px solid var\(--ast-border-input\)/);
    expect(rule).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(rule).toMatch(/background:\s*var\(--card\)/);
    expect(rule).toMatch(/color:\s*var\(--foreground\)/);
  });
});

/*
 * The half the previous suite did not test, and the half that was broken.
 *
 * Every assertion here used to have one counterpart: "the markup contains
 * `title="..."`". That is true of a string in an attribute nobody can reach. A
 * `title` shows on pointer hover only, `<time>` takes no focus, and a `title` on
 * an element with its own text content is dropped from the accessibility tree in
 * favour of that text -- so the release time was unreachable by keyboard and by
 * screen reader while the suite was green.
 */
describe('reaching the release fact', () => {
  it('carries the fact in an element the chip is described by, not in a title', () => {
    const markup = chipMarkup();

    expect(markup).toContain('role="tooltip"');
    // The description resolves: aria-describedby names an id that is present.
    expect(tooltipTextOf(markup)).toContain('Deployed Aug 20, 2026, 4:51:23 PM UTC');
    expect(tooltipTextOf(markup)).toContain('commit a1b2c3d4');
  });

  it('is reachable by keyboard', () => {
    // `<time>` is not focusable on its own, so without this there is no keystroke
    // that reaches the tooltip at all -- the reported fault, in one attribute.
    expect(chipMarkup()).toMatch(/<time[^>]*tabindex="0"/);
  });

  it('does not also carry a native title, which would draw two tooltips at once', () => {
    // The element tooltip appears under the chip on hover and the browser's own
    // appears at the pointer a second later. Keeping both is the visible
    // regression that comes of "fixing" this by putting the attribute back.
    expect(chipMarkup()).not.toMatch(/<time[^>]*\stitle=/);
  });

  it('says nothing it cannot describe when the build carried no stamp', () => {
    const markup = renderToStaticMarkup(<DeploymentTimeChip deployedAt={DEPLOYED_AT} />);

    expect(tooltipTextOf(markup)).toContain('Deployed Aug 20, 2026, 4:51:23 PM UTC');
    expect(tooltipTextOf(markup)).not.toContain('commit');
  });

  it('gives each chip on the page its own description target', () => {
    // The header draws one and the mobile sheet draws another. Two tooltips
    // under one id is a description that resolves to whichever rendered first.
    const ids = [...chipMarkup().matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
    const sheetIds = [
      ...renderToStaticMarkup(
        <IdentityChips
          identity={identity}
          role={role}
          deployedAt={DEPLOYED_AT}
          buildSha={BUILD_SHA}
          className="mobile-identity"
        />
      ).matchAll(/aria-describedby="([^"]+)"/g),
    ].map((match) => match[1]);

    expect(ids).toHaveLength(1);
    expect(sheetIds).toHaveLength(1);
    expect(new Set([...ids, ...sheetIds]).size).toBe(2);
  });
});

describe('where the header seats the release chip', () => {
  const at = (markup: string, needle: string) => markup.indexOf(needle);

  it('sits after the wordmark and before the divider that precedes the tabs', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <HeaderBrand deployedAt={DEPLOYED_AT} deployedBy={DEPLOYED_BY} buildSha={BUILD_SHA} />
      </MemoryRouter>
    );

    expect(at(markup, WORDMARK)).toBeGreaterThan(-1);
    expect(at(markup, WORDMARK)).toBeLessThan(at(markup, 'data-testid="deployment-time-chip"'));
    expect(at(markup, 'data-testid="deployment-time-chip"')).toBeLessThan(at(markup, 'app-chrome-rule'));
  });

  it('is inside the lockup column, which is what the tab row is aligned to', () => {
    // If the chip were a sibling of the column rather than a child of it, it
    // would sit between the divider and the first tab and push the row off the
    // conversation rail's hairline below it. The column is the whole of what this
    // component renders, so being inside it is: opens with the column, closes
    // with it, chip somewhere between.
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <HeaderBrand deployedAt={DEPLOYED_AT} deployedBy={DEPLOYED_BY} buildSha={BUILD_SHA} />
      </MemoryRouter>
    );

    expect(markup.startsWith('<div class="brand-lockup">')).toBe(true);
    expect(markup.endsWith('</div>')).toBe(true);
    expect(at(markup, 'data-testid="deployment-time-chip"')).toBeGreaterThan(0);
  });

  it('leaves the column to the lockup alone when nothing was reported', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <HeaderBrand />
      </MemoryRouter>
    );

    expect(markup).toContain(WORDMARK);
    expect(markup).not.toContain('deployment-time-chip');
  });

  it('is not drawn a second time in the reader\u2019s badges', () => {
    // The header hands the cluster no time at all, so the chip cannot appear
    // twice on one page. Drawing it in both places is the specific mistake this
    // pins: two elements with one testid is also an ambiguous locator.
    const cluster = renderToStaticMarkup(
      <IdentityChips identity={identity} role={role} gear={<a className="header-settings">gear</a>} />
    );

    expect(cluster).not.toContain('deployment-time-chip');
    expect(cluster).toContain('data-testid="identity-chip"');
  });

  it('is the sheet\u2019s copy that carries it at the widths the lockup truncates', () => {
    const sheet = renderToStaticMarkup(
      <IdentityChips
        identity={identity}
        role={role}
        deployedAt={DEPLOYED_AT}
        deployedBy={DEPLOYED_BY}
        buildSha={BUILD_SHA}
        className="mobile-identity"
      />
    );

    expect(at(sheet, 'data-testid="identity-chip"')).toBeLessThan(at(sheet, 'data-testid="deployment-time-chip"'));
    expect(sheet).toContain(`by ${DEPLOYED_BY}`);
    expect(sheet).not.toContain('by current.viewer@example.test');
    expect(sheet).toContain('commit a1b2c3d4');
  });
});
