/**
 * The Benchmark Lab toggle: the knob's geometry, and whether flipping it does
 * anything.
 *
 * REPORTED TWICE AS "STILL NOT FIXED", so it is treated here as two faults that
 * happen to share a control. One is arithmetic in settings.css and is settled
 * below. The other is whether the switch reflects and changes the preference at
 * all, which is the half that a stylesheet fix would have left broken while
 * looking fixed.
 *
 * WHAT CANNOT BE CHECKED HERE, PLAINLY. This suite runs in node with no DOM, so
 * nothing below presses the switch. What it does instead is pin every join the
 * press travels through: the control renders from the flag, the flag round-trips
 * through storage, and the navigation is computed from the same flag object the
 * page was handed. A click is the one link left, and it is one line in
 * SettingsPage.tsx.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

/**
 * WITH THE REVIEW FLAG OFF AND THE BENCHMARK LAB KILL SWITCH ON, because this
 * file's subject is the switch geometry on Settings, not the review posture.
 *
 * `SHOW_EVERY_TAB_TO_EVERYONE` and `BENCHMARK_LAB_ENABLED` both live in
 * `nav-reveal.ts`. Mocking them keeps the nav assertions below testing the kill
 * switch rather than the review flag standing in front of it.
 */
vi.mock('./nav-reveal', () => ({ SHOW_EVERY_TAB_TO_EVERYONE: false, BENCHMARK_LAB_ENABLED: true }));

import { NavLinks } from './Layout';
import { mobileNavLinkClass } from './layout-view';
import {
  NO_EXPERIMENTS,
  persistExperimentalFeatures,
  readExperimentalFeatures,
  type ExperimentalFeatures,
  type PreferenceStore,
} from './experimental-features';
import { navEntries, type RoleResolution } from './role';
import { partial } from './styles/stylesheet';

const SETTINGS = partial('settings.css');

function withoutComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** One rule's body from settings.css, by exact selector. */
function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return withoutComments(SETTINGS).match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`))?.[1] ?? '';
}

/** One pixel length from a rule, as a number. */
function px(body: string, property: string): number {
  const raw = body.match(new RegExp(`(?:^|[;{\\s])${property}:\\s*(-?\\d+(?:\\.\\d+)?)px`))?.[1];
  expect(raw, `${property} is declared in px`).toBeDefined();
  return Number.parseFloat(raw as string);
}

/** How far the checked rule slides the thumb, in px. */
function travel(body: string): number {
  const raw = body.match(/(?:^|[;{\s])translate:\s*(-?\d+(?:\.\d+)?)px/)?.[1];
  expect(raw, 'the checked state slides the thumb by a stated number of px').toBeDefined();
  return Number.parseFloat(raw as string);
}

const TRACK = rule(".settings-page [data-slot='switch']");
const THUMB = rule(".settings-page [data-slot='switch-thumb']");
const CHECKED = rule(".settings-page [data-slot='switch'][data-state='checked'] [data-slot='switch-thumb']");

/**
 * AppKit's switch is `border border-transparent`, for `focus-visible:border-ring`
 * to colour, and the app is `box-sizing: border-box` throughout. So one pixel of
 * the declared width and height is spent on each edge before any padding is. That
 * invisible border is the whole of the reported defect and it is why the numbers
 * below are not the ones a reader of settings.css would expect.
 */
const BORDER = 1;

describe('the knob fits the track it slides in', () => {
  it('travels exactly the room it has, rather than 2px further', () => {
    // The fault, as arithmetic. At `padding: 2px` the inner box was 34 - 2 - 4 =
    // 28px wide, so a 14px thumb had 14px of travel and was being moved 16 --
    // landing hard against the track's rounded right edge, which is what "clipped
    // at the edge" was.
    const inner = px(TRACK, 'width') - BORDER * 2 - px(TRACK, 'padding') * 2;
    expect(travel(CHECKED)).toBe(inner - px(THUMB, 'width'));
  });

  it('is no taller than the space it sits in', () => {
    // The other half of the same mistake, and the "mis-shapen when pressed" half:
    // a 14px thumb inside a 12px inner box overflows the track above and below,
    // so the round knob is drawn over the round track's own edge.
    const inner = px(TRACK, 'height') - BORDER * 2 - px(TRACK, 'padding') * 2;
    expect(px(THUMB, 'height')).toBeLessThanOrEqual(inner);
  });

  it('still leaves the 2px inset at both ends that the handoff asks for', () => {
    // Which is the reason the padding reads as 1px: the border supplies the other
    // one. Asserted so that "restore the handoff's 2px" cannot be done to the
    // padding alone, which is how this looked correct while being wrong.
    expect(px(TRACK, 'padding') + BORDER).toBe(2);
  });

  it('leaves nowhere for a second offset to hide, in either state', () => {
    // THE THIRD REPORT, AND THE REASON THE TWO ABOVE PASSED THROUGH IT. They
    // check the arithmetic of one declaration in this stylesheet and never ask
    // what else moves the same element. `translate` and `transform` are separate
    // properties and a browser applies both, so overriding one leaves the other
    // in force and the offsets ADD. AppKit's thumb carries a Tailwind
    // `translate-x-*` utility, which v4 compiles to `translate`, and this file
    // used to restate the offset as `transform: translateX(16px)` -- 12px + 16px
    // against 16px of travel, so the knob left the track and, white on a white
    // card, vanished. The blue smear Sam photographed was the empty track.
    //
    // Asserted as "both properties are pinned in both states" rather than as a
    // total, because a total can only be computed by reading a stylesheet in
    // node_modules that an upgrade is free to change. This holds whichever
    // property the upstream utility occupies.
    for (const [state, body] of [
      ['unchecked', THUMB],
      ['checked', CHECKED],
    ] as const) {
      expect(body, `the ${state} thumb pins translate`).toMatch(/(?:^|[;{\s])translate:/);
      expect(body, `the ${state} thumb pins transform`).toMatch(/(?:^|[;{\s])transform:/);
    }
    // And the resting state is at rest, so the 16px above is the travel and not
    // 16px added to wherever the off state had drifted to.
    expect(THUMB).toMatch(/translate:\s*0\s+0/);
    expect(THUMB).toMatch(/transform:\s*none/);
    expect(CHECKED).toMatch(/transform:\s*none/);
  });

  it('keeps the switch out of the flex squeeze beside a two-line explanation', () => {
    // `flex: none` is load-bearing rather than tidy: the row is a flex container
    // and the note beside it is allowed to wrap, so a shrinkable switch would be
    // compressed into an oval by a longer sentence.
    expect(TRACK).toMatch(/flex:\s*none/);
  });
});

describe('flipping it is wired to something', () => {
  // Spread rather than a literal, so the next experiment added to the set does
  // not fail this file for a reason that has nothing to do with the nav bar.
  const on: ExperimentalFeatures = { ...NO_EXPERIMENTS, benchmarkLab: true };
  const off: ExperimentalFeatures = { ...NO_EXPERIMENTS, benchmarkLab: false };

  function nav(features: ExperimentalFeatures) {
    const role: RoleResolution = { state: 'admin', addedAdminsReadable: true };
    return renderToStaticMarkup(
      <MemoryRouter>
        <NavLinks linkClass={mobileNavLinkClass} role={role} features={features} />
      </MemoryRouter>
    );
  }

  it('adds and removes the Benchmarking tab with the setting', () => {
    expect(nav(on)).toContain('/benchmarks');
    expect(nav(off)).not.toContain('/benchmarks');
  });

  it('uses the same setting for the navigation calculation', () => {
    expect(navEntries('admin', off).some((entry) => entry.to === '/benchmarks')).toBe(false);
    expect(navEntries('admin', on).some((entry) => entry.to === '/benchmarks')).toBe(true);
  });

  it('survives a reload, by writing what a later read recognises', () => {
    const written = new Map<string, string>();
    const store: PreferenceStore = {
      getItem: (key) => written.get(key) ?? null,
      setItem: (key, value) => void written.set(key, value),
    };
    expect(persistExperimentalFeatures(on, store)).toBe(true);
    expect(readExperimentalFeatures(store)).toEqual(on);
    persistExperimentalFeatures(off, store);
    expect(readExperimentalFeatures(store)).toEqual(off);
  });

  it('draws the Benchmarking switch in the Experimental table’s current order', () => {
    const source = readFileSync(new URL('SettingsPage.tsx', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/g,
      ' '
    );
    expect(source).toMatch(/showsBenchmarkLab/);
    expect(source).toMatch(/showsForecasting/);
    expect(source).toContain("withExperimentalFeature(current, 'benchmarkLab', enabled)");
    expect(source).toContain("withExperimentalFeature(current, 'forecasting', enabled)");
    expect(source).toContain("withExperimentalFeature(current, 'egressControls', enabled)");
    expect(source).toContain('setFeature(name, draftFeatures[name])');
    expect(source).not.toMatch(/setFeature\('spIdentities'/);
    expect(source).toMatch(/persistSpIdentityMode/);
    expect(source).toMatch(/loadSpIdentityAdmin/);
    expect(source).toMatch(/spIdentityEnabledFromPayload/);
    const rows = ['PII egress judge', 'SP identities', '<ResourceTagsPanel />', '>Forecasting<', 'Benchmarking'];
    const positions = rows.map((row) => source.indexOf(row));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(source.indexOf("'egressControls', enabled")).toBeLessThan(source.indexOf("'benchmarkLab', enabled"));
    expect(source.indexOf("'forecasting', enabled")).toBeLessThan(source.indexOf("'benchmarkLab', enabled"));
  });
});
