import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OPENING_CONSTELLATION } from './constellation';
import {
  AppTopology,
  buildAppTopology,
  connectorPhaseAt,
  liveConnectorsAt,
  SKY_ANCHOR_MIN_SECONDS,
  SKY_APPEAR_STEP,
  SKY_DRAW_HOLD_UNTIL,
  SKY_DRAW_LIVE_UNTIL,
  SKY_DRAW_MIN_SECONDS,
  SKY_PAGE_ID,
  topologyPointKey,
} from './StarField';

const CSS = readFileSync(new URL('./styles/star-motion.css', import.meta.url), 'utf8');
const APPEARANCE = readFileSync(new URL('./styles/appearance-preferences.css', import.meta.url), 'utf8');
const DARK = readFileSync(new URL('./styles/dark-mode.css', import.meta.url), 'utf8');
const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const RAIL = readFileSync(new URL('./styles/rail.css', import.meta.url), 'utf8');
const TOKENS = readFileSync(new URL('./styles/astrolabe-tokens.css', import.meta.url), 'utf8');
const CONSTELLATION_CSS = readFileSync(new URL('./styles/constellation.css', import.meta.url), 'utf8');
const AGENT_CONSTELLATION = readFileSync(new URL('./AgentConstellation.tsx', import.meta.url), 'utf8');

function keyframes(name: string): string {
  const start = CSS.indexOf(`@keyframes ${name}`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  let depth = 0;
  for (let at = CSS.indexOf('{', start); at < CSS.length; at += 1) {
    if (CSS[at] === '{') depth += 1;
    if (CSS[at] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, at + 1);
    }
  }
  throw new Error(`Unclosed keyframes: ${name}`);
}

describe('the canonical app topology', () => {
  it('uses the opening graph as one immutable geometry source', () => {
    const alpha = buildAppTopology(SKY_PAGE_ID, 'alpha');
    const beta = buildAppTopology(SKY_PAGE_ID, 'beta');

    expect(alpha.nodes.map(({ x, y, glyph, size }) => ({ x, y, glyph, size }))).toEqual(
      OPENING_CONSTELLATION.stars.map(({ x, y, glyph, size }) => ({ x, y, glyph, size }))
    );
    expect(alpha.connectors.map(({ from, to }) => ({ from, to }))).toEqual(
      OPENING_CONSTELLATION.hops.map(({ from, to }) => ({ from, to }))
    );
    expect(beta.nodes.map(({ x, y, glyph, size }) => ({ x, y, glyph, size }))).toEqual(
      alpha.nodes.map(({ x, y, glyph, size }) => ({ x, y, glyph, size }))
    );
    expect(beta.connectors.map(({ from, to }) => ({ from, to }))).toEqual(
      alpha.connectors.map(({ from, to }) => ({ from, to }))
    );
  });

  it('maps both endpoints of every edge to an intentional node', () => {
    const topology = buildAppTopology(SKY_PAGE_ID, 'joined');
    const nodes = new Set(topology.nodes.map((node) => topologyPointKey([node.x, node.y])));
    const endpoints = topology.connectors.flatMap((edge) => [topologyPointKey(edge.from), topologyPointKey(edge.to)]);

    expect(endpoints.filter((endpoint) => !nodes.has(endpoint))).toEqual([]);
    expect(new Set(endpoints)).toEqual(nodes);
  });

  it('renders game, controller, and product marks as nodes in that graph', () => {
    const markup = renderToStaticMarkup(<AppTopology pageId={SKY_PAGE_ID} seed="glyphs" />);
    const glyphs = [...markup.matchAll(/data-topology-glyph="([^"]+)"/g)].map((match) => match[1]);

    for (const glyph of ['cross', 'square', 'triangle', 'dpad', 'sparkle', 'genie', 'unity-catalog']) {
      expect(glyphs, glyph).toContain(glyph);
    }
    expect(markup).toContain('data:image/svg+xml');
    expect(markup).not.toContain('star-motion-faint');
    expect(APPEARANCE).not.toContain('star-motion-faint');
  });

  it('puts edges and nodes under one transform and one cover viewBox', () => {
    const markup = renderToStaticMarkup(<AppTopology pageId={SKY_PAGE_ID} seed="markup" />);
    expect(markup.match(/<svg\b/g)).toHaveLength(1);
    expect(markup).toContain('data-app-topology=""');
    expect(markup).toContain(`viewBox="0 0 ${OPENING_CONSTELLATION.width} ${OPENING_CONSTELLATION.height}"`);
    expect(markup).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(markup).toMatch(
      /<g class="star-motion-drift star-motion-drift-anchor"[^>]*data-topology-transform=""[^>]*>[\s\S]*data-topology-edges=""[\s\S]*data-topology-nodes=""/
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(readFileSync(new URL('./StarField.tsx', import.meta.url), 'utf8')).toContain(
      'useMemo(() => buildAppTopology(pageId, visitSeed), [pageId, visitSeed])'
    );
  });

  it('has no second page starfield, local idle topology, or disconnected dust', () => {
    for (const source of [HOME, RAIL, TOKENS, CONSTELLATION_CSS, AGENT_CONSTELLATION]) {
      expect(source).not.toContain('trace-idle-sky');
      expect(source).not.toContain('ast-sky-spackle');
      expect(source).not.toContain('ast-sky-dust');
    }
    expect(HOME).not.toContain('<ConstellationField');
    expect(HOME).not.toContain('OPENING_CONSTELLATION');
  });

  it('pins one viewport without layout, scroll, seam, or pointer contribution', () => {
    expect(CSS).toMatch(
      /\.app-sky\[data-star-motion-field\]\s*\{[^}]*position:\s*fixed[^}]*width:\s*100vw[^}]*height:\s*100vh[^}]*overflow:\s*hidden[^}]*pointer-events:\s*none/s
    );
    expect(CSS).toMatch(/\.app-sky-host\s*\{[^}]*isolation:\s*isolate[^}]*min-height:\s*100vh/s);
    expect(CSS).not.toMatch(/background-(?:size|position)/);
  });

  it('passes through uncovered dark regions while existing surfaces occlude it', () => {
    expect(DARK).toMatch(/html\[data-theme='dark'\] \.trace-inspector\s*\{[^}]*background:\s*transparent/s);
    expect(DARK).toMatch(
      /html\[data-theme='dark'\] \.conversation-rail\s*\{[^}]*background:\s*var\(--ast-surface-primary\)/s
    );
    expect(DARK).toMatch(
      /html\[data-theme='dark'\] \.app-select-content,[\s\S]*background:\s*var\(--ast-surface-menu\)/s
    );
  });

  it('freezes the whole graph for reduced motion and the explicit animation setting', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\[data-star-motion='anchor'\]\s*\{[^}]*animation:\s*none[^}]*transform:\s*none/s);
    expect(reduced).toMatch(/\.star-motion-draw\s*\{[^}]*animation:\s*none[^}]*stroke-dashoffset:\s*0/s);
    expect(reduced).toMatch(/\.star-motion-drift\s*\{[^}]*animation:\s*none[^}]*transform:\s*translate\(0,\s*0\)/s);
    expect(APPEARANCE).toMatch(
      /data-animations='off'] \.app-sky\[data-star-motion-field] \*\s*\{[^}]*animation:\s*none !important[^}]*transform:\s*none/s
    );
    expect(APPEARANCE).toMatch(/data-background-graphics='off'] \.app-sky\s*\{[^}]*display:\s*none !important/s);
    expect(CSS).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*\.app-sky\[data-star-motion-field\]\s*\{[^}]*display:\s*none/s
    );
  });
});

describe('topology motion schedule', () => {
  it('uses one shared drift and compositor-safe pulse/draw properties', () => {
    expect(CSS.match(/@keyframes\s+ast-(?:tw|drift|sky-draw)\b/g)).toHaveLength(3);
    expect(CSS).not.toContain('@keyframes ast-drift2');
    expect(CSS).not.toContain('@keyframes ast-tw2');
    expect(CSS).not.toContain('will-change');
    expect(keyframes('ast-drift')).toMatch(/translate\(0,\s*0\)[\s\S]*translate\(-14px,\s*8px\)/);
    expect(keyframes('ast-tw')).toMatch(
      /opacity:\s*0\.4[\s\S]*transform:\s*scale\(0\.75\)[\s\S]*opacity:\s*0\.85[\s\S]*transform:\s*scale\(1\.2\)/
    );
    expect(keyframes('ast-sky-draw')).toMatch(
      /stroke-dashoffset:\s*1[\s\S]*stroke-dashoffset:\s*0[\s\S]*stroke-dashoffset:\s*1/
    );
  });

  it('keeps the slow add, hold, retract, and pulse contracts', () => {
    expect(SKY_APPEAR_STEP).toBe(10);
    expect(SKY_ANCHOR_MIN_SECONDS).toBe(24);
    expect(SKY_DRAW_MIN_SECONDS).toBe(72);
    expect(SKY_DRAW_HOLD_UNTIL).toBe(0.6);
    expect(SKY_DRAW_LIVE_UNTIL).toBe(0.8);

    const drawing = buildAppTopology(SKY_PAGE_ID, 'schedule');
    expect(drawing.nodes.every((node) => node.duration >= SKY_ANCHOR_MIN_SECONDS)).toBe(true);
    expect(drawing.connectors.every((edge) => edge.duration >= SKY_DRAW_MIN_SECONDS)).toBe(true);
    expect(liveConnectorsAt(drawing, 0).length).toBeGreaterThan(0);
    expect(liveConnectorsAt(drawing, 16).length).toBeGreaterThan(liveConnectorsAt(drawing, 0).length);
    expect(drawing.connectors.some((edge) => connectorPhaseAt(edge, 60) === 'retracting')).toBe(true);
  });
});
