/**
 * Which tabs each role can actually click, asserted against rendered markup.
 *
 * This file exists because of a specific failure and is written against its
 * recurrence. `role.ts` has held the admin set -- Ask PIA, Run Explorer,
 * Monitoring, Ops, Connections, Architecture -- since the permission foundation
 * landed, and every test of it passed, while `Layout.tsx` drew a hardcoded row
 * that had never heard of Monitoring or Ops. Both routes were registered and
 * both URLs worked. Nobody could reach either by clicking, and a deploy would
 * have shipped two invisible pages.
 *
 * So the assertions here are deliberately about the RENDERED NAV rather than
 * about `navEntries`. A test that calls the function tests the list; only a test
 * that renders the component tests the navigation. Ops and Monitoring have their
 * own render tests for the same reason, and this is the one above them.
 *
 * HIDING IS NOT PERMISSION, and nothing here should be read as claiming it is.
 * Every admin route is refused on the server with a 403 whatever this draws; see
 * `ADMIN_ROUTE_PREFIXES` and its own tests. What is checked here is what the app
 * OFFERS, which is a separate promise: that a consumer is not shown a door that
 * will be shut in their face, and that an administrator is shown the two pages
 * they open the app for.
 *
 * PIXELS ARE NOT VERIFIED BY ANY OF THIS. These are the words and the order a
 * reader would see. Nothing here says the row fits.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

/**
 * WITH THE REVIEW FLAG OFF, which is the only way this file can go on meaning
 * what it says.
 *
 * `SHOW_EVERY_TAB_TO_EVERYONE` is on in the shipped build and draws the admin
 * set for every reader, so against the real module every assertion below about
 * what a consumer is NOT shown would pass by accident and stop being a test of
 * the role logic at all. The role logic is still there, is still what the app
 * returns to when the flag goes back off, and is what this file is for.
 *
 * The flag's own behaviour is asserted in `nav-reveal.test.tsx`, against the
 * real value, so neither position is left unexercised.
 */
vi.mock('./nav-reveal', () => ({ SHOW_EVERY_TAB_TO_EVERYONE: false, BENCHMARK_LAB_ENABLED: false }));

import { NavLinks } from './Layout';
import { mobileNavLinkClass } from './layout-view';
import { showsSettingsGear, type RoleResolution, type RoleState } from './role';
import { NO_EXPERIMENTS, type ExperimentalFeatures } from './experimental-features';
import { partial } from './styles/stylesheet';

const LAYOUT_SOURCE = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
/** Comments stripped, so prose about a control is not read as the control. */
const LAYOUT = LAYOUT_SOURCE.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

function resolution(state: RoleState): RoleResolution {
  return { state, addedAdminsReadable: true };
}

function features(overrides: Partial<ExperimentalFeatures> = {}): ExperimentalFeatures {
  return { ...NO_EXPERIMENTS, ...overrides };
}

/**
 * The nav as one of the two widths draws it.
 *
 * `linkClass` is the only difference between the header row and the contents of
 * the mobile sheet, so passing it here is what makes "and the same is true on a
 * phone" a claim this file can actually make rather than assert by analogy.
 */
function render(
  state: RoleState,
  options: { features?: ExperimentalFeatures; mobile?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NavLinks
        linkClass={options.mobile ? mobileNavLinkClass : () => 'app-nav-tab'}
        role={resolution(state)}
        features={options.features ?? features()}
      />
    </MemoryRouter>
  );
}

/** The labels, in the order they are drawn. */
function labels(markup: string): string[] {
  return [...markup.matchAll(/<\/svg>\s*([^<]+?)\s*<\/a>/g)].map((match) => match[1].trim());
}

/** The hrefs, in the order they are drawn. */
function hrefs(markup: string): string[] {
  return [...markup.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

const ADMIN_ORDER = ['Ask', 'Run Explorer', 'Monitoring', 'Ops', 'Connections', 'Architecture'];
const CONSUMER_ORDER = ['Ask', 'Run Explorer', 'Connections', 'Architecture'];

describe('an administrator can reach Monitoring and Ops by clicking', () => {
  it('draws the six tabs in the order the two admin pages sit between the four everybody has', () => {
    // The order is the claim, not just the membership. Monitoring and Ops go
    // third and fourth -- after the assistant and the runs, before the two pages
    // that describe the deployment -- because that is the order an administrator
    // reads them in and it is the order Sam specified.
    expect(labels(render('admin'))).toEqual(ADMIN_ORDER);
  });

  it('points them at the routes the router has registered', () => {
    expect(hrefs(render('admin'))).toEqual([
      '/',
      '/runs',
      '/monitoring',
      '/ops',
      '/connections',
      '/architecture',
    ]);
  });

  it('gives every tab an icon, so none of them is a word in a row of pictures', () => {
    // Counted rather than named. Which glyph each page gets is a design choice
    // that may well change; a tab silently losing its icon because a route was
    // added without a matching entry in NAV_ICONS is a defect.
    const markup = render('admin');
    expect(markup.match(/<svg/g) ?? []).toHaveLength(ADMIN_ORDER.length);
  });

  it('draws the same six inside the mobile sheet', () => {
    // Below 1180px the header row is not drawn at all, so this rendering is the
    // ONLY navigation a narrow window has. The two used to be separate lists and
    // an entry added to one was missing from the other until somebody resized.
    expect(labels(render('admin', { mobile: true }))).toEqual(ADMIN_ORDER);
  });
});

describe('a consumer is not shown a door that will be shut in their face', () => {
  it('draws four tabs and neither admin page', () => {
    expect(labels(render('consumer'))).toEqual(CONSUMER_ORDER);
  });

  it('names Monitoring and Ops nowhere in the header row, as words or as routes', () => {
    // Absent, not disabled. No greyed entries, no padlocks, and no tooltip
    // explaining a privilege that cannot be requested from inside the app -- a
    // disabled control a reader can never enable is a standing invitation to
    // file a support request.
    const markup = render('consumer');
    expect(markup).not.toContain('Monitoring');
    expect(markup).not.toContain('/monitoring');
    expect(markup).not.toContain('>Ops');
    expect(markup).not.toContain('/ops');
  });

  it('names them nowhere in the mobile sheet either', () => {
    // The half that is easiest to forget, because it takes a narrow window to
    // see it. One component renders both widths so that this cannot drift, and
    // this asserts the property that arrangement exists to guarantee.
    const markup = render('consumer', { mobile: true });
    expect(markup).not.toContain('Monitoring');
    expect(markup).not.toContain('/monitoring');
    expect(markup).not.toContain('/ops');
  });

  it('gets the consumer set while the role is still resolving', () => {
    // Under-offering for a few hundred milliseconds costs an administrator one
    // extra render. Over-offering would put two tabs on screen that vanish, or
    // that answer 403 if clicked in that window.
    expect(labels(render('resolving'))).toEqual(CONSUMER_ORDER);
  });

  it('gets the consumer set when the role could not be read at all', () => {
    // Fail closed. The server is refusing the admin routes either way, so a nav
    // that guessed "probably an admin" would advertise pages that answer 403.
    expect(labels(render('failed'))).toEqual(CONSUMER_ORDER);
  });
});

describe('the settings gear is drawn for an administrator and absent for everyone else', () => {
  it('is admin-only, and not merely disabled for the rest', () => {
    expect(showsSettingsGear('admin')).toBe(true);
    expect(showsSettingsGear('consumer')).toBe(false);
    expect(showsSettingsGear('resolving')).toBe(false);
    expect(showsSettingsGear('failed')).toBe(false);
  });

  it('is behind that decision in the header rather than always rendered', () => {
    // Asserted against the source because the gear lives in Layout, which reads
    // the identity through a hook this file cannot drive without a browser. The
    // page behind it is the admin-list editor and its endpoints refuse a
    // consumer, so a drawn-but-dead gear would be a button that cannot work.
    expect(LAYOUT).toMatch(/showsSettingsGear\(role\.state\)\s*&&[\s\S]{0,400}?aria-label="App settings"/);
  });
});

describe('Benchmark Lab is hidden for every role', () => {
  it('is absent for an administrator, with or without the leftover preference', () => {
    // Unfinished and non-functional: the kill switch hides it from everyone,
    // including administrators. The experimental preference key can still be
    // true in an old browser and must not bring the tab back.
    expect(labels(render('admin'))).not.toContain('Benchmark Lab');
    expect(labels(render('admin', { features: features({ benchmarkLab: true }) }))).not.toContain(
      'Benchmark Lab'
    );
  });

  it('is absent for a consumer even when the leftover preference is on', () => {
    expect(labels(render('consumer', { features: features({ benchmarkLab: true }) }))).not.toContain(
      'Benchmark Lab'
    );
  });
});

describe('one component draws both widths, so they cannot disagree', () => {
  it('renders the nav exactly twice and hands both the same role', () => {
    // The property every "and the same on mobile" claim above rests on. Two
    // call sites, both passing the role the header derived, so there is one
    // decision about what a reader may see rather than one per rendering.
    const uses = [...LAYOUT.matchAll(/<NavLinks[\s\S]*?\/>/g)].map((match) => match[0]);
    expect(uses).toHaveLength(2);
    for (const use of uses) expect(use).toContain('role={role}');
  });

  it('derives that role from the identity already fetched rather than reading it again', () => {
    // Two reads of /api/identity are two answers to one question, and they can
    // race. The header reads it once and the pages take it from the outlet.
    expect(LAYOUT).toContain('const role = roleFrom(identity)');
    expect(LAYOUT).toContain('satisfies AppOutletContext');
    expect(LAYOUT.match(/roleFrom\(/g) ?? []).toHaveLength(1);
  });
});

describe('a wider row still starts on the conversation rail’s edge', () => {
  const SHELL = partial('shell.css');
  const RESPONSIVE = partial('responsive.css');

  /** Comments stripped, so a value discussed in prose is not read as one in a rule. */
  function withoutComments(css: string) {
    return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  }

  it('singles out no tab at either width, so the first one is not cut off', () => {
    // brand-mark.test.ts pins the alignment itself: the brand column is the rail's
    // width less the header's inset, plus the nav's, and that column is the only
    // thing deciding where the row begins. The first tab used to zero its left
    // padding on top of that, which left Ask PIA's icon on its own edge. Neither
    // stylesheet may name the first child again, at either width.
    expect(withoutComments(SHELL)).not.toMatch(/\.app-nav-tab:first-child/);
    expect(withoutComments(RESPONSIVE)).not.toMatch(/\.app-nav-tab:first-child/);
  });

  it('takes the room for two more tabs out of the tabs, in the band that is already tight', () => {
    // Six tabs rather than four, and the nav does not shrink: shell.css pins
    // `flex: none` on it, because navigation is not the part that gives. The
    // chips are, and they have a floor. So the tabs give 4px a side between 1180
    // and 1365 -- the same band where the chip sheds its label -- rather than the
    // row growing into the gear.
    const band = withoutComments(RESPONSIVE).match(/@media \(max-width: 1365px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(band, 'responsive.css still has the 1365 band').not.toEqual('');
    expect(band).toMatch(/\.app-nav-tab\s*\{\s*padding:\s*0 8px/);
  });

  it('keeps the nav out of the shrinking, so tabs are never silently clipped', () => {
    // The alternative to tightening the padding was letting the nav shrink,
    // which hides tabs with no indication that there are more. A row that is one
    // tab short looks exactly like a row that is complete.
    expect(withoutComments(SHELL)).toMatch(/\.app-header > nav\s*\{\s*flex:\s*none/);
    expect(withoutComments(SHELL)).toMatch(/\.identity-chips\s*\{[^}]*min-width:\s*0/);
  });
});
