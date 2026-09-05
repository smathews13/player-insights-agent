/**
 * A constellation drawing itself: connectors on `ast-draw`, stars on `ast-pop`.
 *
 * One renderer for the splash and working strip, so a star pops the same way in
 * both. The coordinates are `constellation.ts`.
 *
 * DECORATIVE, ENTIRELY. The whole SVG is `aria-hidden`, and the surface that
 * seats it carries the one `aria-live="polite"` string that says what is
 * happening (§5). Twelve connectors and twenty stars narrating at once say less
 * than nothing.
 *
 * Under `prefers-reduced-motion: reduce` the guard at the foot of
 * astrolabe-animation.css freezes every `ast-anim-*` class AND gives it its rest
 * state, because four of these animations begin at opacity 0 -- `animation: none`
 * alone would leave a reader who asked for less motion looking at an empty navy
 * panel rather than at a still constellation.
 */
import {
  PRODUCT_GLYPHS,
  glyphPath,
  glyphTakesAccent,
  hopPath,
  type Constellation as ConstellationShape,
  type Star,
  type StarGlyph,
} from './constellation';

import { BRAND_THEME_MARKS, type BrandProduct } from './brand-icons';
import { PiaDrawing } from './PiaMark';
import { PIA_DPAD_ENGRAVED, PIA_MARK_VIEWBOX } from './pia-mark';

/**
 * The recoloured product icons, which are the `dark` cut because every seating
 * of a constellation is a navy band.
 *
 * READ OUT OF `brand-icons.ts` RATHER THAN IMPORTED FROM THE DIRECTORY. That
 * module is the app's one pairing of product to drawing, and a component that
 * resolves `assets/logo/theme/genie-blue.svg` for itself has made a second one:
 * the two are never on screen together for anybody to notice they disagree, and
 * this one has the extra hazard of picking a tone the surface is not.
 * `brand-icons.test.tsx` refuses the direct import, and it is right to.
 *
 * The theme cut and never `assets/brand/`: those copies are #6FAEDD over
 * #B7D6EE, and §2 permits exactly two full-colour Databricks assets in the
 * product -- the top bar's bricks symbol and the login gate's logo. A star in a
 * night sky is neither.
 */
const PRODUCT_STARS: Partial<Record<StarGlyph, BrandProduct>> = {
  'databricks-sql': 'databricks-sql',
  genie: 'genie',
  'mosaic-ai': 'mosaic-ai',
  'unity-catalog': 'unity-catalog',
};

/**
 * One product's artwork as something `<image href>` can take.
 *
 * The map holds markup, because everywhere else in the app a product mark is
 * inlined into the document and coloured by the surface. Here it is a star
 * inside another SVG, positioned by the constellation's own coordinates, so it
 * stays an `<image>` and the markup becomes its source. `encodeURIComponent`
 * rather than base64: the payload is text either way, and a data URI that can
 * be read in a devtools panel is worth the handful of extra bytes.
 */
function starHref(glyph: StarGlyph): string | null {
  const product = PRODUCT_STARS[glyph];
  if (!product) return null;
  return `data:image/svg+xml,${encodeURIComponent(BRAND_THEME_MARKS.dark[product])}`;
}

/**
 * The static engraved identity mark in a constellation's own coordinate space.
 * Its nested viewBox scales the canonical 64-unit geometry without rewriting
 * any path, and its center remains exactly on the connector endpoint.
 */
function DpadStarShape({ star }: { star: Star }) {
  return (
    <svg
      className="pia-mark pia-mark--dark ast-dpad-star"
      data-pia-topology-mark=""
      x={star.x - star.size}
      y={star.y - star.size}
      width={star.size * 2}
      height={star.size * 2}
      viewBox={`0 0 ${PIA_MARK_VIEWBOX} ${PIA_MARK_VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
      overflow="visible"
    >
      <PiaDrawing elements={PIA_DPAD_ENGRAVED} />
    </svg>
  );
}

/**
 * The one renderer for a topology node, whether it is used by a compact
 * progress constellation or by the viewport-wide ambient topology.
 */
export function StarGlyphShape({ star }: { star: Star }) {
  if (PRODUCT_GLYPHS.includes(star.glyph)) {
    const href = starHref(star.glyph);
    if (!href) return null;
    return (
      <image href={href} x={star.x - star.size} y={star.y - star.size} width={star.size * 2} height={star.size * 2} />
    );
  }
  if (star.glyph === 'dot') {
    return <circle cx={star.x} cy={star.y} r={star.size} className="ast-star-ink" opacity={star.opacity} />;
  }
  if (star.glyph === 'dpad' || star.glyph === 'sparkle') {
    return <DpadStarShape star={star} />;
  }
  const path = glyphPath(star);
  if (!path) return null;
  const accent = glyphTakesAccent(star.glyph);
  // The remaining game buttons are line drawings, and the stroke width scales
  // with the glyph so a 4-unit cross in a 56px strip is not a hairline.
  return (
    <path
      d={path}
      className={accent ? 'ast-star-accent' : 'ast-star-ink-stroke'}
      strokeWidth={Math.max(1.6, +(star.size * 0.36).toFixed(2))}
      strokeLinecap={star.glyph === 'triangle' ? undefined : 'round'}
      strokeLinejoin={star.glyph === 'triangle' ? 'round' : undefined}
      fill="none"
    />
  );
}

export function ConstellationField({ shape, className }: { shape: ConstellationShape; className?: string }) {
  const loop = `${shape.loopSeconds}s`;
  return (
    <svg
      className={`ast-constellation ${className ?? ''}`.trim()}
      width={shape.width}
      height={shape.height}
      viewBox={`0 0 ${shape.width} ${shape.height}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* The connectors. `pathLength="1"` with `stroke-dasharray="1"` is what
          lets ONE keyframe draw lines of every length: the offset runs 1 to 0 in
          normalised units, so a short spur and a long chain finish together. */}
      <g className="ast-constellation-lines" style={{ opacity: shape.lineOpacity }}>
        {shape.hops.map((hop) => (
          <path
            key={`${hop.from.join()}-${hop.to.join()}`}
            className="ast-anim-draw"
            d={hopPath(hop)}
            pathLength={1}
            strokeDasharray={1}
            style={{ animationDuration: loop, animationDelay: `${hop.delay}s` }}
          />
        ))}
      </g>
      {/* Each star pops as its connector reaches it. The transform origin is the
          star's own centre, or the 1.25 overshoot pulls it towards the panel's
          corner instead of growing in place. */}
      {shape.stars.map((star) => (
        <g
          key={`${star.x}-${star.y}`}
          className="ast-anim-pop"
          style={{
            transformOrigin: `${star.x}px ${star.y}px`,
            animationDuration: loop,
            animationDelay: `${star.delay}s`,
          }}
        >
          <StarGlyphShape star={star} />
        </g>
      ))}
      {/* The sky behind the chains: fixed, dim, and never animated. Without it
          the panel reads as a diagram on a dark rectangle rather than as a night
          sky with a constellation in it. */}
      {shape.backdrop.map((dot) => (
        <circle
          key={`${dot.x}-${dot.y}`}
          cx={dot.x}
          cy={dot.y}
          r={1.3}
          className="ast-star-ink"
          opacity={dot.opacity}
        />
      ))}
    </svg>
  );
}
