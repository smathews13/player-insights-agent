/* eslint-disable react-refresh/only-export-components -- topology geometry, timing, and its only renderer are one contract */
/**
 * One stationary app-wide topology for login and every route.
 *
 * Nodes and connectors share one SVG coordinate space. Geometry never changes
 * between renders or visits; CSS may only fade nodes and trace connector
 * strokes. There is no translation, orbit, parallax, or animation-frame loop.
 */
import { useMemo, type CSSProperties } from 'react';
import { StarGlyphShape } from './ConstellationField';
import { OPENING_CONSTELLATION, type Star } from './constellation';

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
}

/** Thirteen quiet edges retain the five spatial groups without filling the page. */
export const APP_TOPOLOGY_EDGE_INDEXES = [0, 1, 2, 3, 7, 8, 9, 11, 12, 14, 15, 16, 18] as const;
export const APP_TOPOLOGY_MAX_NODES = 18;
export const APP_TOPOLOGY_MAX_ACCENT_NODES = 5;
export const APP_TOPOLOGY_DOT_SIZE = 1.5;
export const APP_TOPOLOGY_ICON_SIZE = 3;

/** One connector begins a trace at most every eighteen seconds. */
export const SKY_APPEAR_STEP = 18;
export const SKY_DRAW_SECONDS = 180;
export const SKY_DRAW_INK_UNTIL = 0.08;
export const SKY_DRAW_HOLD_UNTIL = 0.72;
export const SKY_DRAW_LIVE_UNTIL = 0.8;
export const SKY_NODE_MIN_SECONDS = 36;

/** One coordinate as a graph key, written once so tests and rendering agree. */
export const topologyPointKey = (point: readonly [number, number]): string => `${point[0]},${point[1]}`;

const ACCENT_NODE_KEYS = new Set([
  topologyPointKey([330, 170]), // Genie
  topologyPointKey([1100, 190]), // Unity Catalog
  topologyPointKey([205, 650]), // controller D-pad
  topologyPointKey([365, 610]), // game sparkle
  topologyPointKey([820, 250]), // game cross
]);

export type ConnectorPhase = 'waiting' | 'drawing' | 'holding' | 'retracting' | 'gone';

export function connectorPhaseAt(connector: AmbientConnector, elapsedSeconds: number): ConnectorPhase {
  const local = elapsedSeconds - connector.delay;
  if (local < 0) return 'waiting';
  const progress = (local % connector.duration) / connector.duration;
  if (progress < SKY_DRAW_INK_UNTIL) return 'drawing';
  if (progress < SKY_DRAW_HOLD_UNTIL) return 'holding';
  if (progress < SKY_DRAW_LIVE_UNTIL) return 'retracting';
  return 'gone';
}

export function connectorIsLiveAt(connector: AmbientConnector, elapsedSeconds: number): boolean {
  const phase = connectorPhaseAt(connector, elapsedSeconds);
  return phase === 'drawing' || phase === 'holding' || phase === 'retracting';
}

export function liveConnectorsAt(drawing: AppTopologyDrawing, elapsedSeconds: number): AmbientConnector[] {
  return drawing.connectors.filter((connector) => connectorIsLiveAt(connector, elapsedSeconds));
}

/**
 * Build one deterministic graph. Timing is index-derived rather than random so
 * revisiting the page cannot make symbols appear to acquire new behavior.
 */
export function buildAppTopology(): AppTopologyDrawing {
  const connectors: AmbientConnector[] = APP_TOPOLOGY_EDGE_INDEXES.map((index, order) => {
    const hop = OPENING_CONSTELLATION.hops[index];
    if (!hop) throw new Error(`Topology edge index ${index} is outside the canonical geometry`);
    return {
      from: hop.from,
      to: hop.to,
      duration: SKY_DRAW_SECONDS,
      delay: order * SKY_APPEAR_STEP - SKY_APPEAR_STEP,
    };
  });

  const nodeKeys = new Set(
    connectors.flatMap((connector) => [topologyPointKey(connector.from), topologyPointKey(connector.to)])
  );
  const nodes: AmbientNode[] = OPENING_CONSTELLATION.stars
    .filter((node) => nodeKeys.has(topologyPointKey([node.x, node.y])))
    .map((node, index) => {
      const accent = ACCENT_NODE_KEYS.has(topologyPointKey([node.x, node.y]));
      return {
        ...node,
        glyph: accent ? node.glyph : 'dot',
        size: accent ? APP_TOPOLOGY_ICON_SIZE : APP_TOPOLOGY_DOT_SIZE,
        duration: SKY_NODE_MIN_SECONDS + (index % 4) * 6,
        delay: -(index % 6) * 3,
      };
    });

  const renderedNodeKeys = new Set(nodes.map((node) => topologyPointKey([node.x, node.y])));
  const orphan = connectors.find(
    (connector) =>
      !renderedNodeKeys.has(topologyPointKey(connector.from)) || !renderedNodeKeys.has(topologyPointKey(connector.to))
  );
  if (orphan) {
    throw new Error(`Topology edge has no node: ${topologyPointKey(orphan.from)} → ${topologyPointKey(orphan.to)}`);
  }

  return { nodes, connectors };
}

const animationStyle = (timing: Timing): CSSProperties => ({
  animationDuration: `${timing.duration}s`,
  animationDelay: `${timing.delay}s`,
});

export function AppTopology() {
  const drawing = useMemo(() => buildAppTopology(), []);

  return (
    <svg
      className="app-sky"
      data-star-motion-field=""
      data-app-topology=""
      viewBox={`0 0 ${OPENING_CONSTELLATION.width} ${OPENING_CONSTELLATION.height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g data-topology-coordinate-space="">
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
              style={animationStyle(node)}
            >
              <StarGlyphShape star={node} />
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
