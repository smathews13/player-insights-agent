/**
 * What `SHOW_EVERY_TAB_TO_EVERYONE` actually changes, and what it deliberately
 * does not.
 *
 * The flag was asked for so the whole app could be reviewed without swapping
 * accounts to see half of it. It is a review posture, so the two things worth
 * pinning are that it reveals everything it was meant to, and that it reveals
 * NOTHING ELSE -- in particular that it is navigation only, and that the guard
 * in front of the admin routes is untouched.
 *
 * Read against `nav-role.test.tsx`, which mocks this module to false and asserts
 * the role logic the app returns to when the flag goes back off. Between them
 * both positions of the flag are exercised, which is what makes it one line to
 * reverse rather than one line to reverse and a test run to find out.
 *
 * THIS FILE USES THE REAL VALUE. If the flag is turned off and these tests are
 * left in place they will fail, loudly, naming the flag -- which is the correct
 * outcome: it is the reminder to delete this file, not a reason to soften it.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { NavLinks } from './Layout';
import {
  navEntries,
  showsHeaderRoleBadge,
  showsSettingsGear,
  ADMIN_PAGE_NAMES,
  type RoleResolution,
  type RoleState,
} from './role';
import { NO_EXPERIMENTS } from './experimental-features';
import { BENCHMARK_LAB_ENABLED, SHOW_EVERY_TAB_TO_EVERYONE } from './nav-reveal';

const APP_SOURCE = readFileSync(new URL('App.tsx', import.meta.url), 'utf8');
const BENCHMARK_VISIBILITY_SOURCE = readFileSync(new URL('BenchmarkingVisibility.tsx', import.meta.url), 'utf8');

function resolution(state: RoleState): RoleResolution {
  return { state, addedAdminsReadable: true };
}

function render(state: RoleState): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NavLinks linkClass={() => 'app-nav-tab'} role={resolution(state)} features={NO_EXPERIMENTS} />
    </MemoryRouter>
  );
}

/** The labels, in the order they are drawn. */
function labels(markup: string): string[] {
  return [...markup.matchAll(/<\/svg>\s*([^<]+?)\s*<\/(?:a|button)>/g)].map((match) => match[1].trim());
}

const EVERY_TAB = ['Ask', 'Run Explorer', 'Monitoring', 'Ops', 'Connections', 'Architecture'];

const CONSUMER_TABS = ['Ask', 'Run Explorer', 'Connections', 'Architecture'];

describe('the review flag is off', () => {
  it('is off, which every assertion below depends on', () => {
    expect(SHOW_EVERY_TAB_TO_EVERYONE).toBe(false);
  });
});

describe('each reader is shown only their own tabs', () => {
  it('hides Monitoring and Ops from a consumer', () => {
    expect(labels(render('consumer'))).toEqual(CONSUMER_TABS);
  });

  it('shows an administrator every tab', () => {
    expect(labels(render('admin'))).toEqual(EVERY_TAB);
  });

  it('hides the admin tabs from a reader whose role could not be read', () => {
    expect(labels(render('failed'))).toEqual(CONSUMER_TABS);
  });

  it('still opens the gear for a consumer, for Appearance only', () => {
    expect(showsSettingsGear('consumer')).toBe(true);
  });
});

describe('Benchmarking follows the operator setting', () => {
  it('allows the operator setting to reveal the surface', () => {
    expect(BENCHMARK_LAB_ENABLED).toBe(true);
  });

  it('is hidden by default for every role', () => {
    for (const state of ['consumer', 'admin', 'super_admin', 'failed', 'resolving'] as const) {
      const entries = navEntries(state, NO_EXPERIMENTS).map((entry) => entry.to);
      expect(entries, state).not.toContain('/benchmarks');
      expect(labels(render(state)), state).not.toContain('Benchmarking');
    }
  });

  it('appears when the operator turns the setting on', () => {
    const withToggle = navEntries('admin', { ...NO_EXPERIMENTS, benchmarkLab: true });
    expect(withToggle.some((entry) => entry.to === '/benchmarks')).toBe(true);
  });

  it('hides the top-rail rank chip only while that tab is visible', () => {
    expect(showsHeaderRoleBadge(NO_EXPERIMENTS, 'admin')).toBe(true);
    expect(showsHeaderRoleBadge({ ...NO_EXPERIMENTS, benchmarkLab: true }, 'admin')).toBe(false);
  });

  it('gates a direct Benchmarking URL with the same live setting', () => {
    expect(APP_SOURCE).toMatch(/path: '\/benchmarks'/);
    expect(APP_SOURCE).toMatch(/<BenchmarkingVisibility>/);
    expect(BENCHMARK_VISIBILITY_SOURCE).toMatch(/BENCHMARK_LAB_ENABLED/);
    expect(BENCHMARK_VISIBILITY_SOURCE).toMatch(/showsBenchmarkLab\(features\)/);
    expect(BENCHMARK_VISIBILITY_SOURCE).toMatch(/<Navigate to="\/" replace \/>/);
  });
});

describe('nothing about permission has moved', () => {
  it('leaves every admin route wrapped in the gate, so a consumer meets a sentence and not a page', () => {
    // A consumer who follows a pasted admin link gets "Not available on your
    // account" rather than a page of requests the server refuses.
    for (const path of Object.keys(ADMIN_PAGE_NAMES)) {
      const route = APP_SOURCE.match(new RegExp(`path: '${path}',[\\s\\S]*?errorElement:`));

      expect(route, `${path} is no longer registered in App.tsx`).not.toBeNull();
      expect(route![0], `${path} is no longer wrapped in AdminOnly`).toContain('<AdminOnly>');
    }
  });

  it('is client-side only, and names nothing the server reads', () => {
    const flag = readFileSync(new URL('nav-reveal.ts', import.meta.url), 'utf8');
    const code = flag.replace(/\/\*[\s\S]*?\*\//g, ' ');

    // Kept out of `shared/` deliberately, and importing nothing from it: the
    // server must not agree with this one, which is the opposite of
    // ACCESS_GATE_ENABLED. A dependency either way would be the first step
    // towards it being read as permission, which it is not.
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).toContain('SHOW_EVERY_TAB_TO_EVERYONE');
    expect(code).toContain('BENCHMARK_LAB_ENABLED');
  });
});
