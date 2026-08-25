/**
 * The app-wide ambient sky: one drawing for login and every tab, CSS-only motion.
 *
 * The geometry comes from the opening constellation rather than from a second
 * star map. That matters beyond keeping two drawings visually related. The old
 * app sky selected the first six eligible connectors from a list ordered
 * left-to-right, so every selected line belonged to the upper-left loop and the
 * right side of the login gate was empty. Rendering every shared hop removes
 * the order-dependent sample that caused the defect.
 *
 * JavaScript decides the drawing and the appear-schedule once. It never advances
 * a frame: every tick is opacity, transform, or stroke-dashoffset from
 * star-motion.css. Connectors are staggered into the future on purpose -- a
 * line with a positive delay is absent on first paint and draws itself later --
 * which is what "new connections being drawn" is, without a rAF loop that dies
 * when the tab is hidden.
 *
 * Login and the in-app shell share one mounted SVG: `SKY_PAGE_ID` plus the
 * tab-local document seed, held in `useState` so a later render cannot pick a
 * new stagger. Layout is what must not remount this. A new load still gets a
 * different stagger, jitter, and extra hops.
 */
import { useState, type CSSProperties } from 'react';
import { OPENING_CONSTELLATION, type Hop } from './constellation';

export type StarSurface = 'ask' | 'working';

/** Shared by the login gate and the app shell so both mount the same sky. */
export const SKY_PAGE_ID = 'app-sky';

/** Fraction of a connector cycle that the line is on screen (matches ast-sky-draw). */
export const SKY_DRAW_LIVE_UNTIL = 0.7;

interface Timing {
  duration: number;
  delay: number;
}

export interface AmbientStar extends Timing {
  x: number;
  y: number;
}

export interface AmbientConnector extends Timing {
  from: readonly [number, number];
  to: readonly [number, number];
}

export interface StarFieldDrawing {
  anchors: AmbientStar[];
  faint: AmbientStar[];
  connectors: AmbientConnector[];
  drift: {
    anchorDelay: number;
    faintDelay: number;
  };
}

const ANCHOR_MIN_SECONDS = 6;
const FAINT_MIN_SECONDS = 7;
const DRAW_MIN_SECONDS = 22;
const DRAW_SPREAD = 8;
const DRIFT_ANCHOR_SECONDS = 90;
const DRIFT_FAINT_SECONDS = 70;
const JITTER_PX = 6;
const APPEAR_STEP = 1.25;
const EARLY_SHIFT = 2.2;
const EXTRA_HOPS = 6;
const MIN_EXTRA_DIST = 90;
const MAX_EXTRA_DIST = 260;

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

function jitter(value: number, random: () => number): number {
  return tenth(value + (random() * 2 - 1) * JITTER_PX);
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = copy[index];
    copy[index] = copy[swap];
    copy[swap] = held;
  }
  return copy;
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

/** One coordinate as a map key, written once so a lookup cannot spell it differently. */
const pointKey = (point: readonly [number, number]): string => `${point[0]},${point[1]}`;

const edgeKey = (from: readonly [number, number], to: readonly [number, number]): string => {
  const a = pointKey(from);
  const b = pointKey(to);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
};

/**
 * Whether a connector is on screen at `elapsedSeconds` from first paint.
 *
 * Positive delay means the line has not started drawing yet. After it starts,
 * it is live for the first `SKY_DRAW_LIVE_UNTIL` of its cycle -- the draw and
 * hold -- and then hidden until the cycle repeats. This is the schedule a test
 * can advance without a browser.
 */
export function connectorIsLiveAt(connector: AmbientConnector, elapsedSeconds: number): boolean {
  const local = elapsedSeconds - connector.delay;
  if (local < 0) return false;
  const progress = (local % connector.duration) / connector.duration;
  return progress < SKY_DRAW_LIVE_UNTIL;
}

export function liveConnectorsAt(drawing: StarFieldDrawing, elapsedSeconds: number): AmbientConnector[] {
  return drawing.connectors.filter((connector) => connectorIsLiveAt(connector, elapsedSeconds));
}

function appearDelay(index: number, random: () => number, used: Set<string>): Timing {
  for (;;) {
    const duration = tenth(DRAW_MIN_SECONDS + random() * DRAW_SPREAD);
    const delay = tenth(index * APPEAR_STEP - EARLY_SHIFT + (random() * 0.4 - 0.1));
    const key = `${duration}/${delay}`;
    if (!used.has(key)) {
      used.add(key);
      return { duration, delay };
    }
  }
}

function extraHops(
  anchors: AmbientStar[],
  taken: Set<string>,
  random: () => number,
  width: number
): { from: readonly [number, number]; to: readonly [number, number] }[] {
  const candidates: { from: readonly [number, number]; to: readonly [number, number] }[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      const from = [anchors[i].x, anchors[i].y] as const;
      const to = [anchors[j].x, anchors[j].y] as const;
      if (taken.has(edgeKey(from, to))) continue;
      const dist = Math.hypot(from[0] - to[0], from[1] - to[1]);
      if (dist < MIN_EXTRA_DIST || dist > MAX_EXTRA_DIST) continue;
      const minX = Math.min(from[0], to[0]);
      const maxX = Math.max(from[0], to[0]);
      if (minX < width * 0.38 && maxX > width * 0.62) continue;
      candidates.push({ from, to });
    }
  }
  const picked = shuffle(candidates, random).slice(0, EXTRA_HOPS);
  for (const hop of picked) taken.add(edgeKey(hop.from, hop.to));
  return picked;
}

/**
 * Builds one complete sky from the shared opening geometry.
 *
 * Anchor jitter is recorded by source coordinate so connector ends follow the
 * stars they connect. Jittering the two independently leaves visibly detached
 * lines, especially on the sparse right-hand chains where the old bug lived.
 */
export function buildStarField(pageId: string, visitSeed: string | number): StarFieldDrawing {
  const random = mulberry32(hashStarSeed(`${pageId}:${visitSeed}`));
  const starTiming = new Set<string>();
  const glowTiming = new Set<string>();
  const positions = new Map<string, readonly [number, number]>();

  const anchors = OPENING_CONSTELLATION.stars.map((star) => {
    const x = jitter(star.x, random);
    const y = jitter(star.y, random);
    positions.set(pointKey([star.x, star.y]), [x, y]);
    return { x, y, ...timing(random, ANCHOR_MIN_SECONDS, 6, starTiming) };
  });

  /*
   * A hop is only drawable if BOTH of its ends are stars this sky moved.
   *
   * The lookup used to fall back to the hop's own untouched coordinate, so a hop
   * that named a point no star sits on would be drawn to where the star would
   * have been rather than to where it is -- a line ending up to six pixels short
   * of the glyph it is supposed to reach. Nothing in the geometry does that
   * today; requiring the match is what stops the next coordinate edit from
   * reintroducing it silently, and it happens during selection so a rejected hop
   * consumes no timing values.
   */
  const anchored = (hop: Hop) => positions.has(pointKey(hop.from)) && positions.has(pointKey(hop.to));

  const drop = Math.floor(random() * 3);
  const faint = OPENING_CONSTELLATION.backdrop.slice(0, OPENING_CONSTELLATION.backdrop.length - drop).map((star) => ({
    x: jitter(star.x, random),
    y: jitter(star.y, random),
    ...timing(random, FAINT_MIN_SECONDS, 6, starTiming),
  }));

  const third = OPENING_CONSTELLATION.width / 3;
  const leftHops = shuffle(
    OPENING_CONSTELLATION.hops.filter(
      (hop) => anchored(hop) && (hop.from[0] < third || hop.to[0] < third)
    ),
    random
  );
  const rightHops = shuffle(
    OPENING_CONSTELLATION.hops.filter(
      (hop) =>
        anchored(hop) &&
        (hop.from[0] > OPENING_CONSTELLATION.width - third || hop.to[0] > OPENING_CONSTELLATION.width - third)
    ),
    random
  );

  /*
   * Interleave the two sides after a seed shuffle so a session is not always
   * the left polygon first, while still putting a line on both thirds early.
   * Taking every hop -- not six per side -- is what gives later ticks new
   * edges to draw instead of pulsing the same twelve forever.
   */
  const ordered: Hop[] = [];
  for (let index = 0; index < Math.max(leftHops.length, rightHops.length); index += 1) {
    if (index < leftHops.length) ordered.push(leftHops[index]);
    if (index < rightHops.length) ordered.push(rightHops[index]);
  }

  const taken = new Set<string>();
  const hopConnectors: AmbientConnector[] = [];
  for (const hop of ordered) {
    const from = positions.get(pointKey(hop.from));
    const to = positions.get(pointKey(hop.to));
    if (!from || !to) continue;
    taken.add(edgeKey(from, to));
    hopConnectors.push({ from, to, ...appearDelay(hopConnectors.length, random, glowTiming) });
  }

  /*
   * Extra hops continue the appear schedule after the opening chains, so a
   * unique pair starts drawing once the familiar constellations are already
   * on screen. Re-count from the current length rather than a parallel index
   * so a dropped opening hop cannot collide with an extra's delay key.
   */
  const extraConnectors = extraHops(anchors, taken, random, OPENING_CONSTELLATION.width).map((hop, index) => ({
    from: hop.from,
    to: hop.to,
    ...appearDelay(hopConnectors.length + index, random, glowTiming),
  }));

  return {
    anchors,
    faint,
    connectors: [...hopConnectors, ...extraConnectors],
    drift: {
      anchorDelay: -tenth(0.1 + random() * (DRIFT_ANCHOR_SECONDS - 0.1)),
      faintDelay: -tenth(0.1 + random() * (DRIFT_FAINT_SECONDS - 0.1)),
    },
  };
}

const animationStyle = (timingValue: Timing): CSSProperties => ({
  animationDuration: `${timingValue.duration}s`,
  animationDelay: `${timingValue.delay}s`,
});

export function StarField({
  pageId,
  surface,
  seed,
  className,
}: {
  pageId: string;
  surface: StarSurface;
  /** An explicit seed exists for static rendering and deterministic tests. */
  seed?: string | number;
  /** A seating class may change stacking, never the drawing or its motion rules. */
  className?: string;
}) {
  const [visitSeed] = useState(() => seed ?? SKY_DOCUMENT_SEED);
  const drawing = buildStarField(pageId, visitSeed);

  return (
    <svg
      className={`app-sky${className ? ` ${className}` : ''}`}
      data-star-motion-field=""
      data-star-surface={surface}
      data-sky-seed={String(visitSeed)}
      viewBox={`0 0 ${OPENING_CONSTELLATION.width} ${OPENING_CONSTELLATION.height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {/*
       * The chains and the stars on them, in ONE drifting group.
       *
       * THIS IS WHY THE STARS SAT BESIDE THEIR OWN LINES. The connectors were a
       * sibling of the anchor group rather than a child of it, and the anchor
       * group is the one carrying `ast-drift` -- a 14px translate with a negative
       * delay, so the two were already several pixels apart on the first frame and
       * went on separating for the length of a 90 second cycle. Snapping the
       * geometry at build time cannot fix that: the endpoints agree in the
       * viewBox and the transform moves one of them afterwards.
       *
       * Sharing the transform makes an endpoint and its star the same point at
       * every frame, and it holds whatever the drift is doing -- running,
       * stopped, or reset by the reduced-motion guard, which now resets both or
       * neither instead of pulling one group back from under the other.
       */}
      <g
        className="star-motion-drift star-motion-drift-anchor"
        style={{ animationDelay: `${drawing.drift.anchorDelay}s` }}
      >
        <g className="star-motion-connectors">
          {drawing.connectors.map((connector, index) => (
            <line
              key={`line-${index}`}
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

        {drawing.anchors.map((star, index) => (
          <circle
            key={`anchor-${index}`}
            className="app-sky-glyph"
            data-star-motion="anchor"
            cx={star.x}
            cy={star.y}
            r="2"
            opacity="0.7"
            style={animationStyle(star)}
          />
        ))}
      </g>

      <g
        className="star-motion-drift star-motion-drift-faint"
        style={{ animationDelay: `${drawing.drift.faintDelay}s` }}
      >
        {drawing.faint.map((star, index) => (
          <circle
            key={`faint-${index}`}
            className="star-motion-faint"
            cx={star.x}
            cy={star.y}
            r="1.3"
            opacity="0.32"
            style={animationStyle(star)}
          />
        ))}
      </g>
    </svg>
  );
}
