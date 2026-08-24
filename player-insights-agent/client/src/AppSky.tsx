/**
 * Static night-sky dust behind the app in dark mode. Opening-sequence stars,
 * no animation. Glyphs stay in the sky margins so they cannot sit on chrome.
 */
import { OPENING_CONSTELLATION, glyphPath, type Hop, type Star } from './constellation';

const MARGIN_GLYPHS = new Set(['triangle', 'circle', 'cross', 'square']);
const HOPS_PER_SIDE = 6;

function inSkyMargin(star: Star): boolean {
  if (!MARGIN_GLYPHS.has(star.glyph)) return false;
  const { width, height } = OPENING_CONSTELLATION;
  return star.x < width * 0.22 || star.x > width * 0.78 || star.y > height * 0.72;
}

/**
 * A balanced sample of the opening sky's left and right chains.
 *
 * The old renderer filtered the whole ordered hop list and then took its first
 * six entries. `OPENING_CONSTELLATION` is grouped left-to-right, so all six came
 * from the upper-left loop and the right half received no connectors at all.
 * Sample each edge independently, and count a line that ARRIVES in the margin:
 * the first upper-right hop starts just inside the cutoff and is part of the
 * same visible chain as the three that follow it.
 */
function appSkyHops(hops: readonly Hop[]): Hop[] {
  const { width } = OPENING_CONSTELLATION;
  const left = hops.filter((hop) => hop.from[0] < width * 0.22 || hop.to[0] < width * 0.22).slice(0, HOPS_PER_SIDE);
  const right = hops.filter((hop) => hop.from[0] > width * 0.78 || hop.to[0] > width * 0.78).slice(0, HOPS_PER_SIDE);
  return [...left, ...right];
}

export function AppSky() {
  const { width, height, backdrop, stars, hops } = OPENING_CONSTELLATION;
  const glyphs: Star[] = [
    ...stars.filter(inSkyMargin),
    /*
     * Inside the right third rather than against the viewBox edge. The SVG
     * slices at narrow aspect ratios, so the old `width - 36` circle was the
     * first decoration cropped away on the screen that most needed its weight.
     */
    { x: width * 0.86, y: height * 0.58, glyph: 'circle', delay: 0, size: 5, opacity: 0.55 },
  ];
  return (
    <svg
      className="app-sky"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {appSkyHops(hops).map((hop) => (
        <line
          key={`${hop.from.join()}-${hop.to.join()}`}
          className="app-sky-line"
          x1={hop.from[0]}
          y1={hop.from[1]}
          x2={hop.to[0]}
          y2={hop.to[1]}
        />
      ))}
      {backdrop.map((dot) => (
        <circle key={`${dot.x}-${dot.y}`} cx={dot.x} cy={dot.y} r={1.3} fill="#ffffff" opacity={dot.opacity} />
      ))}
      {stars
        .filter((star) => star.glyph === 'dot')
        .map((star) => (
          <circle
            key={`a-${star.x}-${star.y}`}
            cx={star.x}
            cy={star.y}
            r={2}
            fill="#ffffff"
            opacity={star.opacity ?? 0.7}
          />
        ))}
      {glyphs.map((star) => {
        if (star.glyph === 'circle') {
          return (
            <circle key={`g-${star.x}-${star.y}`} className="app-sky-glyph" cx={star.x} cy={star.y} r={star.size} />
          );
        }
        if (star.glyph === 'square') {
          return (
            <rect
              key={`g-${star.x}-${star.y}`}
              className="app-sky-glyph"
              x={star.x - star.size}
              y={star.y - star.size}
              width={star.size * 2}
              height={star.size * 2}
            />
          );
        }
        const d = glyphPath(star);
        return d ? <path key={`g-${star.x}-${star.y}`} className="app-sky-glyph" d={d} /> : null;
      })}
    </svg>
  );
}
