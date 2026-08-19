import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ArchitecturePage } from './ArchitecturePage';
import { ConnectionsPage } from './ConnectionsPage';
import { UnavailablePanel } from './UnavailablePanel';
import { NEVER_READ, REFRESH_BUSY_LABEL, REFRESH_LABEL, RefreshControl, readAgo } from './RefreshControl';
import { unavailableNotice } from './unavailable-copy';
import { partial } from './styles/stylesheet';

/**
 * One control, one word, on every screen that re-reads something.
 *
 * The app had four of these and they had drifted: the Connections header said
 * "Re-check", the Architecture header said "Re-check" over a sentence that named
 * "Run the checks", the error alert on Connections said "Try again" for exactly
 * the same action, and the unavailable panel said it again with no icon. Each was
 * its own markup, so each could be corrected on its own and three of them were.
 *
 * The claims below are made against RENDERED output wherever the fact is about
 * what a reader sees, in the pattern connections-render.test.tsx established:
 * this repository has been bitten by screens that were wrong while every
 * assertion about their source was true.
 */

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

/** The text a reader sees, tags removed and entities put back. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '\u00b7')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A page as a reader first meets it: mounted, nothing fetched, nothing checked. */
function page(node: React.ReactElement): string {
  const context = {
    role: { state: 'admin' as const, addedAdminsReadable: true },
    features: {},
    setFeature: () => {},
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route index element={node} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

/** Every surface that offers to re-read something. */
const PAGES: Array<[string, () => string]> = [
  ['Connections', () => page(<ConnectionsPage />)],
  ['Architecture', () => page(<ArchitecturePage />)],
  [
    'the unavailable panel',
    () =>
      page(
        <UnavailablePanel
          notice={unavailableNotice({ surface: 'benchmarks', code: 'DEPENDENCY_UNAVAILABLE' })}
          onRetry={() => {}}
        />
      ),
  ],
];

/** The control on its own, in whichever state is under test. */
function control(props: { busy?: boolean; checkedAt: string; now?: number }): string {
  return renderToStaticMarkup(
    <RefreshControl busy={props.busy} checkedAt={props.checkedAt} now={props.now} onRefresh={() => {}} />
  );
}

/** 15 Aug 2026, 18:00 UTC, and two minutes after it. */
const READ_AT = '2026-08-15T18:00:00Z';
const TWO_MIN_LATER = Date.parse(READ_AT) + 2 * 60 * 1000;

describe('the word on the control is the same word everywhere', () => {
  it.each(PAGES)('%s offers Refresh and none of the labels it replaced', (_name, markup) => {
    const rendered = text(markup());

    expect(rendered).toContain('Refresh');
    for (const dropped of ['Re-check', 'Re-checking', 'Run the checks', 'Try again']) {
      expect(rendered, dropped).not.toContain(dropped);
    }
  });

  /**
   * The label lives in one module, so the pages cannot disagree about it again.
   * Asserted against source because it is a fact about where the string comes
   * from rather than about what the screen says.
   */
  it.each(['ConnectionsPage.tsx', 'ArchitecturePage.tsx'])(
    '%s draws the shared control rather than its own',
    (file) => {
      const page = source(file);

      expect(page).toMatch(/from '\.\/RefreshControl'/);
      // No hand-rolled copy: the icon, the label and the pending state are the
      // shared component's, which is the only thing that keeps them identical.
      expect(page).not.toMatch(/RefreshCw/);
      expect(page).not.toMatch(/'Refresh'/);
    }
  );

  it('spells the word once, in the module both pages read it from', () => {
    expect(REFRESH_LABEL).toBe('Refresh');
    expect(REFRESH_BUSY_LABEL).toBe('Refreshing\u2026');
  });

  /**
   * The state every reader meets first, on both pages: mounted, nothing fetched.
   * A page that opened with a time in it would be reporting a reading nobody has
   * taken.
   */
  it.each(PAGES.slice(0, 2))('%s opens saying nothing has been read', (_name, markup) => {
    const rendered = text(markup());

    expect(rendered).toContain(`${NEVER_READ} ${REFRESH_LABEL}`);
  });
});

describe('what the control says while it is working', () => {
  it('relabels itself, disables itself and spins', () => {
    const busy = control({ busy: true, checkedAt: READ_AT, now: TWO_MIN_LATER });

    expect(busy).toContain(REFRESH_BUSY_LABEL);
    expect(busy).not.toContain(`>${REFRESH_LABEL}<`);
    // Disabled so a second press cannot race the first: both reads land on the
    // same state, and the later answer used to be able to arrive first. The
    // attribute, not the word: the primitive's class list mentions `disabled:`
    // utilities in every state it has.
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('refresh-spin');
  });

  it('is pressable and unspun the rest of the time', () => {
    const idle = control({ checkedAt: READ_AT, now: TWO_MIN_LATER });

    expect(idle).toContain(REFRESH_LABEL);
    expect(idle).not.toContain(REFRESH_BUSY_LABEL);
    expect(idle).not.toContain('disabled=""');
    expect(idle).not.toContain('aria-busy');
    expect(idle).not.toContain('refresh-spin');
  });

  /**
   * The word carries the state on its own, which is what makes the rotation
   * optional. A reader who has asked for less motion loses the animation and
   * nothing else.
   */
  it('keeps the state readable with the animation switched off', () => {
    const css = partial('page-shell.css');

    expect(css).toMatch(/@keyframes refresh-spin/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.refresh-spin \{\s*animation: none;/);
  });
});

/**
 * One control, one treatment, and it is the filled blue.
 *
 * It was `outline`, which put the only control on these headings that does
 * anything into the quietest treatment the app has, next to a timestamp. The Ops
 * health Refresh had already been specified as primary blue, so five surfaces
 * disagreed with the sixth and the sixth was the one that was right.
 *
 * Asserted on the component and the stylesheet rather than per page, because
 * "every place it appears" is a property of there being one component. A test per
 * page would pass a per-page override, which is the thing being ruled out.
 */
describe('the treatment, once, for every seat', () => {
  it('is the filled variant and not the outline', () => {
    const component = source('RefreshControl.tsx');

    expect(component).toMatch(/variant="default"/);
    expect(component).not.toMatch(/variant="outline"/);
  });

  it('paints a blue fill with a white label, at the app’s semibold', () => {
    const css = partial('page-shell.css');
    const base = css.match(/\.refresh-button \{([^}]*)\}/)?.[1] ?? '';

    expect(base, 'page-shell.css still has a .refresh-button rule').not.toEqual('');
    expect(base).toMatch(/background:\s*var\(--db-blue-600\)/);
    expect(base).toMatch(/color:\s*#fff/);
    expect(base).toMatch(/font-weight:\s*600/);
  });

  /**
   * DARKER, NOT TINTED, and this is the one thing about the change that is easy to
   * get wrong. `--db-hover-tint` and `--db-press-tint` are the same blue at 8% and
   * 16%; on white they read as an arriving colour, and on a solid blue fill they
   * are close to invisible. Those are the tokens this button would have inherited,
   * because it was an outline control until now.
   */
  it('moves down a rung on hover and press rather than washing itself', () => {
    const css = partial('page-shell.css');

    expect(css).toMatch(/\.refresh-button:hover:not\(:disabled\) \{[^}]*background:\s*var\(--db-blue-700\)/);
    expect(css).toMatch(/\.refresh-button:active:not\(:disabled\) \{[^}]*background:\s*var\(--db-blue-800\)/);
    expect(css).not.toMatch(/\.refresh-button[^{]*\{[^}]*var\(--db-(hover|press)-tint\)/);
  });

  /**
   * Disabled means a read is in flight, which is a wait and not a refusal. Fading
   * only the label would leave white text on full-strength blue at the moment a
   * reader most wants to read it, and what it says then is "Refreshing…", which is
   * the sentence carrying the state.
   */
  it('dims as a whole while it works, so the white label keeps its ratio', () => {
    const disabled = partial('page-shell.css').match(/\.refresh-button:disabled \{([^}]*)\}/)?.[1] ?? '';

    expect(disabled, 'page-shell.css still has a disabled rule').not.toEqual('');
    expect(disabled).toMatch(/opacity:\s*0\.6/);
    expect(disabled).toMatch(/color:\s*#fff/);
  });

  /**
   * The gate's re-check is this control now, so the gate's door rules must not
   * reach it. gate.css loads after page-shell.css and `.access-gate-actions
   * button` outweighs `.refresh-button`, so without the exclusion the control
   * would be filled blue everywhere in the app except the one screen it just
   * arrived on.
   */
  it('is excluded from the access gate’s door rules', () => {
    const gate = partial('gate.css');
    const doorRules = [...gate.matchAll(/\.access-gate-actions button([^{]*)\{/g)].map(([, rest]) => rest);

    expect(doorRules.length).toBeGreaterThan(0);
    for (const rest of doorRules) {
      expect(rest, `a door rule reaches the shared control: .access-gate-actions button${rest}`).toContain(
        ':not(.refresh-button)'
      );
    }
  });
});

describe('when it was last read', () => {
  it('says it the way the design says it', () => {
    expect(readAgo(READ_AT, TWO_MIN_LATER)).toBe('Read 2 min ago');
    expect(control({ checkedAt: READ_AT, now: TWO_MIN_LATER })).toContain('Read 2 min ago');
  });

  it('rounds to the coarsest unit that is still true', () => {
    const at = Date.parse(READ_AT);
    expect(readAgo(READ_AT, at + 5_000)).toBe('Read just now');
    expect(readAgo(READ_AT, at + 90 * 60 * 1000)).toBe('Read 2 h ago');
    expect(readAgo(READ_AT, at + 3 * 24 * 60 * 60 * 1000)).toBe('Read 3 d ago');
  });

  /**
   * Nothing read yet says so. Not a zero, not a clock time taken from now, and
   * not an empty gap where a sentence should be -- this control opens in that
   * state on the Architecture tab every single time, because that page probes
   * nothing until it is asked to.
   */
  it('says nothing has been read rather than inventing a time', () => {
    const fresh = control({ checkedAt: '' });

    expect(NEVER_READ).toBe('Not read yet');
    expect(fresh).toContain(NEVER_READ);
    expect(fresh).not.toMatch(/Read \d/);
    expect(fresh).not.toMatch(/ago/);
    // A stamp nothing can be made of is the same claim as no stamp at all.
    expect(readAgo('not a date', Date.now())).toBe(NEVER_READ);
  });
});

describe('the control for somebody who cannot see it', () => {
  /**
   * The accessible name is the button's own text, so it reads as "Refreshing…"
   * while it is working rather than as a name that has stopped being true. An
   * `aria-label` would have frozen it at one of the two.
   */
  it('names itself from its own words, and hides the icon that would repeat them', () => {
    const busy = control({ busy: true, checkedAt: READ_AT, now: TWO_MIN_LATER });

    expect(busy).not.toContain('aria-label');
    expect(busy).toMatch(/aria-hidden="true"[^>]*>|<svg[^>]*aria-hidden="true"/);
    expect(text(busy)).toContain(REFRESH_BUSY_LABEL);
  });

  it('announces the wait and the time it ended', () => {
    const busy = control({ busy: true, checkedAt: READ_AT, now: TWO_MIN_LATER });
    const done = control({ checkedAt: READ_AT, now: TWO_MIN_LATER });

    for (const markup of [busy, done]) {
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-live="polite"');
    }
    // The live region carries the state; the visible line is the same sentence
    // for eyes, and is out of the accessibility tree so it is not heard twice.
    expect(busy).toMatch(/role="status"[^>]*>Refreshing/);
    expect(done).toMatch(/role="status"[^>]*>Read 2 min ago/);
    expect(done).toMatch(/aria-hidden="true"[^>]*>Read 2 min ago/);
  });
});

describe('one clock', () => {
  /**
   * Architecture used to state freshness twice: this control, and a LAST CHECK
   * tile below it reading the same `checkedAt` through `checkedAgo`. The tile is
   * gone, and this is what stops it coming back -- a second reading is a second
   * thing to round differently, word differently, or leave stale.
   */
  it('leaves the reading of the clock to this control alone', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const callers = readdirSync(here)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
      .filter((name) => name !== 'architecture.ts') // where it is defined
      .filter((name) => source(name).includes('checkedAgo('));

    expect(callers).toEqual(['RefreshControl.tsx']);
  });

  it('states it in one place on the page, not two', () => {
    const markup = page(<ArchitecturePage />);

    expect(text(markup)).not.toContain('Last check');
    expect([...markup.matchAll(/Not read yet/g)]).toHaveLength(2); // seen, and heard
  });
});
