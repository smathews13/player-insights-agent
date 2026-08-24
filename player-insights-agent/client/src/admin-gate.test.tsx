/**
 * That a consumer who follows an administrator's link is told so, rather than
 * being handed an admin page that refuses every request it makes.
 *
 * THIS FILE EXISTS FOR THE THIRD INSTANCE OF ONE DEFECT. role.ts has held the
 * gate's heading, its per-page line, its action and the role-loss sentence since
 * the permission work landed, with tests over every one of them, and nothing in
 * the app called any of it. The role badge was the first instance and the
 * navigation row was the second; both were caught by a test that rendered the
 * thing rather than the module behind it, and both notes say so at the top of
 * their files.
 *
 * So every assertion below renders a ROUTE. A test of `gateLine` cannot fail
 * when no component calls it. These can.
 *
 * PIXELS ARE NOT VERIFIED BY ANY OF THIS. It is markup, wording and route
 * outcomes. Nothing here says the panel is centred or that it fits.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AdminOnly, GatePanel, RoleLostNotice } from './GatePanel';
import { roleLostNotice } from './gate-panel-state';
import {
  ADMIN_PAGE_NAMES,
  GATE_ACTION,
  GATE_HEADING,
  gateLine,
  gateOutcome,
  roleLostSentence,
  type AppOutletContext,
  type RoleResolution,
  type RoleState,
} from './role';
import { NO_EXPERIMENTS } from './experimental-features';

const APP = readFileSync(new URL('App.tsx', import.meta.url), 'utf8');

function resolution(state: RoleState): RoleResolution {
  return { state, addedAdminsReadable: true };
}

/**
 * One admin path, rendered through the wrapper the router puts around it.
 *
 * The outlet context is what `useRole` reads, so this is the same path the real
 * header feeds: one identity read, carried to every page, rather than a second
 * fetch each page makes for itself.
 */
function route(path: string, state: RoleState, body = 'THE_ADMIN_PAGE') {
  const context: AppOutletContext = {
    features: NO_EXPERIMENTS,
    setFeature: () => {},
    role: resolution(state),
  };
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path={path} element={<AdminOnly>{body}</AdminOnly>} />
          <Route path="/" element={<>Ask</>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const ADMIN_PATHS = Object.keys(ADMIN_PAGE_NAMES);

describe('the gate is drawn at all, which is what nothing did before', () => {
  it('gives a consumer the panel instead of the page, on every admin path', () => {
    for (const path of ADMIN_PATHS) {
      const markup = route(path, 'consumer');
      expect(markup, `${path} draws the gate`).toContain(GATE_HEADING);
      expect(markup, `${path} withholds the page`).not.toContain('THE_ADMIN_PAGE');
    }
  });

  it('names the page the reader asked for, and only that page', () => {
    // The sentence is per route. A consumer who followed a link to Ops should
    // not be told about Monitoring, which is what one shared sentence would do.
    for (const [path, page] of Object.entries(ADMIN_PAGE_NAMES)) {
      expect(route(path, 'consumer')).toContain(gateLine(page));
    }
  });

  it('offers exactly one way out, to the page every reader can open', () => {
    const markup = route('/ops', 'consumer');
    expect(markup).toContain(GATE_ACTION);
    expect(markup).toMatch(/href="\/"/);
  });

  it('says nothing about who to ask', () => {
    // role.ts's rule, asserted where somebody would add the sentence. The app
    // does not know who administers the deployment being read, and a guess sends
    // people to the wrong person.
    const markup = route('/monitoring', 'consumer').toLowerCase();
    expect(markup).not.toContain('administrator to');
    expect(markup).not.toContain('contact');
    expect(markup).not.toContain('ask your');
  });

  it('gives an administrator the page and no panel', () => {
    for (const path of ADMIN_PATHS) {
      const markup = route(path, 'admin');
      expect(markup, `${path} draws the page`).toContain('THE_ADMIN_PAGE');
      expect(markup, `${path} draws no gate`).not.toContain(GATE_HEADING);
    }
  });

  it('gates a reader whose role could not be read', () => {
    // Fail closed, for the reason the navigation does: the server refuses the
    // data either way, so drawing the page would produce a screen of refusals
    // where a sentence belongs.
    expect(route('/ops', 'failed')).toContain(GATE_HEADING);
  });

  it('draws neither while the role is still resolving', () => {
    // Both alternatives are worse than a blank. The page would flash an admin
    // frame at a consumer and fire requests that 403; the panel would flash "not
    // available on your account" at an administrator. The badge in the header is
    // already saying an answer is coming.
    const markup = route('/monitoring', 'resolving');
    expect(markup).not.toContain(GATE_HEADING);
    expect(markup).not.toContain('THE_ADMIN_PAGE');
  });
});

describe('every admin route is wrapped, and the router is where that is decided', () => {
  it('wraps each path ADMIN_PAGE_NAMES knows about', () => {
    // The record and the router are different files, so a fourth admin page
    // added to one and not the other is a page served to everybody. Asserted
    // against the source because the router is built at module load.
    for (const path of ADMIN_PATHS) {
      const route = APP.match(new RegExp(`path: '${path}',[\\s\\S]*?errorElement:`));
      expect(route, `${path} is registered`).not.toBeNull();
      expect(route![0], `App.tsx gates ${path}`).toContain('<AdminOnly>');
    }
  });

  it('wraps nothing else, so a page nobody decided was admin cannot become one', () => {
    const wrapped = [...APP.matchAll(/path: '([^']+)',[\s\S]*?errorElement:/g)]
      .filter((match) => match[0].includes('<AdminOnly>'))
      .map((match) => match[1]);
    expect(wrapped.sort()).toEqual([...ADMIN_PATHS].sort());
  });
});

describe('losing the role mid-session is a different event from never having it', () => {
  it('moves a reader who held the role here, and gates one who never did', () => {
    // The transition is the whole of the distinction, and there is no browser in
    // this repository to drive a mounted component through one. So the decision
    // is a function and this is its truth table. The wrapper's only remaining
    // job is to remember whether it has drawn the page for this reader, which
    // the assertion below pins against the source.
    expect(gateOutcome('consumer', true)).toBe('move');
    expect(gateOutcome('failed', true)).toBe('move');
    expect(gateOutcome('consumer', false)).toBe('gate');
    expect(gateOutcome('failed', false)).toBe('gate');
  });

  it('never moves or gates somebody who still holds the role', () => {
    expect(gateOutcome('admin', true)).toBe('page');
    expect(gateOutcome('admin', false)).toBe('page');
  });

  it('waits rather than guessing while the role is unresolved', () => {
    expect(gateOutcome('resolving', false)).toBe('wait');
    expect(gateOutcome('resolving', true)).toBe('wait');
  });

  it('remembers an administrator it has already drawn the page for', () => {
    // The one half of the transition that lives in the component. Asserted
    // against the source because a static render mounts fresh every time and can
    // never observe the memory surviving a re-render.
    //
    // It is state adjusted during render, and was a ref written during render.
    // Both remember; only one of them is guaranteed to. A ref is not part of a
    // render's input, so a discarded render pass takes the write with it, and
    // this is exactly the case that would be silently forgotten. The regexes
    // below therefore pin the mechanism and not just the variable name: a
    // rewrite back to a ref has to come past this case.
    const source = readFileSync(new URL('GatePanel.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/\[heldRoleHere, setHeldRoleHere\]\s*=\s*useState\(false\)/);
    expect(source).toMatch(/if \(!heldRoleHere && showsAdminSurfaces\(role\.state\)\) setHeldRoleHere\(true\)/);
    expect(source).toMatch(/gateOutcome\(role\.state, heldRoleHere\)/);
    // And not the old mechanism, under any name.
    expect(source).not.toMatch(/useRef/);
  });

  it('carries a sentence naming the page that was taken away', () => {
    expect(roleLostSentence('Monitoring')).toBe(
      'Your access changed. Monitoring is no longer available on your account.'
    );
    expect(roleLostNotice({ roleLost: roleLostSentence('Ops') })).toBe(
      'Your access changed. Ops is no longer available on your account.'
    );
  });

  it('ignores anything else the location state happens to hold', () => {
    expect(roleLostNotice(null)).toBe('');
    expect(roleLostNotice({})).toBe('');
    expect(roleLostNotice({ roleLost: 7 })).toBe('');
    expect(roleLostNotice('Your access changed.')).toBe('');
  });

  it('says nothing on an ordinary arrival', () => {
    // The notice lives in the layout, which every page is drawn inside, so it
    // has to be silent on every navigation but the one that carries it.
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <RoleLostNotice />
      </MemoryRouter>
    );
    expect(markup).toBe('');
  });

  it('announces the move, because nobody asked for it', () => {
    // `alert` here and `status` on the panel, and the difference is deliberate.
    // The panel is the result of a navigation the reader made. This appears
    // under somebody who was reading a page a second ago.
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[{ pathname: '/', state: { roleLost: roleLostSentence('Ops') } }]}>
        <RoleLostNotice />
      </MemoryRouter>
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('no longer available on your account');
  });

  it('is drawn by the layout, so the move lands on it wherever it goes', () => {
    const layout = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('<RoleLostNotice />');
  });
});

describe('the panel says the same thing however it is reached', () => {
  it('is one component, so three pages cannot drift into three panels', () => {
    const direct = renderToStaticMarkup(
      <MemoryRouter>
        <GatePanel page="Ops" />
      </MemoryRouter>
    );
    expect(direct).toContain(GATE_HEADING);
    expect(direct).toContain(gateLine('Ops'));
    expect(direct).toContain(GATE_ACTION);
  });

  it('takes its words from role.ts rather than restating them', () => {
    // The words are decided in one place so they can be tested without a
    // browser, and so a page cannot quietly acquire its own wording.
    const source = readFileSync(new URL('GatePanel.tsx', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
    expect(source).not.toContain('Not available on your account');
    expect(source).not.toContain('Back to Ask');
    expect(source).not.toContain('is for deployment administrators');
  });
});
