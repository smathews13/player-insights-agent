/* eslint-disable react-refresh/only-export-components -- topology geometry, timing, and its only renderer are one contract */
/**
 * The app-wide topology: one SVG, one viewBox, and one transform for login and
 * every route. Nodes retain the game and Databricks-product glyphs from the
 * canonical opening geometry; connectors and nodes never use separate sizing or
 * positioning systems.
 *
 * JavaScript builds the drawing once. CSS owns the slow pulse, drift, and
 * connector draw using compositor-friendly properties, so React never runs an
 * animation frame loop.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { StarGlyphShape } from './ConstellationField';
import { OPENING_CONSTELLATION, type Star } from './constellation';

/** Shared by the login gate and the app shell so both mount the same sky. */
export const SKY_PAGE_ID = 'app-sky';

/** Seconds between new connectors starting to draw. Half the prior 5s cadence. */
export const SKY_APPEAR_STEP = 10;

/** Fraction of a cycle spent inking (matches ast-sky-draw 0–12%). Spawn cadence is not this. */
export const SKY_DRAW_INK_UNTIL = 0.12;

/** Fraction of a cycle before retract starts (matches ast-sky-draw 12–60% hold). */
export const SKY_DRAW_HOLD_UNTIL = 0.6;

/** Fraction of a connector cycle that the line is on screen (matches ast-sky-draw). */
export const SKY_DRAW_LIVE_UNTIL = 0.8;

interface Timing {
  duration: number;
  delay: number;
}

export type AmbientNode = Star & Timing;

export interface AmbientConnector extends Timing {
  from: readonly [number, number];
  to: readonly [number, number];
}

export interface AppTopologyDrawing {
  nodes: AmbientNode[];
  connectors: AmbientConnector[];
  driftDelay: number;
}

/** Anchor twinkle cycle floor. Half the e0e254a9 blink rate (was 12s). */
export const SKY_ANCHOR_MIN_SECONDS = 24;
const ANCHOR_SPREAD = 12;
/** Connector cycle floor. Slower than the prior 44s retract rate. */
export const SKY_DRAW_MIN_SECONDS = 72;
const DRAW_SPREAD = 8;
const DRIFT_ANCHOR_SECONDS = 90;
const EARLY_SHIFT = 17.6;

/** A small deterministic generator whose state advances only while the drawing is built. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A string hash rather than an integer prop disguised as a page identity.
 *
 * The tab seed supplies per-visit variety and the page id supplies stable
 * differences between surfaces. Keeping both in the hash prevents a route
 * change from consuming whichever random values the previous route happened to
 * use, which would make the result depend on navigation history.
 */
export function hashStarSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const tenth = (value: number) => Math.round(value * 10) / 10;

function timing(
  random: () => number,
  minimum: number,
  spread: number,
  used: Set<string>,
  delayFloor = 0.1,
  delayCeiling?: number
): Timing {
  for (;;) {
    const duration = tenth(minimum + random() * spread);
    const ceiling = Math.min(duration, delayCeiling ?? duration);
    const delay = -tenth(delayFloor + random() * (ceiling - delayFloor));
    const key = `${duration}/${delay}`;
    if (!used.has(key)) {
      used.add(key);
      return { duration, delay };
    }
  }
}

function documentSeed(): string {
  if (typeof window === 'undefined') return 'server';

  /*
   * Crypto is used once for document identity, never for animation. A module
   * value rather than sessionStorage matters when a tab is duplicated: browsers
   * clone sessionStorage into the new tab, which would give both tabs the same
   * sky. Module evaluation gives each full page load its own seed and React
   * re-renders keep reading that one value.
   */
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
    ? crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
    : `${Date.now().toString(36)}-${performance.now().toString(36)}`;
}

/** One value per page load. Layout must keep this component mounted so Continue cannot mint another. */
export const SKY_DOCUMENT_SEED = documentSeed();

/** One coordinate as a graph key, written once so tests and rendering agree. */
export const topologyPointKey = (point: readonly [number, number]): string => `${point[0]},${point[1]}`;

export type ConnectorPhase = 'waiting' | 'drawing' | 'holding' | 'retracting' | 'gone';

/**
 * Where a connector is in its draw–hold–retract cycle at `elapsedSeconds`.
 *
 * Retract is a real un-draw (dashoffset returning to 1) plus a fade, not a
 * pop-off. Tests use this instead of a browser to prove add and remove both
 * happen, and that the sky never sits empty.
 */
export function connectorPhaseAt(connector: AmbientConnector, elapsedSeconds: number): ConnectorPhase {
  const local = elapsedSeconds - connector.delay;
  if (local < 0) return 'waiting';
  const progress = (local % connector.duration) / connector.duration;
  if (progress < SKY_DRAW_INK_UNTIL) return 'drawing';
  if (progress < SKY_DRAW_HOLD_UNTIL) return 'holding';
  if (progress < SKY_DRAW_LIVE_UNTIL) return 'retracting';
  return 'gone';
}

/**
 * Whether a connector is on screen at `elapsedSeconds` from first paint.
 *
 * Positive delay means the line has not started drawing yet. After it starts,
 * it is live through draw, hold, and retract -- the first `SKY_DRAW_LIVE_UNTIL`
 * of its cycle -- and then hidden until the cycle repeats. This is the
 * schedule a test can advance without a browser.
 */
export function connectorIsLiveAt(connector: AmbientConnector, elapsedSeconds: number): boolean {
  const phase = connectorPhaseAt(connector, elapsedSeconds);
  return phase === 'drawing' || phase === 'holding' || phase === 'retracting';
}

export function liveConnectorsAt(drawing: AppTopologyDrawing, elapsedSeconds: number): AmbientConnector[] {
  return drawing.connectors.filter((connector) => connectorIsLiveAt(connector, elapsedSeconds));
}

function appearDelay(index: number, random: () => number, used: Set<string>): Timing {
  for (;;) {
    const duration = tenth(SKY_DRAW_MIN_SECONDS + random() * DRAW_SPREAD);
    const delay = tenth(index * SKY_APPEAR_STEP - EARLY_SHIFT + (random() * 0.4 - 0.1));
    const key = `${duration}/${delay}`;
    if (!used.has(key)) {
      used.add(key);
      return { duration, delay };
    }
  }
}

/**
 * Builds the animated schedule around one immutable topology.
 *
 * Only timing varies by visit. Coordinates, glyph identity, and graph membership
 * remain canonical so zoom, aspect-ratio changes, and route changes cannot
 * produce two drawings that merely resemble one another.
 */
export function buildAppTopology(pageId: string, visitSeed: string | number): AppTopologyDrawing {
  const random = mulberry32(hashStarSeed(`${pageId}:${visitSeed}`));
  const nodeTiming = new Set<string>();
  const edgeTiming = new Set<string>();
  const nodes: AmbientNode[] = OPENING_CONSTELLATION.stars.map((node) => ({
    ...node,
    ...timing(random, SKY_ANCHOR_MIN_SECONDS, ANCHOR_SPREAD, nodeTiming),
  }));
  const nodeKeys = new Set(nodes.map((node) => topologyPointKey([node.x, node.y])));
  const orphan = OPENING_CONSTELLATION.hops.find(
    (hop) => !nodeKeys.has(topologyPointKey(hop.from)) || !nodeKeys.has(topologyPointKey(hop.to))
  );
  if (orphan) {
    throw new Error(`Topology edge has no node: ${topologyPointKey(orphan.from)} → ${topologyPointKey(orphan.to)}`);
  }

  const connectors: AmbientConnector[] = OPENING_CONSTELLATION.hops.map((hop, index) => ({
    from: hop.from,
    to: hop.to,
    ...appearDelay(index, random, edgeTiming),
  }));

  return {
    nodes,
    connectors,
    driftDelay: -tenth(0.1 + random() * (DRIFT_ANCHOR_SECONDS - 0.1)),
  };
}

const animationStyle = (timingValue: Timing): CSSProperties => ({
  animationDuration: `${timingValue.duration}s`,
  animationDelay: `${timingValue.delay}s`,
});

export function AppTopology({
  pageId,
  seed,
}: {
  pageId: string;
  /** An explicit seed exists for static rendering and deterministic tests. */
  seed?: string | number;
}) {
  const [visitSeed] = useState(() => seed ?? SKY_DOCUMENT_SEED);
  const drawing = useMemo(() => buildAppTopology(pageId, visitSeed), [pageId, visitSeed]);

  return (
    <svg
      className="app-sky"
      data-star-motion-field=""
      data-app-topology=""
      data-sky-seed={String(visitSeed)}
      viewBox={`0 0 ${OPENING_CONSTELLATION.width} ${OPENING_CONSTELLATION.height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {/* Every edge and every glyph is under this one responsive transform. */}
      <g
        className="star-motion-drift star-motion-drift-anchor"
        data-topology-transform=""
        style={{ animationDelay: `${drawing.driftDelay}s` }}
      >
        <g className="star-motion-connectors" data-topology-edges="">
          {drawing.connectors.map((connector) => (
            <line
              key={`${topologyPointKey(connector.from)}-${topologyPointKey(connector.to)}`}
              className="app-sky-line star-motion-draw"
              data-sky-appear={connector.delay}
              x1={connector.from[0]}
              y1={connector.from[1]}
              x2={connector.to[0]}
              y2={connector.to[1]}
              pathLength={1}
              strokeDasharray={1}
              style={animationStyle(connector)}
            />
          ))}
        </g>

        <g data-topology-nodes="">
          {drawing.nodes.map((node) => (
            <g
              key={topologyPointKey([node.x, node.y])}
              className="app-topology-node"
              data-star-motion="anchor"
              data-topology-node={topologyPointKey([node.x, node.y])}
              data-topology-glyph={node.glyph}
              style={{
                ...animationStyle(node),
                transformOrigin: `${node.x}px ${node.y}px`,
              }}
            >
              <StarGlyphShape star={node} />
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
