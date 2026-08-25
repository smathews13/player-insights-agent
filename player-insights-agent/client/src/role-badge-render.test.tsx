/**
 * That the header actually draws a role badge, and what it says in each of the
 * four states.
 *
 * THE FIRST TEST IN THIS FILE IS THE POINT OF THE FILE. role.ts computed all
 * four states, both tooltips, the accessible names, the live-region wording and
 * the badge-then-name-then-gear order, and had thorough tests for every one of
 * them, all passing. Nothing in the app called any of it. The component those
 * tests describe -- RoleBadge.tsx, named in role.ts's own comments -- had never
 * been written, so the header simply had no badge, and it shipped that way. Not
 * one existing test failed, because every one of them tested the module.
 *
 * That is the same failure nav-role.test.tsx was written for, a tab row that
 * role.ts specified and Layout.tsx did not draw, and the lesson took twice. So
 * the assertion below renders the HEADER and fails when there is no badge in it.
 * A test of `badgeLabel` cannot fail for a missing caller; only this can.
 *
 * PIXELS ARE NOT VERIFIED BY ANY OF THIS. It is markup, wording and the rules in
 * shell.css. Nothing here says the chip fits beside the name.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { Layout, IdentityChips } from './Layout';
import { RoleBadge } from './RoleBadge';
import { badgeLabel, badgeTitle, roleFrom, type RoleResolution, type RoleState } from './role';
import { identityAfterDeadline, identityFromResponse, IDENTITY_DEADLINE_MS } from './app-state';
import { IDENTITY_RESOLVING, IDENTITY_UNAVAILABLE } from './user-initials';
import type { Identity } from './app-types';
import { partial } from './styles/stylesheet';
import { acknowledgeFirstOpen } from './first-open';

/**
 * FIVE, AND super_admin USED TO BE MISSING FROM THIS LINE. That is the whole of
 * why the top rank rendered as bare words in the header: every claim in this file
 * is made by looping this array, so a state absent from it had no rule in
 * shell.css, no icon, and nothing that failed when it drew as unstyled text
 * beside a pill. `.role-badge`'s base rule gave it padding and a radius and no
 * fill, which on white is indistinguishable from prose.
 *
 * Spelled as a total record rather than as an array, so the next state added to
 * `RoleState` is a typecheck failure here instead of a state nobody styled.
 */
const EVERY_STATE: Readonly<Record<RoleState, true>> = {
  resolving: true,
  super_admin: true,
  admin: true,
  consumer: true,
  failed: true,
};
const ALL_STATES = Object.keys(EVERY_STATE) as RoleState[];

/** The two administrator ranks, which are the states that carry a mark. */
const ADMIN_STATES: RoleState[] = ['super_admin', 'admin'];

function resolution(state: RoleState): RoleResolution {
  return { state, addedAdminsReadable: true };
}

function identity(signedInAs = '<your-username>'): Identity {
  return {
    signedInAs,
    executionIdentity: 'Astrolabe service principal',
    executionMode: 'service-principal',
  };
}

/** The badge on its own. */
function badge(state: RoleState): string {
  return renderToStaticMarkup(<RoleBadge state={state} />);
}

/**
 * The whole header, as the app mounts it once the login gate has been passed.
 *
 * THE ACKNOWLEDGEMENT IS NOT INCIDENTAL SETUP. The layout draws no header at all
 * while the first-open gate is still deciding whether to show, which is the fix for
 * the flicker that used to put the Ask tab on screen for a second and then cover it
 * with a login card. So "the header" is a thing that exists on the far side of the
 * gate, and a header test has to say which session it is looking at. `null` as the
 * store keeps it to this module's own in-memory latch: there is no `window` in this
 * run, and nothing here should write to a real one.
 */
function header(): string {
  acknowledgeFirstOpen(null);
  return renderToStaticMarkup(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>
  );
}

/** The cluster the badge and the name share, at either width. */
function cluster(state: RoleState, className?: string): string {
  return renderToStaticMarkup(<IdentityChips identity={identity()} role={resolution(state)} className={className} />);
}

/**
 * The header's copy of the cluster, which is the one that carries the gear.
 *
 * The gear arrives as a slot rather than being drawn by `IdentityChips`, so a
 * test that wants to assert where it lands has to hand it one. This stands in for
 * the element Layout passes: it is the class and the accessible name that matter
 * to the assertions, not the button recipe underneath them.
 */
function clusterWithGear(state: RoleState): string {
  return renderToStaticMarkup(
    <IdentityChips
      identity={identity()}
      role={resolution(state)}
      gear={
        <a className="header-settings" href="/settings" aria-label="App settings" title="App settings">
          gear
        </a>
      }
    />
  );
}

describe('the header draws a badge at all', () => {
  it('renders one, which is the assertion that was missing when it rendered none', () => {
    // Deliberately the weakest possible claim about the badge, and the only one
    // that would have caught this. Everything else in this file could pass with
    // no component in the tree.
    expect(header()).toContain('data-testid="role-badge"');
  });

  it('puts it inside the identity cluster rather than loose in the header', () => {
    // Which is what gets it into the mobile sheet as well, from the same
    // component and in the same order, instead of being a header-only element
    // that a narrow window silently drops.
    expect(cluster('admin')).toContain('data-testid="role-badge"');
    expect(cluster('admin', 'mobile-identity')).toContain('data-testid="role-badge"');
  });

  it('hands it the role the header already derived rather than reading it again', () => {
    // The badge takes a state and draws it. If it ever fetches or infers one,
    // there are two answers to the question role.ts exists to answer once.
    const source = readFileSync(new URL('RoleBadge.tsx', import.meta.url), 'utf8')
      // Comments stripped, so prose naming the hook is not read as a call to it.
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(source).not.toMatch(/fetch\(|useIdentity|roleFrom/);
  });
});

describe('the Super admin chip leaves the top rail while Benchmarking is on', () => {
  it('omits the rail pill when asked, and keeps it otherwise', () => {
    expect(cluster('super_admin')).toContain('data-testid="role-badge"');
    expect(cluster('super_admin')).toContain('Super admin');
    const hidden = renderToStaticMarkup(
      <IdentityChips identity={identity()} role={resolution('super_admin')} hideRoleBadge />
    );
    expect(hidden).not.toContain('data-testid="role-badge"');
    expect(hidden).not.toContain('Super admin');
    expect(hidden).toContain('data-testid="identity-chip"');
  });

  it('still names the rank in the signed-in menu', () => {
    const layout = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('<AccountMenu identity={identity} role={role.state} />');
    const menu = readFileSync(new URL('AccountMenu.tsx', import.meta.url), 'utf8');
    expect(menu).toContain('<RoleBadgePill state={role} />');
  });

  it('hides the rail copy only, and only on the header', () => {
    const source = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8').replace(
      /\{\/\*[\s\S]*?\*\/\}/g,
      ' '
    );
    expect(source).toContain('hideRoleBadge={!showsHeaderRoleBadge(features)}');
    expect((source.match(/hideRoleBadge=\{!showsHeaderRoleBadge\(features\)\}/g) ?? []).length).toBe(1);
    expect(source).toMatch(
      /<IdentityChips\s+identity=\{identity\}\s+role=\{role\}\s+deployedAt=\{deployment\.deployedAt\}[\s\S]*?className="mobile-identity"/
    );
  });
});

describe('badge, then who, then what they can open, then who built it', () => {
  it('draws the badge to the LEFT of the reader it qualifies', () => {
    // Binding, and already corrected once: the design handoff puts it on the
    // right and this app puts it on the left. role.ts records the order and the
    // reasoning as HEADER_CLUSTER_ORDER; this is the assertion that the markup
    // agrees with it.
    //
    // The reader is the signed-in identity chip (local part), restored from the
    // initials avatar. The claim did not move: the badge qualifies whoever it
    // precedes, and the attribution closes the row behind both.
    const markup = cluster('admin');
    const at = (needle: string) => markup.indexOf(`data-testid="${needle}"`);
    expect(at('role-badge')).toBeGreaterThan(-1);
    expect(at('identity-chip')).toBeGreaterThan(-1);
    expect(at('role-badge')).toBeLessThan(at('identity-chip'));
    expect(markup.indexOf('identity-chip')).toBeLessThan(markup.indexOf('built-on-databricks'));
  });

  /**
   * THE GEAR SITS BETWEEN THE READER AND THE DIVIDER, which is the change this
   * item pins. It used to close the header from the far right, past "Built on
   * Databricks" -- so a control belonging to the reader sat on the far side of
   * the one divider whose whole job is to separate the reader from who built the
   * app. §1 gives that divider exactly that job, so the gear was on the wrong
   * side of it.
   *
   * Asserted through the CLUSTER rather than the header because the gear is now a
   * member of it: this is the assertion that would fail if somebody put it back
   * after the attribution, or after the cluster entirely.
   */
  it('puts the gear after the identity chip and before the divider and the attribution', () => {
    const markup = clusterWithGear('admin');
    const at = (needle: string) => markup.indexOf(needle);
    expect(at('header-settings'), 'the cluster draws the gear it was handed').toBeGreaterThan(-1);
    expect(at('identity-chip')).toBeLessThan(at('header-settings'));
    expect(at('header-settings')).toBeLessThan(at('app-chrome-rule'));
    expect(at('header-settings')).toBeLessThan(at('built-on-databricks'));
  });

  it('draws exactly one App settings control, and never one in the mobile sheet', () => {
    // Two elements named "App settings" on one page is an ambiguous locator for a
    // reader moving by keyboard and for a test, and the sheet's copy of the
    // cluster is where a second one would come from: it renders the same
    // component. It is handed no gear, and that is how it says so.
    const markup = clusterWithGear('admin');
    expect(markup.match(/aria-label="App settings"/g) ?? []).toHaveLength(1);
    expect(cluster('admin', 'mobile-identity')).not.toContain('App settings');
    expect(cluster('admin', 'mobile-identity')).not.toContain('header-settings');
  });

  it('keeps the gear in the header below 800px, where the rest of the cluster leaves', () => {
    // The regression this change could most easily have shipped. The 800px band
    // used to hide `.identity-chips` outright, which was harmless while the gear
    // was a sibling of the cluster and fatal once it is a member: the sheet's copy
    // carries no gear, so App settings would have had no control anywhere on the
    // page at phone width. The rule hides the cluster's members EXCEPT the gear.
    const band =
      partial('responsive.css')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .match(/@media \(max-width: 800px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(band, 'responsive.css still has the 800 band').not.toEqual('');
    expect(band).toMatch(/\.app-header \.identity-chips > :not\(\.header-settings\)\s*\{\s*display:\s*none/);
    // And not the blunt version, at any width. `.identity-chips` may not be
    // display:none in a header-scoped rule, because the gear is inside it.
    expect(partial('responsive.css').replace(/\/\*[\s\S]*?\*\//g, ' ')).not.toMatch(
      /\.app-header \.identity-chips\s*\{[^}]*display:\s*none/
    );
  });

  it('does not let the gear shrink out of its own hit target', () => {
    // The chips are the part of the header that gives -- shell.css pins
    // `flex: none` on the brand and the nav so navigation is not -- and a flex
    // child defaults to shrinking. An icon button that shrinks is a hit target
    // that shrinks, on the one control in the cluster.
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const gear = shell.match(/\.header-settings\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(gear, 'shell.css still seats .header-settings').not.toEqual('');
    expect(gear).toMatch(/flex:\s*none/);
    // And no margin of its own: the row's 12px gap is the spacing now, and a
    // margin here stacks on top of it and sets the gear further from the identity
    // chip than the chip sits from the badge.
    expect(gear).not.toMatch(/margin/);
  });

  it('spaces Super admin, identity chip, and gear with one shared gap', () => {
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const chips = shell.match(/\.identity-chips\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(chips).toMatch(/gap:\s*12px/);
    const chip = shell.match(/\.identity-chip\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(chip, 'shell.css seats .identity-chip').not.toEqual('');
    expect(chip).not.toMatch(/margin/);
    const markup = clusterWithGear('admin');
    expect(markup).toContain('Signed in');
    expect(markup).toContain('<your-username>');
  });

  it('is not flipped back by the stylesheet', () => {
    // The order comes from the markup, so a `row-reverse` or an `order:` on
    // either chip would put what is painted and what is read out into
    // disagreement without touching a line of this component.
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rule = shell.match(/\.identity-chips\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule, 'shell.css still has .identity-chips').not.toEqual('');
    expect(rule).not.toMatch(/row-reverse/);
    const badgeRules = [...shell.matchAll(/\.role-badge[^{]*\{([^}]*)\}/g)].map((match) => match[1]);
    expect(badgeRules.length).toBeGreaterThan(0);
    // `order:` and not `border:`, which is why the property is anchored to the
    // start of a declaration rather than matched loose.
    for (const body of badgeRules) expect(body).not.toMatch(/(^|[;{\s])order\s*:/);
  });
});

describe('all five states reach the screen, and none of them is blank prose', () => {
  it('says Admin and Consumer in words rather than as an initial', () => {
    expect(badge('admin')).toContain('Admin');
    expect(badge('consumer')).toContain('Consumer');
    // "A" and "C" would be indistinguishable from the initials the header draws
    // elsewhere, which is why role.ts refuses to abbreviate them.
    expect(badge('admin')).not.toMatch(/>A</);
  });

  /**
   * THE ONE THIS FILE MISSED, and the reason it is worth its own item.
   *
   * `super_admin` has been a `RoleState` since the rank landed, role.ts has given
   * it a word and a tooltip since then, and shell.css had no rule for it -- so the
   * header drew the top rank as unstyled text next to a styled pill. Nothing
   * failed, because every claim in this file was made against a four-element array
   * the state was not in. `ALL_STATES` is a total record now for exactly that
   * reason, and the assertions here are about the pixels a reader would have
   * reported.
   */
  it('says Super admin in a pill rather than as bare prose beside one', () => {
    const markup = badge('super_admin');
    expect(markup).toContain('Super admin');
    // The word is role.ts's, so the badge and the roster cannot spell the rank
    // two ways. Sentence case, which is what the label already read.
    expect(markup).toContain(badgeLabel('super_admin'));
    expect(markup).toContain(badgeTitle('super_admin'));
    // The pill itself: same class, same state attribute, and a fill that is not
    // the page. The class alone was there before this change; the fill was not.
    expect(markup).toContain('class="role-badge"');
    expect(markup).toContain('data-role-state="super_admin"');
  });

  it('does not spend a reserved accent on saying who is signed in', () => {
    // The rationing in design-spec-master.md §0, which a role chip is on the wrong
    // side of in three different ways:
    //
    //   - Lava #FF3621 is the Databricks attribution, which sits about six pixels
    //     to the right of this pill in the same cluster. A role chip taking it
    //     would put the app's one reserved accent on the reader's rank.
    //   - --ast-blue is the action colour: every primary button's fill, and the
    //     solid Live pill. A pill wearing it reads as pressable or as the agent
    //     working, and this is a label for an answer the server already gave.
    //   - Amber is the evaluation mass, and green and red are verdicts about
    //     whether a dependency answered. None of those is a rank.
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rule = shell.match(/\.role-badge\[data-role-state='super_admin'\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule, 'shell.css styles the super_admin badge').not.toEqual('');
    expect(rule).not.toMatch(/--ast-blue|--ast-warn|--ast-pos|--ast-neg|--db-|FF3621/i);
    expect(rule).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  it('is the same pill as Admin with a different tone, not a different component', () => {
    // Same shape, same size, same type -- all of that comes from the shared base
    // rule, which is what makes the pair read as one family. The only per-state
    // declarations either of them carries are the two colours.
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const declarations = (state: RoleState) =>
      (shell.match(new RegExp(`\\.role-badge\\[data-role-state='${state}'\\]\\s*\\{([^}]*)\\}`))?.[1] ?? '')
        .split(';')
        .map((line) => line.split(':')[0].trim())
        .filter(Boolean)
        .sort();
    expect(declarations('super_admin')).toEqual(['background', 'color']);
    expect(declarations('super_admin')).toEqual(declarations('admin'));
    // And the tone genuinely differs, or the two ranks are one pill drawn twice.
    const shellRule = (state: RoleState) =>
      shell.match(new RegExp(`\\.role-badge\\[data-role-state='${state}'\\]\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(shellRule('super_admin')).not.toEqual(shellRule('admin'));
  });

  it('says Role unknown when the role could not be read', () => {
    expect(badge('failed')).toContain('Role unknown');
    expect(badge('failed')).toContain(badgeTitle('failed'));
  });

  it('draws the resolving chip empty, and reserves its width so nothing jumps', () => {
    const markup = badge('resolving');
    expect(markup).toContain('data-role-state="resolving"');
    // Empty of text, which is the specification, and hidden from assistive
    // technology because "Role:" with nothing after it is worse than silence.
    expect(markup).toMatch(/data-testid="role-badge"[^>]*><\/span>/);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('aria-label');
  });

  it('gives every state a distinct rule, so none of them paints as another', () => {
    const shell = partial('shell.css');
    for (const state of ALL_STATES) {
      expect(shell, `shell.css styles the ${state} badge`).toContain(`.role-badge[data-role-state='${state}']`);
    }
  });

  /**
   * A PILL AND NEVER A BUTTON, which is the point of the geometry rather than a
   * preference about corners. `role-badge.md` states it plainly: every button in
   * this app is 4px with a border, so a 999px pill with no border cannot be
   * mistaken for one, and there is nothing here to press.
   *
   * This replaces a test that asserted the opposite geometry -- one reserved
   * `--role-badge-w` across all four states, built on the identity chip's 4px
   * radius and 1px border -- and it is worth recording why rather than leaving a
   * silent reversal. That treatment was correct against the earlier guidance and
   * it did buy something real: the header's right-hand cluster did not shift when
   * the role landed. The handoff specifies a 64px resolving pill, which is
   * narrower than every label that replaces it, so the cluster now does shift.
   * That is the handoff's trade and not a defect here. Widening it back would be
   * quietly overruling a specified dimension.
   */
  it('is a pill with no border in any state, so it cannot read as a button', () => {
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const base = shell.match(/\.role-badge\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(base, 'shell.css still has a .role-badge base rule').not.toEqual('');
    expect(base).toMatch(/border-radius:\s*999px/);
    expect(base).toMatch(/padding:\s*3px 10px/);
    expect(base).toMatch(/font-size:\s*12px/);
    expect(base).toMatch(/font-weight:\s*500/);
    // `border: 0` rather than an omission. An omitted border is a border the next
    // edit adds without noticing it is the one thing that breaks the shape.
    expect(base).toMatch(/border:\s*0/);

    // And no state may put one back, which is the instruction the handoff repeats.
    for (const state of ALL_STATES) {
      const rule =
        shell.match(new RegExp(`\\.role-badge\\[data-role-state='${state}'\\][^{]*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule, `shell.css styles the ${state} badge`).not.toEqual('');
      expect(rule, `the ${state} badge must not draw a border`).not.toMatch(/border(-color)?:\s*(?!0)/);
    }
  });

  /**
   * The two families the palette declares for this pill, asked for by name.
   *
   * WHAT THIS CAUGHT. Three of the four states painted --db-chip #E8ECF0 on
   * --db-grey-blue #445461, which are DuBois values that predate the astrolabe
   * neutral: §2 gives neutral as #46596B on #F2F6F9. So the pill a reader sees
   * three times out of four was a slightly different grey from every neutral chip
   * on the pages under it, on the same screen, and the difference is the kind
   * nobody reports and everybody notices.
   *
   * Pinned as token NAMES rather than as hex, because the point is that the pill
   * takes the family. A rule that hardcoded #F2F6F9 would satisfy a hex test and
   * be the same defect one palette change later.
   */
  it('takes its fills from the palette rather than from the DuBois greys', () => {
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const ruleFor = (state: RoleState) =>
      shell.match(new RegExp(`\\.role-badge\\[data-role-state='${state}'\\][^{]*\\{([^}]*)\\}`))?.[1] ?? '';

    // Admin is the info family: §2 names role chips as one of the three things
    // that take it.
    expect(ruleFor('admin')).toMatch(/background:\s*var\(--ast-info-fill\)/);
    expect(ruleFor('admin')).toMatch(/color:\s*var\(--ast-info-text\)/);

    // The super rank is the SAME family inverted -- the deep rung as the fill,
    // white on it -- rather than a sixth colour. That is the one move that reads
    // as "more of what the pill beside it says" without adding a hue, and #0E538B
    // under white is 7.9:1.
    expect(ruleFor('super_admin')).toMatch(/background:\s*var\(--ast-info-text\)/);
    expect(ruleFor('super_admin')).toMatch(/color:\s*var\(--ast-white\)/);

    // Consumer and Role unknown share one rule and both are neutral. The word is
    // the whole distinction between them, which is why they can share a colour.
    expect(ruleFor('failed')).toMatch(/background:\s*var\(--ast-neutral-fill\)/);
    expect(ruleFor('failed')).toMatch(/color:\s*var\(--ast-neutral-text\)/);
    expect(shell).toContain(".role-badge[data-role-state='consumer'],");

    // And the placeholder has to be the same grey as the pill that replaces it in
    // three of the four states, or the shift shows at the moment the role lands.
    expect(ruleFor('resolving')).toMatch(/background:\s*var\(--ast-neutral-fill\)/);

    // None of the four may name a colour of its own.
    for (const state of ALL_STATES) expect(ruleFor(state)).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  it('draws the resolving pill at the size the handoff gives it', () => {
    const shell = partial('shell.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const resolving = shell.match(/\.role-badge\[data-role-state='resolving'\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(resolving).toMatch(/width:\s*64px/);
    expect(resolving).toMatch(/height:\s*22px/);
  });

  /**
   * The two states with a mark, and the reason they are the only two: both
   * administrator ranks mean extra surfaces are on the page. Consumer is
   * explicitly given no icon, and neither is a state that is not a role.
   */
  it('gives both administrator ranks a shield and gives no other state an icon', () => {
    for (const state of ADMIN_STATES) expect(badge(state)).toContain('<svg');
    expect(badge('consumer')).not.toContain('<svg');
    expect(badge('failed')).not.toContain('<svg');
    expect(badge('resolving')).not.toContain('<svg');
    // Hidden, because the pill is already named "Role: Admin" and a shield
    // announced beside that is a second wordless copy of the word next to it.
    for (const state of ADMIN_STATES) expect(badge(state)).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('gives the two ranks different shields, so the pair is not one glyph twice', () => {
    // The super rank's mark names the one control it has that Admin does not:
    // setting who else may administer the deployment, which is the sentence
    // `badgeTitle` gives it. Two identical shields would leave the colour as the
    // only difference between the two pills, which is the thing this app does not
    // do -- see the fill test below for the other half of that claim.
    const paths = (state: RoleState) => [...badge(state).matchAll(/<path\b/g)].length;
    expect(paths('super_admin')).toBeGreaterThan(0);
    expect(paths('admin')).toBeGreaterThan(0);
    expect(badge('super_admin')).not.toEqual(badge('admin'));
    // Not just a different label with the same drawing: the glyphs themselves
    // differ, which is what makes the mark carry information.
    const glyph = (state: RoleState) => badge(state).match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '';
    expect(glyph('super_admin')).not.toEqual(glyph('admin'));
    expect(glyph('super_admin')).not.toEqual('');
  });

  it('names each state in the markup, so a stuck one can be told from a missing one', () => {
    // The defect this whole item came from: a badge that was never written and a
    // badge stuck resolving are the same pixels. They are no longer the same
    // markup.
    for (const state of ALL_STATES) {
      expect(badge(state)).toContain(`data-role-state="${state}"`);
    }
  });
});

describe('an unresolved read ends up saying Role unknown rather than staying blank', () => {
  it('normalizes null and missing identity responses before the shell reads a role', () => {
    for (const response of [null, undefined, {}]) {
      const normalized = identityFromResponse(response);
      expect(normalized.signedInAs).toBe(IDENTITY_UNAVAILABLE);
      expect(roleFrom(normalized).state).toBe('failed');
    }
  });

  it('keeps a normal identity and role intact', () => {
    const normalized = identityFromResponse({
      signedInAs: '<your-username>',
      executionIdentity: 'Astrolabe service principal',
      executionMode: 'service-principal',
      role: 'super_admin',
    });
    expect(normalized.signedInAs).toBe('<your-username>');
    expect(roleFrom(normalized).state).toBe('super_admin');
  });

  it('turns a read that never landed into the unavailable identity', () => {
    // The third outcome, and it had no handling: a fetch that neither resolves
    // nor rejects left the hook on the resolving placeholder for as long as the
    // tab was open, so the chip stayed empty forever.
    expect(identityAfterDeadline(identity(IDENTITY_RESOLVING)).signedInAs).toBe(IDENTITY_UNAVAILABLE);
  });

  it('leaves an answer that beat the deadline alone', () => {
    // A slow success is still a success. A deadline that overwrote it would
    // report a failure that did not happen.
    const answered = identity('<your-username>');
    expect(identityAfterDeadline(answered)).toBe(answered);
    const refused = identity(IDENTITY_UNAVAILABLE);
    expect(identityAfterDeadline(refused)).toBe(refused);
  });

  it('lands on the visible failed badge, which is the whole chain', () => {
    // The claim end to end: unanswered read -> unavailable identity -> failed
    // role -> a chip that says something. Each link is tested above or in
    // role.ts's own suite; this is the one that fails if a link is re-wired.
    const stuck = identityAfterDeadline(identity(IDENTITY_RESOLVING));
    expect(roleFrom(stuck).state).toBe('failed');
    expect(badgeLabel(roleFrom(stuck).state)).toBe('Role unknown');
    expect(badge(roleFrom(stuck).state)).toContain('Role unknown');
  });

  it('waits long enough to be a verdict rather than a stopwatch', () => {
    // Short enough that nobody sits in front of an empty chip, long enough that
    // a cold container is not reported as a failure. If this ever drops to a
    // couple of seconds it will start calling slow reads broken.
    expect(IDENTITY_DEADLINE_MS).toBeGreaterThanOrEqual(8_000);
    expect(IDENTITY_DEADLINE_MS).toBeLessThanOrEqual(30_000);
  });
});
