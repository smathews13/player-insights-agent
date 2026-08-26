import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ENTITY_STYLES } from '../../shared/runtime-settings';
import { partial, stylesheet } from './styles/stylesheet';

const DARK = partial('dark-mode.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const ALL_CSS = stylesheet().replace(/\/\*[\s\S]*?\*\//g, ' ');
const TOKENS = partial('tokens.css');
const ASTROLABE = partial('astrolabe-tokens.css');
const SETTINGS = partial('settings.css');
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** One selector's declaration block, including when it shares a grouped rule. */
function bodyFor(css: string, selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').some((candidate) => candidate.trim() === selector)) return match[2];
  }
  return '';
}

describe('the opaque stand-in matches the surface it stands in for', () => {
  /**
   * `--ast-surface-solid` is what the drawers and menus paint always, and what
   * EVERY surface paints under
   * `prefers-reduced-transparency`. It was #1B2836 against a #11171C sky:
   * lighter and much bluer than the page, so it did not read as the same
   * surface unfrosted. It read as a solid blue slab, and it was reported three
   * times as three different bugs -- the top rail, the settings menu, and the
   * white tiles in Run process. One token was behind all three.
   */
  it('is the translucent surface composited onto the sky, not a lighter blue', () => {
    const solid = ASTROLABE.match(/--ast-surface-solid:\s*(#[0-9a-f]{6})/i)?.[1];
    const navy = ASTROLABE.match(/--ast-navy:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(solid, 'the fallback surface is declared').toBeDefined();
    expect(navy, 'the sky is declared').toBeDefined();

    const channels = (hex: string) =>
      [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    // The frosted surfaces are rgba(255, 255, 255, 0.03) over the sky.
    const expected = channels(navy!).map((channel) => Math.round(channel * 0.97 + 255 * 0.03));

    channels(solid!).forEach((channel, index) => {
      expect(Math.abs(channel - expected[index]), `channel ${index} of ${solid}`).toBeLessThanOrEqual(1);
    });
  });

  it('does not tint blue away from the sky it sits on', () => {
    const solid = ASTROLABE.match(/--ast-surface-solid:\s*(#[0-9a-f]{6})/i)?.[1] ?? '';
    const [red, , blue] = [1, 3, 5].map((at) => Number.parseInt(solid.slice(at, at + 2), 16));
    // #1B2836 carried 27 points of blue over red. A neutral lift carries a few.
    expect(blue - red, `${solid} is close to neutral`).toBeLessThanOrEqual(12);
  });
});

describe('dark mode covers the shipped surfaces', () => {
  it('names the real shell, data, overlay, and gate selectors', () => {
    for (const selector of [
      '.app-header',
      '.conversation-rail',
      '.composer',
      '.trace-inspector',
      '.trace-empty-mark',
      '.ask-layout',
      '.ast-sky',
      '.answer-card',
      '.monitoring-tile',
      '.monitoring-filters .monitoring-search input',
      '.monitoring-list-pane',
      '.ops-block',
      '.monitoring-drawer',
      '.monitoring-question-modal',
      '.arch-flow',
      '.arch-tiles:not(.arch-tiles-loop) li',
      '.arch-node',
      '.account-menu',
      '.settings-page.settings-modal',
      '.settings-rail button.active',
      '.appearance-grid',
      '.access-gate-panel',
      '.live-steps',
      '.live-step',
      '.eval-steps',
      "[data-slot='card']",
      "[data-slot='sheet-content']",
    ]) {
      expect(DARK, `${selector} has no dark treatment`).toContain(selector);
    }
    expect(source('ArchitecturePage.tsx')).toMatch(
      /className=\{selected \? 'arch-node arch-node-selected' : 'arch-node'\}/
    );
    expect(source('MonitoringPage.tsx')).toContain('className="monitoring-drawer"');
    expect(source('AccountMenu.tsx')).toContain('className="account-menu"');
    expect(source('App.tsx')).toContain('useRuntimeEntityStyles();');
    expect(source('AppSky.tsx')).toContain('<StarField');
    expect(source('StarField.tsx')).toContain('<circle');
    expect(SETTINGS).toMatch(/\.settings-modal-body\s*\{[^}]*grid-template-columns:\s*140px minmax\(0,\s*1fr\)/);
  });

  it('keeps the spec paints centralized and exact', () => {
    expect(TOKENS).toMatch(/html\[data-theme='dark'\][\s\S]*--background:\s*var\(--ast-navy\)/);
    expect(TOKENS).toMatch(/html\[data-theme='dark'\][\s\S]*--card:\s*rgba\(255,\s*255,\s*255,\s*0\.065\)/);
    expect(ASTROLABE).toMatch(
      /html\[data-theme='dark'\][\s\S]*--ast-text-secondary:\s*rgba\(232,\s*237,\s*242,\s*0\.68\)/
    );
    expect(ASTROLABE).toMatch(/html\[data-theme='dark'\][\s\S]*--ast-caption:\s*rgba\(232,\s*237,\s*242,\s*0\.8\)/);
    expect(DARK).toContain('background: rgba(255, 255, 255, 0.03)');
    expect(DARK).toContain('background: rgba(255, 255, 255, 0.06)');
    expect(DARK).toContain('background: var(--ast-surface-solid)');
  });

  it('de-stacks the timeline and agent-map panes on every surface that draws them', () => {
    /*
     * THIS IS THE REGRESSION GUARD FOR THE SAME BUG REPORTED TWICE.
     * `TraceTimeline` is drawn in two places -- inside the answer card's run
     * process on Ask, and bare on the Run Explorer's Timeline tab -- so a
     * de-stack scoped to `.run-process` fixed Ask and left Explorer stacking
     * 5% panes with 5% tiles inside them. The rules are matched on the
     * component's own classes for that reason; requiring the absence of the
     * wrapper is what keeps the second surface fixed.
     */
    for (const selector of [
      "html[data-theme='dark'] .trace-timeline",
      "html[data-theme='dark'] .trace-gantt",
    ]) {
      const body = bodyFor(DARK, selector);
      expect(body, `${selector} still compounds the parent pane`).toMatch(/background:\s*transparent/);
      expect(body).toMatch(/backdrop-filter:\s*none/);
    }
    for (const selector of [
      "html[data-theme='dark'] .trace-kpi",
      "html[data-theme='dark'] .trace-dag.map .dag-node",
      "html[data-theme='dark'] .trace-dag.map .dag-detail",
    ]) {
      expect(bodyFor(DARK, selector)).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)/);
    }
    expect(bodyFor(DARK, "html[data-theme='dark'] .trace-dag.map .dag-detail-head")).toMatch(
      /background:\s*transparent/
    );
    /*
     * The live panel is three layers deep on Ask: the working card carries the
     * pane, the list carried a second frost and every row carried a third card
     * fill. Only the card may hold a fill; the list is a bordered region and
     * the rows are rows.
     */
    for (const selector of [
      "html[data-theme='dark'] .live-steps",
      "html[data-theme='dark'] .live-step",
    ]) {
      const body = bodyFor(DARK, selector);
      expect(body, `${selector} still stacks white inside the working card`).toMatch(
        /background:\s*transparent/
      );
      expect(body).toMatch(/backdrop-filter:\s*none/);
    }
    // The panes that DO sit straight on the sky keep their frost.
    expect(bodyFor(DARK, "html[data-theme='dark'] .conversation-rail")).toMatch(
      /background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)/
    );
    /*
     * Inside the map's open panel, every band resolves through
     * `--ast-fill-band`, which is a fourth 3% white in dark. They have their own
     * hairlines, so they carry no fill; the payload blocks, which have no
     * border, deepen towards the scrim instead of lightening.
     */
    for (const selector of [
      "html[data-theme='dark'] .trace-dag.map .dag-sql-head",
      "html[data-theme='dark'] .trace-dag.map .dag-result-table th",
    ]) {
      expect(DARK, `${selector} still stacks white inside the detail panel`).toContain(selector);
    }
    expect(bodyFor(DARK, "html[data-theme='dark'] .trace-dag.map .dag-block")).toMatch(
      /color-mix\(in srgb, var\(--ast-scrim\)/
    );
    // No wrapper-scoped twin may come back, on either surface: one rule has to
    // answer for both, or the next mount point is another report of this bug.
    expect(DARK).not.toMatch(/\.run-process \.trace-(?:timeline|gantt|kpi)/);
    expect(DARK).not.toMatch(/\.run-explorer \.trace-(?:timeline|gantt|kpi)/);
    // Both mount points, so the shared rule is provably shared.
    expect(source('AnswerCard.tsx'), 'Ask no longer draws the run process').toContain(
      'className="run-process"'
    );
    expect(source('RunExplorer.tsx'), 'Run Explorer no longer draws the timeline').toMatch(
      /<TraceTimeline[\s\S]*?trace=\{runTrace\.trace}/
    );
    expect(source('TraceTimeline.tsx'), 'the de-stacked classes are not the ones drawn').toMatch(
      /trace-timeline/
    );
    expect(source('TraceTimeline.tsx')).toContain("variant === 'explorer' ? 'trace-timeline--explorer'");
  });

  it('leaves the de-stacked containers unfilled under reduced transparency too', () => {
    /*
     * The containers have no fill of their own in the normal dark path. Listing
     * them among the solid stand-ins would hand them a pane only when a reader
     * asks for less transparency, which is the stacking bug again in an opaque
     * form -- a slab inside the answer card's own slab. The literal-fill tiles
     * do belong there, because `--card` remapping cannot reach them.
     */
    const reduced = DARK.slice(
      DARK.indexOf('@media (prefers-reduced-transparency: reduce)'),
      DARK.indexOf('@media (prefers-reduced-motion: reduce)')
    );
    expect(reduced).toContain("html[data-theme='dark'] .trace-kpi");
    expect(reduced).not.toContain("html[data-theme='dark'] .trace-timeline");
    expect(reduced).not.toContain("html[data-theme='dark'] .trace-gantt");
    // The live list and its rows are de-stacked containers inside the working
    // card for the same reason, so neither may grow a pane here either.
    expect(reduced).not.toContain("html[data-theme='dark'] .live-steps");
    expect(reduced).not.toContain("html[data-theme='dark'] .live-step,");
  });

  it('matches the interaction, chart, and constellation treatments', () => {
    expect(DARK).toMatch(/:focus-visible\s*\{[^}]*outline:\s*1px solid var\(--ast-ice-accent\)/);
    expect(DARK).toMatch(/\.app-sky-line\s*\{[^}]*opacity:\s*0\.6/);
    expect(DARK).toMatch(/\.app-sky-glyph\s*\{[^}]*stroke-width:\s*1\.6[^}]*opacity:\s*0\.55/);
    expect(DARK).toMatch(/\.ops-lat-bar-track\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0\.08\)/);
    expect(DARK).toMatch(/\.ops-lat-bar-fill\s*\{[^}]*rgba\(143,\s*193,\s*232,\s*0\.75\)/);
    expect(DARK).toMatch(/\.arch-edge\s*\{[^}]*--ast-ice-accent[^}]*opacity:\s*0\.8/);
    expect(DARK).toMatch(/\.trace-empty-mark\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0\.06\)[^}]*--ast-white/);
    const settingsActive = bodyFor(DARK, "html[data-theme='dark'] .settings-rail button.active");
    expect(settingsActive).toMatch(/background:\s*var\(--db-selected-tint\)/);
    expect(settingsActive).toMatch(/color:\s*var\(--foreground\)/);
    expect(settingsActive).toMatch(/box-shadow:\s*none/);
    expect(settingsActive).not.toMatch(/--ast-ice-accent/);
  });

  it('routes every dark primary button through the mockup panel tokens', () => {
    /*
     * AppKit 0.38 marks its default variant with `bg-primary`; later builds add
     * a variant attribute. Both forms must reach one rule, or an upgrade turns
     * half the app back into solid mid-blue buttons while the other half keeps
     * the requested navy panel and blue edge.
     */
    expect(ASTROLABE).toMatch(/--ast-primary-control-fill:\s*#1b3049/i);
    expect(ASTROLABE).toMatch(/--ast-primary-control-border:\s*#4a8cbf/i);
    for (const selector of [
      "[data-slot='button'].bg-primary",
      "[data-slot='button'][data-variant='default']",
      "[data-slot='button'][data-variant='primary']",
    ]) {
      const primary = bodyFor(DARK, `html[data-theme='dark'] ${selector}`);
      expect(primary, `${selector} misses the shared dark primary recipe`).toMatch(
        /background:\s*var\(--ast-primary-control-fill\)/
      );
      expect(primary).toMatch(/border:\s*1px solid var\(--ast-primary-control-border\)/);
      expect(primary).toMatch(/border-radius:\s*var\(--ast-radius-control\)/);
      expect(primary).toMatch(/color:\s*var\(--ast-ink-on-dark\)/);
    }
  });

  it('keeps the header gear in the identity chip family with operable states', () => {
    /*
     * The gear is next to Signed in and belongs to that cluster. A default blue
     * square makes it look like the page's primary action; the same surface,
     * hairline, ink and 30px geometry make it a quiet neighbour without erasing
     * hover, press or keyboard focus.
     */
    const gear = bodyFor(DARK, "html[data-theme='dark'] .header-settings");
    expect(gear).toMatch(/width:\s*30px/);
    expect(gear).toMatch(/height:\s*30px/);
    expect(gear).toMatch(/border:\s*1px solid var\(--ast-border-input\)/);
    expect(gear).toMatch(/border-radius:\s*var\(--radius-sm\)/);
    expect(gear).toMatch(/background:\s*var\(--card\)/);
    expect(gear).toMatch(/color:\s*var\(--foreground\)/);
    expect(bodyFor(DARK, "html[data-theme='dark'] .header-settings:hover:not(:disabled)")).toMatch(
      /background:\s*rgba\(255,\s*255,\s*255,\s*0\.12\)/
    );
    expect(bodyFor(DARK, "html[data-theme='dark'] .header-settings:active:not(:disabled)")).toMatch(
      /background:\s*rgba\(143,\s*193,\s*232,\s*0\.28\)/
    );
    expect(bodyFor(DARK, "html[data-theme='dark'] .header-settings:focus-visible")).toMatch(
      /outline:\s*1px solid var\(--ast-ice-accent\)/
    );
    expect(source('Layout.tsx')).toMatch(
      /variant="ghost"\s+data-variant="ghost"\s+size="icon"\s+className="header-settings/
    );
  });

  it('ships both accessibility fallbacks', () => {
    expect(DARK).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(DARK).toContain('--card: var(--ast-surface-solid)');
    expect(DARK).toContain('backdrop-filter: none');
    expect(DARK).toContain('@media (prefers-reduced-motion: reduce)');
    expect(DARK).toContain('transition: none');
  });

  it('keeps the sky behind the frame without re-layering every child', () => {
    /*
     * THIS IS THE REGRESSION GUARD FOR FOUR OVERLAYS AND THE ACCOUNT MENU.
     * `position: relative; z-index: 1` on `.app-frame > :not(.app-sky)` looked
     * like a harmless way to put content above the sky. It also matched every
     * fixed child of the frame, replaced its `position: fixed`, and made the
     * header a stacking context that trapped its menu. The sky owns the negative
     * layer now; no foreground child has to surrender its own positioning.
     */
    expect(DARK).not.toMatch(/\.app-frame\s*>\s*:not\(\.app-sky\)/);
    expect(DARK).toMatch(/\.app-sky\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*-1/);
    expect(DARK).toMatch(/html\[data-theme='dark'\] \.app-frame\s*\{[^}]*isolation:\s*isolate/);
  });

  it('keeps the working-tab sky behind KPI tiles and the red banners', () => {
    /*
     * Run Explorer screenshots showed twinkling glyphs on the summary tiles and
     * the warning banner. The sky stays on the negative layer; the page
     * documents take layer 1 by name, and those reading surfaces mix toward
     * the sky fill so a 5% pane cannot leave a star sitting on the chrome.
     */
    expect(DARK).toMatch(
      /html\[data-theme='dark'\] \.app-frame > main,\s*html\[data-theme='dark'\] \.storage-banner,\s*html\[data-theme='dark'\] \.role-lost-notice\s*\{[^}]*z-index:\s*1/
    );
    expect(
      bodyFor(DARK, "html[data-theme='dark'] .page-shell:not(.run-explorer):not(.connections-page) [data-slot='card']")
    ).toMatch(/color-mix\(in srgb,\s*var\(--ast-sky-fill\)\s*86%/);
    expect(bodyFor(DARK, "html[data-theme='dark'] [data-slot='alert']")).toMatch(
      /color-mix\(in oklab,\s*var\(--ast-sky-fill\)\s*80%/
    );
    expect(bodyFor(DARK, "html[data-theme='dark'] [data-slot='alert']")).not.toMatch(
      /background:\s*var\(--(?:card|ast-neg-fill|db-red-wash)\)/
    );
  });

  it('paints Run Explorer from the Ask pane, not a lifted gray', () => {
    /*
     * The working-tab mix (sky + 14% white) made Overview look like a gray
     * sheet next to Ask. The detail column and the Recent runs list reuse
     * `--ast-pane` -- the answer card's token -- so they stay in that family.
     * Tiles and Final Answer sit on that column and destack; a second pane
     * was the leftover wash. Menus stay opaque.
     */
    for (const selector of [
      "html[data-theme='dark'] .run-explorer .run-detail",
      "html[data-theme='dark'] .run-explorer [data-slot='card']",
    ]) {
      const body = bodyFor(DARK, selector);
      expect(body, `${selector} is not the Ask pane`).toMatch(/background:\s*var\(--ast-pane\)/);
      expect(body, `${selector} still uses the lifted gray mix`).not.toMatch(/color-mix/);
      expect(body, `${selector} is not the overlay slab`).not.toMatch(/--ast-surface-solid/);
    }
    for (const selector of [
      "html[data-theme='dark'] .run-explorer .run-detail [data-slot='card']",
      "html[data-theme='dark'] .run-explorer .run-detail .final-answer",
    ]) {
      const body = bodyFor(DARK, selector);
      expect(body, `${selector} still stacks a second pane`).toMatch(/background:\s*transparent/);
      expect(body, `${selector} still frosts the column`).toMatch(/backdrop-filter:\s*none/);
      expect(body, `${selector} still uses the lifted gray mix`).not.toMatch(/color-mix/);
    }
    expect(bodyFor(DARK, "html[data-theme='dark'] .account-menu")).toMatch(
      /background:\s*var\(--ast-surface-solid\)/
    );
    expect(bodyFor(DARK, "html[data-theme='dark'] [data-slot='select-content']")).toMatch(
      /background:\s*var\(--ast-surface-solid\)/
    );
  });

  it('paints the Monitoring popup as the tab charcoal, not a lifted gray', () => {
    /*
     * The modal and the inner card are one `--ast-surface-solid` family -- the
     * same charcoal the Monitoring tab sits on. The working-tab mix (sky + 14%
     * white) used to win because two `:not()`s out-specified a shorter
     * override. The winning rule repeats that chain. No `--ast-pane` frost
     * and no new gray.
     */
    expect(bodyFor(DARK, "html[data-theme='dark'] .monitoring-question-modal")).toMatch(
      /background:\s*var\(--ast-surface-solid\)/
    );
    const modalCard = bodyFor(
      DARK,
      "html[data-theme='dark'] .page-shell:not(.run-explorer):not(.connections-page) .monitoring-question-modal .answer-card"
    );
    expect(modalCard).toMatch(/background:\s*var\(--ast-surface-solid\)/);
    expect(modalCard).not.toMatch(/color-mix/);
    expect(DARK).not.toMatch(
      /html\[data-theme='dark'\] \.page-shell \.monitoring-question-modal \.answer-card\s*\{\s*background:\s*var\(--ast-pane\)/
    );
  });

  it('paints Connections from the Ask pane, not a lifted gray', () => {
    /*
     * The same 14% white mix that washed Overview also painted Build and
     * telemetry, Identity, Configuration and the Unity Catalog block as gray
     * sheets. They reuse `--ast-pane` so the page matches Ask. Granted pills
     * and edit pencils keep their own tokens. Settings menus stay opaque.
     */
    for (const selector of [
      "html[data-theme='dark'] .connections-page [data-slot='card']",
      "html[data-theme='dark'] .connections-page .connection-block",
      "html[data-theme='dark'] .connections-page .connection-rows",
      "html[data-theme='dark'] .connections-page .plane-card",
    ]) {
      const body = bodyFor(DARK, selector);
      expect(body, `${selector} is not the Ask pane`).toMatch(/background:\s*var\(--ast-pane\)/);
      expect(body, `${selector} still uses the lifted gray mix`).not.toMatch(/color-mix/);
      expect(body, `${selector} is not the overlay slab`).not.toMatch(/--ast-surface-solid/);
    }
  });

  it('makes the dark login backdrop opaque rather than using translucent Ice', () => {
    /*
     * `--ast-ice` is three percent white in dark mode. On a full-viewport login
     * backdrop that is effectively transparent, so the shell the gate is meant
     * to withhold shows through it. The on-sky opening keeps its constellation;
     * the ordinary gate gets the solid sky fill.
     */
    expect(DARK).toMatch(
      /html\[data-theme='dark'\] \.first-open:not\(\.on-sky\)\s*\{[^}]*background:\s*var\(--ast-sky-fill\)/
    );
    expect(DARK).not.toMatch(
      /html\[data-theme='dark'\] \.first-open:not\(\.on-sky\)\s*\{[^}]*background:\s*var\(--ast-ice\)/
    );
  });

  it('makes every content-covering overlay opaque', () => {
    /*
     * Blur changes the shape of page text; it does not remove it. At six or seven
     * percent white the account badge, headings and constellation still showed
     * through the labels readers were trying to use. Every transient foreground
     * surface therefore resolves directly to the solid token, while ordinary
     * panes remain in the frosted recipe tested below.
     */
    for (const selector of [
      '.account-menu',
      '.app-select-content',
      "[data-slot='select-content']",
      "[data-slot='dropdown-menu-content']",
      "[data-slot='popover-content']",
      '.monitoring-chip-menu',
      '.monitoring-drawer',
      '.monitoring-question-modal',
      "[data-slot='sheet-content']",
    ]) {
      const body = bodyFor(DARK, `html[data-theme='dark'] ${selector}`);
      expect(body, `${selector} has no dark overlay treatment`).toMatch(/background:\s*var\(--ast-surface-solid\)/);
      expect(body, `${selector} still relies on translucent blur`).toMatch(/backdrop-filter:\s*none/);
      expect(body, `${selector} regressed to a low-alpha fill`).not.toMatch(
        /background:\s*(?:rgba\([^)]*,\s*0\.\d+\)|var\(--(?:card|popover)\))/
      );
    }
  });

  it('gives AppKit floating menus the account-menu fill, not seven percent white', () => {
    // The conversation filter is a raw SelectContent. It never wore
    // `.app-select-content`, so it painted `--popover` -- seven percent white --
    // and the run list showed through the options. The account menu already
    // uses the solid stand-in; this token is what every AppKit dropdown reads.
    const darkTokens = TOKENS.split("html[data-theme='dark']")[1] ?? '';
    expect(darkTokens).toMatch(/--popover:\s*var\(--ast-surface-solid\)/);
    expect(darkTokens).not.toMatch(/--popover:\s*rgba\(255,\s*255,\s*255,\s*0\.07\)/);
    expect(bodyFor(DARK, "html[data-theme='dark'] .account-menu")).toMatch(
      /background:\s*var\(--ast-surface-solid\)/
    );
  });

  it('keeps Settings on the rail frost instead of the opaque overlay paint', () => {
    const settings = bodyFor(DARK, "html[data-theme='dark'] .settings-page.settings-modal");
    expect(settings).toMatch(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.03\)/);
    expect(settings).toMatch(/backdrop-filter:\s*blur\(2px\)/);
    expect(settings).not.toMatch(/--ast-surface-solid/);
  });

  it('keeps every inline chip on the entity rung rather than on a light fill', () => {
    /*
     * The entity chips are already answered by the `--ast-entity-*-bg` fallbacks
     * further down this file, and those must keep their `var(--entity-*, …)`
     * chain so a colour chosen in Appearance still wins. The two chips below are
     * the ones that rung does not reach: a source's table name, drawn in the 12%
     * neutral fill, and the GET method chip, which is still a light literal.
     */
    for (const selector of [
      "html[data-theme='dark'] .source-name-pill[data-tone='neutral'] .source-name-short",
      "html[data-theme='dark'] .ops-lat-chip-get",
    ]) {
      expect(bodyFor(DARK, selector), `${selector} is not on the entity rung`).toMatch(
        /background:\s*rgba\(255,\s*255,\s*255,\s*0\.07\)/
      );
    }
    // The runtime chain, which a blanket `.entity-token` fill would have cut.
    // Fallbacks are the night-sky hexes Settings ships — not paper washes.
    expect(DARK).toMatch(
      new RegExp(`--ast-entity-table-bg:\\s*var\\(--entity-table-bg,\\s*${DEFAULT_ENTITY_STYLES.table.background}\\)`)
    );
    expect(DARK).toMatch(/--ast-entity-catalog-bg:\s*var\(--entity-catalog-bg,\s*var\(--ast-primary-control-fill\)\)/);
    expect(DARK).toMatch(
      new RegExp(`--ast-entity-schema-bg:\\s*var\\(--entity-schema-bg,\\s*${DEFAULT_ENTITY_STYLES.schema.background}\\)`)
    );
    expect(DARK).toMatch(
      new RegExp(`--ast-entity-column-bg:\\s*var\\(--entity-column-bg,\\s*${DEFAULT_ENTITY_STYLES.column.background}\\)`)
    );
    expect(DARK).toMatch(/--ast-entity-quote-bg:\s*var\(--entity-quote-bg,\s*var\(--ast-surface-solid\)\)/);
    expect(ASTROLABE).toMatch(
      new RegExp(`--ast-entity-tag-on-navy:\\s*${DEFAULT_ENTITY_STYLES.tag.background}`, 'i')
    );
    expect(DARK).toMatch(/--ast-entity-tag-bg:\s*var\(--entity-tag-bg,\s*var\(--ast-entity-tag-on-navy\)\)/);
    for (const paper of ['#ddeaf4', '#e8e8e8', '#f4f4f4', '#f7f7f7']) {
      expect(DARK, `${paper} is still an entity fallback`).not.toMatch(
        new RegExp(`--ast-entity-[a-z]+-bg:\\s*var\\(--entity-[a-z]+-bg,\\s*${paper}\\)`, 'i')
      );
    }
    expect(DARK).not.toMatch(/html\[data-theme='dark'\] \.entity-token\s*\{/);
  });

  it('corrects the two light-theme emphasis branches without erasing their state', () => {
    /*
     * Agent indices were the only step figures painted in the unreversed deep
     * blue; their border and fill still distinguish decisions from calls. The
     * segmented control had the inverse defect and used ice as a solid mass.
     * `--ast-seg-pressed` is the one fill the toggles and the plan-step badges
     * read, remapped here to the deep action rung so a filled chip is selected,
     * not a sky chip.
     */
    expect(bodyFor(DARK, "html[data-theme='dark'] .trace-dag.map .dag-index.agent")).toMatch(
      /color:\s*var\(--muted-foreground\)/
    );
    const darkTokens = ASTROLABE.split("html[data-theme='dark']")[1] ?? '';
    expect(darkTokens).toMatch(/--ast-seg-pressed:\s*var\(--db-blue-700\)/);
    expect(darkTokens).toMatch(/--ast-seg-pressed-ink:\s*var\(--ast-ink-on-dark\)/);
    expect(DARK).not.toMatch(/\.dag-seg button\[aria-pressed='true'\]/);
    expect(DARK).not.toMatch(/\.trace-payload-seg button\[aria-pressed='true'\]/);
    for (const selector of [
      ".trace-dag.map .dag-seg button[aria-pressed='true']",
      ".trace-payload-seg button[aria-pressed='true']",
      '.plan-step > span',
    ]) {
      const pressed = bodyFor(ALL_CSS, selector);
      expect(pressed, `${selector} misses the shared pressed fill`).toMatch(
        /background:\s*var\(--ast-seg-pressed\)/
      );
      expect(pressed).toMatch(/color:\s*var\(--ast-seg-pressed-ink\)/);
    }
  });

  it('routes every filled destructive control through the darker semantic token', () => {
    /*
     * `--ast-neg-text` is pale by design in dark mode and remains correct for
     * prose, glyphs and hairlines. It must never double as a solid button fill.
     * The base `--destructive` is also error text, so a control-only token keeps
     * those labels readable. Pin AppKit and the two bespoke controls to the same
     * route so all filled forms change together.
     */
    expect(bodyFor(DARK, "html[data-theme='dark']")).toMatch(/--ast-destructive-control:\s*var\(--db-red-700\)/);
    for (const selector of [
      '.conversation-confirm-delete',
      '.plane-confirm-forever',
      "[data-slot='button'][data-variant='destructive']",
    ]) {
      const body = bodyFor(DARK, `html[data-theme='dark'] ${selector}`);
      expect(body, `${selector} does not share the destructive fill`).toMatch(
        /background:\s*var\(--ast-destructive-control\)/
      );
      expect(body, `${selector} does not share the destructive edge`).toMatch(
        /border-color:\s*var\(--ast-destructive-control\)/
      );
      expect(body, `${selector} does not use the destructive label token`).toMatch(
        /color:\s*var\(--destructive-foreground\)/
      );
    }
  });

  it('keeps Settings role plaques neutral and readable in both themes', () => {
    /*
     * Roles used to carry a private chip palette: dark neutral text on a dark
     * modal for ordinary roles, plus a pale blue super-admin plaque that became
     * the loudest object in the pane. The pane now has one neutral plaque recipe
     * and the dark override remains an explicit contrast obligation rather than
     * relying on the light palette accidentally surviving a theme switch.
     */
    const settingsRules = SETTINGS.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const selector of ['.admin-row-seed', '.roster-role-chip']) {
      const base = bodyFor(settingsRules, selector);
      expect(base, `${selector} has no neutral Settings treatment`).toMatch(/background:\s*var\(--card\)/);
      expect(base).toMatch(/border:\s*1px solid var\(--ast-border-input\)/);
      expect(base).toMatch(/color:\s*var\(--foreground\)/);
    }
    expect(SETTINGS).not.toMatch(/\.roster-role-chip-super-admin\s*\{/);

    const darkChip = bodyFor(DARK, "html[data-theme='dark'] .roster-role-chip");
    expect(darkChip).toMatch(/background:\s*var\(--card\)/);
    expect(darkChip).toMatch(/border-color:\s*var\(--ast-border-input\)/);
    expect(darkChip).toMatch(/color:\s*var\(--foreground\)/);

    const remove = bodyFor(
      settingsRules,
      "html[data-theme='dark'] .settings-page [data-slot='button'].settings-destructive"
    );
    expect(remove).toMatch(/background:\s*transparent/);
    expect(remove).toMatch(/border-color:\s*var\(--ast-destructive-control\)/);
    expect(remove).toMatch(/color:\s*var\(--ast-destructive-control\)/);
    for (const component of ['AdminListEditor.tsx', 'UserRoleEditor.tsx']) {
      expect(source(component), `${component} does not identify Remove as destructive`).toContain(
        'data-variant="destructive"'
      );
    }
  });

  it('keeps Settings navigation, dismissal, table tools and focus quieter than Save', () => {
    /*
     * The modal had accumulated primary blue in five unrelated jobs: selected
     * navigation, Cancel, a tab rule, Copy and the table focus ring. Selection
     * is a quiet tint of the pane, same family as a selected conversation;
     * every other item returns to normal dark surfaces, and only Save opts
     * into the shared primary variant.
     */
    const active = bodyFor(DARK, "html[data-theme='dark'] .settings-rail button[aria-current='page']");
    expect(active).toMatch(/background:\s*var\(--db-selected-tint\)/);
    expect(active).toMatch(/border-color:\s*transparent/);
    expect(active).toMatch(/color:\s*var\(--foreground\)/);
    expect(active).not.toMatch(/--ast-ice-accent/);
    expect(active).toMatch(/box-shadow:\s*none/);

    const cancel = bodyFor(DARK, "html[data-theme='dark'] .settings-footer-actions .settings-cancel");
    expect(cancel).toMatch(/background:\s*var\(--card\)/);
    expect(cancel).toMatch(/border-color:\s*var\(--ast-border-input\)/);
    expect(cancel).toMatch(/color:\s*var\(--foreground\)/);

    const tableHead = bodyFor(DARK, "html[data-theme='dark'] .environment-list th");
    expect(tableHead).toMatch(/background:\s*var\(--muted\)/);
    expect(tableHead).toMatch(/color:\s*var\(--ast-caption\)/);

    const copy = bodyFor(DARK, "html[data-theme='dark'] .environment-tools [data-slot='button']");
    expect(copy).toMatch(/background:\s*transparent/);
    expect(copy).toMatch(/color:\s*var\(--muted-foreground\)/);

    const focus = bodyFor(DARK, "html[data-theme='dark'] .environment-list:focus-visible");
    expect(focus).toMatch(/outline:\s*1px solid var\(--ast-ice-accent\)/);
    expect(focus).toMatch(/box-shadow:\s*none/);

    const page = source('SettingsPage.tsx');
    expect(page).toMatch(/data-variant="outline"\s+className="settings-cancel"/);
    expect(page).toMatch(/data-variant="primary"\s+className="settings-save"/);
  });

  it('corrects every selector that uses deep ink as text', () => {
    /*
     * `--db-ink-deep` remains intentionally near-black in dark mode because it
     * also paints scrims and shadows. That means every use as `color:` is a
     * separate contrast obligation. Discover the call sites from the assembled
     * stylesheet, pin the complete set so a new one cannot arrive unnoticed, and
     * require the selector-specific dark correction that can beat the light rule.
     */
    const callSites = [...ALL_CSS.matchAll(/([^{}]+)\{([^{}]*color:\s*var\(--db-ink-deep\)[^{}]*)\}/g)]
      .flatMap((match) => match[1].split(','))
      .map((selector) => selector.trim())
      .filter((selector) => !selector.startsWith('@'))
      .sort();
    const corrections: Record<string, string> = {
      '.access-gate-actions button:not(.refresh-button)': '.access-gate-actions button:not(.refresh-button)',
      ".conversation-filter-chip[aria-pressed='true']": ".conversation-filter-chip[aria-pressed='true']",
      ".conversation-filter-chip:not(.is-all)[aria-pressed='true'] > .identity-chip":
        ".conversation-filter-chip:not(.is-all)[aria-pressed='true'] > .identity-chip",
      '.identity-chip': '.identity-chip',
      ".time-range-segment:hover:not([aria-checked='true'])": ".time-range-segment:hover:not([aria-checked='true'])",
      ".time-range-segment[aria-checked='true']": ".time-range-segment[aria-checked='true']",
    };
    expect(callSites).toEqual(Object.keys(corrections).sort());
    for (const [lightSelector, darkSelector] of Object.entries(corrections)) {
      const correction = bodyFor(DARK, `html[data-theme='dark'] ${darkSelector}`);
      expect(correction, `${lightSelector} has no dark text correction`).not.toEqual('');
      expect(correction).toMatch(/color:\s*var\(--foreground\)/);
    }
  });

  it('frosts the monitoring list and Ops blocks with a solid fallback', () => {
    /*
     * These two large blocks used to leave the constellation visible between
     * rows and figures while the cards around them were frosted. They belong to
     * the same selector recipe in the normal theme and must become solid in the
     * reduced-transparency path; adding either to only one list is a layout that
     * changes when an accessibility preference is enabled.
     */
    const reducedAt = DARK.indexOf('@media (prefers-reduced-transparency: reduce)');
    const normal = DARK.slice(0, reducedAt);
    const reduced = DARK.slice(reducedAt, DARK.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const selector of ['.monitoring-list-pane', '.monitoring-filters .monitoring-search input', '.ops-block']) {
      expect(normal, `${selector} is not frosted in dark`).toContain(`html[data-theme='dark'] ${selector}`);
      expect(reduced, `${selector} has no reduced-transparency fallback`).toContain(
        `html[data-theme='dark'] ${selector}`
      );
      expect(bodyFor(normal, `html[data-theme='dark'] ${selector}`)).toMatch(
        /background:\s*var\(--card\)[\s\S]*backdrop-filter:\s*blur\(2px\)/
      );
      expect(bodyFor(reduced, `html[data-theme='dark'] ${selector}`)).toMatch(
        /backdrop-filter:\s*none[\s\S]*background:\s*var\(--ast-surface-solid\)/
      );
    }
  });

  it('frosts the Benchmarking how-to so a star cannot sit on the steps', () => {
    /*
     * The how-to is eight sentences on the sky and is not a card, so the
     * working-tab mix never reached it. Mixing solid with transparent still
     * left constellation lines on the type. The opaque sky-to-white mix is
     * the same recipe the Monitoring tiles use: glass, not a window.
     */
    const reducedAt = DARK.indexOf('@media (prefers-reduced-transparency: reduce)');
    const normal = DARK.slice(0, reducedAt);
    const reduced = DARK.slice(reducedAt, DARK.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(normal).toMatch(
      /html\[data-theme='dark'\] \.eval-steps\s*\{[^}]*color-mix\(in srgb, var\(--ast-sky-fill\) 86%, white\)[^}]*backdrop-filter:\s*blur\(10px\)/
    );
    expect(reduced, 'the how-to has no reduced-transparency fallback').toContain(
      "html[data-theme='dark'] .eval-steps"
    );
    expect(bodyFor(reduced, "html[data-theme='dark'] .eval-steps")).toMatch(
      /backdrop-filter:\s*none[\s\S]*background:\s*var\(--ast-surface-solid\)/
    );
  });

  it('frosts Benchmark Lab v3 surfaces at 4% white', () => {
    const reducedAt = DARK.indexOf('@media (prefers-reduced-transparency: reduce)');
    const normal = DARK.slice(0, reducedAt);
    const reduced = DARK.slice(reducedAt, DARK.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(normal).toMatch(
      /html\[data-theme='dark'\] \.bench-surface\s*\{[^}]*rgba\(255,\s*255,\s*255,\s*0\.04\)[^}]*backdrop-filter:\s*blur\(2px\)/
    );
    expect(reduced).toContain("html[data-theme='dark'] .bench-surface");
    expect(bodyFor(reduced, "html[data-theme='dark'] .bench-surface")).toMatch(
      /backdrop-filter:\s*none[\s\S]*background:\s*var\(--ast-surface-solid\)/
    );
  });

  it('frosts the Architecture KPI tiles with the same pane recipe as LIVE DATA FLOW', () => {
    const reducedAt = DARK.indexOf('@media (prefers-reduced-transparency: reduce)');
    const normal = DARK.slice(0, reducedAt);
    const reduced = DARK.slice(reducedAt, DARK.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const selector of ['.arch-flow', '.arch-tiles:not(.arch-tiles-loop) li']) {
      expect(bodyFor(normal, `html[data-theme='dark'] ${selector}`)).toMatch(
        /background:\s*var\(--card\)[\s\S]*backdrop-filter:\s*blur\(2px\)/
      );
      expect(bodyFor(reduced, `html[data-theme='dark'] ${selector}`)).toMatch(
        /backdrop-filter:\s*none[\s\S]*background:\s*var\(--ast-surface-solid\)/
      );
    }
  });
});
