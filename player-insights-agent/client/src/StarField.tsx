/**
 * The app-wide ambient sky: stable coordinates, CSS-only motion, and no input.
 *
 * The geometry comes from the opening constellation rather than from a second
 * star map. That matters beyond keeping two drawings visually related. The old
 * app sky selected the first six eligible connectors from a list ordered
 * left-to-right, so every selected line belonged to the upper-left loop and the
 * right side of the login gate was empty. Rendering every shared hop removes
 * the order-dependent sample that caused the defect.
 *
 * JavaScript decides the drawing once. It never advances an animation: every
 * frame is opacity or transform from star-motion.css. The seed combines the
 * page identity with a tab-local value, so React may render the tree repeatedly
 * without moving a star while a new tab still gets a different sky.
 */
import { useState, type CSSProperties } from 'react';
import { OPENING_CONSTELLATION, type Hop } from './constellation';

export type StarSurface = 'ask' | 'working';

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
const GLOW_MIN_SECONDS = 10;
const DRIFT_ANCHOR_SECONDS = 90;
const DRIFT_FAINT_SECONDS = 70;
const JITTER_PX = 6;
const HOPS_PER_SIDE = 6;

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

const DOCUMENT_SEED = documentSeed();

/** One coordinate as a map key, written once so a lookup cannot spell it differently. */
const pointKey = (point: readonly [number, number]): string => `${point[0]},${point[1]}`;

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

  /*
   * Equal samples from the left and right preserve quiet space around the hero
   * without reviving the old order bug. The previous single filtered slice took
   * six from a list whose first seven entries are all upper-left; sampling each
   * side independently is what guarantees the gate has a right-hand chain.
   */
  const leftHops = OPENING_CONSTELLATION.hops
    .filter(
      (hop) =>
        anchored(hop) && (hop.from[0] < OPENING_CONSTELLATION.width / 3 || hop.to[0] < OPENING_CONSTELLATION.width / 3)
    )
    .slice(0, HOPS_PER_SIDE);
  const rightHops = OPENING_CONSTELLATION.hops
    .filter(
      (hop) =>
        anchored(hop) &&
        (hop.from[0] > (OPENING_CONSTELLATION.width * 2) / 3 || hop.to[0] > (OPENING_CONSTELLATION.width * 2) / 3)
    )
    .slice(0, HOPS_PER_SIDE);
  const connectors = [...leftHops, ...rightHops].flatMap((hop) => {
    const from = positions.get(pointKey(hop.from));
    const to = positions.get(pointKey(hop.to));
    if (!from || !to) return [];
    return [
      {
        from,
        to,
        /*
         * The 2–7 second phase window is the connector treatment's stagger. It is
         * negative because first paint must show a line already inside its cycle,
         * never a synchronized row of lines waiting to begin.
         */
        ...timing(random, GLOW_MIN_SECONDS, 3, glowTiming, 2, 7),
      },
    ];
  });

  return {
    anchors,
    faint,
    connectors,
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
  const [visitSeed] = useState(() => seed ?? DOCUMENT_SEED);
  const drawing = buildStarField(pageId, visitSeed);
  const asksForDrift = surface === 'ask';

  return (
    <svg
      className={`app-sky${className ? ` ${className}` : ''}`}
      data-star-motion-field=""
      data-star-surface={surface}
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
        className={asksForDrift ? 'star-motion-drift star-motion-drift-anchor' : undefined}
        style={asksForDrift ? { animationDelay: `${drawing.drift.anchorDelay}s` } : undefined}
      >
        {surface === 'ask' ? (
          <g className="star-motion-connectors">
            {drawing.connectors.map((connector, index) => (
              <line
                key={`line-${index}`}
                className="app-sky-line star-motion-glow"
                x1={connector.from[0]}
                y1={connector.from[1]}
                x2={connector.to[0]}
                y2={connector.to[1]}
                style={animationStyle(connector)}
              />
            ))}
          </g>
        ) : null}

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
        className={asksForDrift ? 'star-motion-drift star-motion-drift-faint' : undefined}
        style={asksForDrift ? { animationDelay: `${drawing.drift.faintDelay}s` } : undefined}
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
