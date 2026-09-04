import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  APP_TOPOLOGY_DOT_SIZE,
  APP_TOPOLOGY_EDGE_INDEXES,
  APP_TOPOLOGY_ICON_SIZE,
  APP_TOPOLOGY_MAX_ACCENT_NODES,
  APP_TOPOLOGY_MAX_NODES,
  AppTopology,
  buildAppTopology,
  connectorPhaseAt,
  SKY_APPEAR_STEP,
  SKY_DRAW_HOLD_UNTIL,
  SKY_DRAW_INK_UNTIL,
  SKY_DRAW_LIVE_UNTIL,
  SKY_DRAW_SECONDS,
  SKY_NODE_MIN_SECONDS,
  topologyPointKey,
} from './StarField';

const CSS = readFileSync(new URL('./styles/star-motion.css', import.meta.url), 'utf8');
const APPEARANCE = readFileSync(new URL('./styles/appearance-preferences.css', import.meta.url), 'utf8');
const SOURCE = readFileSync(new URL('./StarField.tsx', import.meta.url), 'utf8');
const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const RAIL = readFileSync(new URL('./styles/rail.css', import.meta.url), 'utf8');

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

describe('the stationary app topology', () => {
  it('builds one deterministic, reduced-density graph', () => {
    const first = buildAppTopology();
    const second = buildAppTopology();

    expect(first).toEqual(second);
    expect(first.connectors).toHaveLength(APP_TOPOLOGY_EDGE_INDEXES.length);
    expect(first.nodes.length).toBeLessThanOrEqual(APP_TOPOLOGY_MAX_NODES);
    expect(first.nodes.length).toBeGreaterThan(12);

    const accents = first.nodes.filter((node) => node.glyph !== 'dot');
    expect(accents).toHaveLength(APP_TOPOLOGY_MAX_ACCENT_NODES);
    expect(accents.map((node) => node.glyph)).toEqual(
      expect.arrayContaining(['genie', 'unity-catalog', 'dpad', 'sparkle', 'cross'])
    );
    expect(accents.every((node) => node.size === APP_TOPOLOGY_ICON_SIZE)).toBe(true);
    expect(
      first.nodes.filter((node) => node.glyph === 'dot').every((node) => node.size === APP_TOPOLOGY_DOT_SIZE)
    ).toBe(true);
    expect(APP_TOPOLOGY_ICON_SIZE).toBe(3);
    expect(APP_TOPOLOGY_DOT_SIZE).toBe(1.5);
  });

  it('maps every fixed edge endpoint to a rendered node', () => {
    const topology = buildAppTopology();
    const nodes = new Set(topology.nodes.map((node) => topologyPointKey([node.x, node.y])));
    const endpoints = topology.connectors.flatMap((edge) => [topologyPointKey(edge.from), topologyPointKey(edge.to)]);

    expect(endpoints.filter((endpoint) => !nodes.has(endpoint))).toEqual([]);
    expect(new Set(endpoints)).toEqual(nodes);
  });

  it('renders one viewBox and no transform on the coordinate or node groups', () => {
    const markup = renderToStaticMarkup(<AppTopology />);
    expect(markup.match(/<svg\b/g)).toHaveLength(1);
    expect(markup).toContain('data-app-topology=""');
    expect(markup).toContain('viewBox="0 0 1180 700"');
    expect(markup).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(markup).toMatch(
      /<g data-topology-coordinate-space="">[\s\S]*data-topology-edges=""[\s\S]*data-topology-nodes=""/
    );
    expect(markup).not.toMatch(/data-topology-(?:coordinate-space|node)[^>]*transform=/);
    expect(markup).not.toMatch(/style="[^"]*transform/);
    const implementation = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(implementation).not.toMatch(/\btransform(?:Origin)?\b|translate\(|driftDelay|star-motion-drift/);
    expect(SOURCE).toContain('useMemo(() => buildAppTopology(), [])');
  });

  it('keeps product and controller marks as small fixed graph nodes', () => {
    const markup = renderToStaticMarkup(<AppTopology />);
    const glyphs = [...markup.matchAll(/data-topology-glyph="([^"]+)"/g)].map((match) => match[1]);
    expect(glyphs.filter((glyph) => glyph !== 'dot')).toHaveLength(APP_TOPOLOGY_MAX_ACCENT_NODES);
    expect(markup).toContain('data:image/svg+xml');
    expect(markup).toContain('data-topology-glyph="genie"');
    expect(markup).toContain('data-topology-glyph="dpad"');
  });

  it('has no route-local decorative topology or texture', () => {
    expect(HOME).not.toContain('<ConstellationField');
    expect(HOME).not.toContain('trace-idle-sky');
    expect(RAIL).not.toContain('trace-idle-sky');
    expect(RAIL).not.toMatch(/--ast-sky-spackle|radial-gradient/);
  });
});

describe('allowed topology animation', () => {
  it('defines only a node fade and connector trace', () => {
    expect([...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1])).toEqual([
      'ast-topology-blink',
      'ast-sky-draw',
    ]);

    const blink = keyframes('ast-topology-blink');
    const draw = keyframes('ast-sky-draw');
    expect(blink).toMatch(/opacity:\s*0\.48[\s\S]*opacity:\s*0\.72/);
    expect(blink).not.toMatch(/\b(?:transform|translate|rotate|left|top)\s*:/);
    expect(draw).toMatch(/stroke-dashoffset:\s*1[\s\S]*stroke-dashoffset:\s*0[\s\S]*stroke-dashoffset:\s*1/);
    expect(draw).not.toMatch(/\b(?:transform|translate|rotate|left|top)\s*:/);

    expect([...CSS.matchAll(/animation-name:\s*([^;]+)/g)].map((match) => match[1])).toEqual([
      'ast-topology-blink',
      'ast-sky-draw',
    ]);
    expect(CSS).not.toMatch(/translate|rotate|transform-origin|transform-box/);
  });

  it('traces infrequently and at subordinate opacity', () => {
    const topology = buildAppTopology();
    expect(SKY_APPEAR_STEP).toBe(18);
    expect(SKY_DRAW_SECONDS).toBe(180);
    expect(SKY_DRAW_INK_UNTIL).toBe(0.08);
    expect(SKY_DRAW_HOLD_UNTIL).toBe(0.72);
    expect(SKY_DRAW_LIVE_UNTIL).toBe(0.8);
    expect(SKY_NODE_MIN_SECONDS).toBe(36);
    expect(topology.connectors.every((connector) => connector.duration === 180)).toBe(true);
    expect(
      topology.connectors
        .slice(1)
        .every((connector, index) => connector.delay - topology.connectors[index].delay === 18)
    ).toBe(true);
    expect(CSS).toMatch(/\.star-motion-draw\s*\{[^}]*opacity:\s*0\.28/s);
    expect(connectorPhaseAt(topology.connectors[0], 0)).toBe('holding');
    expect(connectorPhaseAt(topology.connectors[1], 0)).toBe('drawing');
  });

  it('freezes visible nodes and completed edges for both motion controls', () => {
    const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\[data-star-motion='anchor'\]\s*\{[^}]*animation:\s*none[^}]*opacity:\s*0\.62/s);
    expect(reduced).toMatch(
      /\.star-motion-draw\s*\{[^}]*animation:\s*none[^}]*stroke-dashoffset:\s*0[^}]*opacity:\s*0\.28/s
    );
    expect(reduced).not.toMatch(/transform|translate/);
    expect(APPEARANCE).toMatch(
      /data-animations='off'] \.app-sky\[data-star-motion-field] \*\s*\{[^}]*animation:\s*none !important/s
    );
    expect(APPEARANCE).toMatch(
      /data-animations='off'] \.app-sky\[data-star-motion-field] \[data-star-motion='anchor'\]\s*\{[^}]*opacity:\s*0\.62/s
    );
    expect(APPEARANCE).toMatch(/data-background-graphics='off'] \.app-sky\s*\{[^}]*display:\s*none !important/s);
  });

  it('remains pointer-transparent and hidden in forced colors', () => {
    expect(CSS).toMatch(
      /\.app-sky\[data-star-motion-field\]\s*\{[^}]*position:\s*fixed[^}]*width:\s*100vw[^}]*height:\s*100vh[^}]*pointer-events:\s*none/s
    );
    expect(CSS).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*\.app-sky\[data-star-motion-field\]\s*\{[^}]*display:\s*none/s
    );
  });
});
