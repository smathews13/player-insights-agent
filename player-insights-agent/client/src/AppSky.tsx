/**
 * Static night-sky dust behind the app in dark mode. Opening-sequence stars,
 * no animation. Glyphs stay in the sky margins so they cannot sit on chrome.
 */
import { OPENING_CONSTELLATION, glyphPath, type Star } from './constellation';

const MARGIN_GLYPHS = new Set(['triangle', 'cross', 'square']);

function inSkyMargin(star: Star): boolean {
  if (!MARGIN_GLYPHS.has(star.glyph)) return false;
  const { width, height } = OPENING_CONSTELLATION;
  return star.x < width * 0.22 || star.x > width * 0.78 || star.y > height * 0.72;
}

export function AppSky() {
  const { width, height, backdrop, stars, hops } = OPENING_CONSTELLATION;
  const glyphs = stars.filter(inSkyMargin);
  return (
    <svg
      className="app-sky"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {hops
        .filter((hop) => hop.from[0] < width * 0.22 || hop.from[0] > width * 0.78)
        .slice(0, 6)
        .map((hop) => (
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
