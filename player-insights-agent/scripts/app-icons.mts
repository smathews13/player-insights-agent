/**
 * The app icons: the astrolabe mark, at every size a browser asks for.
 *
 *     npx tsx scripts/app-icons.mts            # rewrite client/public
 *     npx tsx scripts/app-icons.mts --out /tmp # somewhere else, to compare
 *
 * The tab used to show a dark plate with "T2" on it, which was the partner's
 * initials standing in for an app that had no identity of its own. It has one:
 * the header, the login gate, the loaders and the agent chips all draw the
 * d-pad, and the tab was the last surface still naming the customer instead.
 *
 * DRAWN FROM THE APP'S OWN GEOMETRY, WHICH IS THE POINT OF THIS FILE EXISTING
 * AT ALL. Every coordinate comes from `markElements` in
 * client/src/astrolabe-mark.ts -- the same array the component renders, pinned
 * to the delivered SVGs by astrolabe-mark.test.ts. So "never redraw, never
 * restroke" holds here by construction rather than by a second person's care:
 * there is no copy of the mark in this file to drift, and a change to the
 * delivered artwork reaches the favicon by regenerating rather than by
 * somebody remembering that the favicon exists.
 *
 * The size decides the drawing, exactly as it does on screen: `markElements`
 * hands back the small cut below 32px, so the 16px tab icon drops the
 * graduation ring and thickens the rim rather than rendering a 1.3-wide dash as
 * a grey smudge. It is asked for the size the MARK is drawn at, not the size of
 * the tile it sits on, which is why MARK_SPAN is applied before the call.
 *
 * WHY A PLATE AT ALL, given the delivered SVGs are ink on transparency. A tab
 * strip is a surface the app does not control and does not know the colour of.
 * The navy plate is the mark's `dark` seating from astrolabe-mark.css --
 * white structure, #6FAEDD accents -- which is a seating the design already
 * has, and it reads on a light strip and a dark one alike. Ink on transparency
 * reads on exactly one of them, and Chrome's dark chrome is the one it loses.
 * The plate also keeps the tab's silhouette unchanged: the rounded dark square
 * that was there yesterday, with this app's mark on it instead of a customer's
 * initials.
 *
 * Rasterised with `sharp`, which is already a devDependency. It is a build-time
 * tool and nothing ships it: the six PNGs it writes are committed, and
 * client/public is copied verbatim into client/dist by vite.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sharp from 'sharp';

import { MARK_VIEWBOX, markElements, type MarkElement, type MarkPaint } from '../client/src/astrolabe-mark.ts';

/**
 * The six files, and the size each is drawn at.
 *
 * These names are resolved by client/index.html and client/public/site.webmanifest,
 * so the set is theirs rather than this script's: every one of them must exist
 * or a `<link>` resolves to nothing. app-icons.test.ts reads both files and
 * fails if this table and they disagree.
 */
export const ICON_FILES: Readonly<Record<string, number>> = {
  'favicon-16x16.png': 16,
  'favicon-32x32.png': 32,
  'favicon-48x48.png': 48,
  'apple-touch-icon.png': 180,
  'favicon-192x192.png': 192,
  'favicon-512x512.png': 512,
};

/** `--ast-navy`. The plate, and the surface the mark's `dark` seating is drawn for. */
export const PLATE = '#11171c';

/** `--ast-white` and `--ast-blue-on-dark`, which is `.ast-mark--dark` in astrolabe-mark.css. */
export const INK = '#ffffff';
export const ACCENT = '#6faedd';

/**
 * The plate's corner, as a fraction of the tile.
 *
 * 8 / 30 is `--radius-md` at the size the header draws a plate, and it is the
 * corner the tab has had all along. Keeping it means this change swaps the
 * artwork on the tile without also moving the tile, which is one difference for
 * a reader to notice rather than two.
 */
export const PLATE_CORNER = 8 / 30;

/**
 * How much of the tile the mark spans.
 *
 * The delivered drawing already carries about 10% of padding inside its own
 * viewBox (the rim reaches 28.75 of 32), so this is the padding a plate adds on
 * top: 0.84 puts the rim at 0.377 of the tile from its centre, clear of the
 * rounded corners at every size. It is also what decides which cut is drawn --
 * see the `markElements` call below.
 */
export const MARK_SPAN = 0.84;

/**
 * Supersampling factor for the rasteriser.
 *
 * librsvg antialiases well at any size, but a 16px tile has one device pixel
 * per 4 units of the mark's grid, and the accent dots are 7 units across.
 * Rendering at 4x and averaging down is what keeps them as dots rather than as
 * four grey pixels.
 */
const SUPERSAMPLE = 4;

function paint(which: MarkPaint | undefined): string | undefined {
  if (!which) return undefined;
  return which === 'ink' ? INK : ACCENT;
}

/** One element of the mark, as SVG. The dpad and its small cut are circles and rects only. */
function element(shape: MarkElement): string {
  const attrs: string[] = [];
  const push = (name: string, value: string | number | undefined) => {
    if (value !== undefined) attrs.push(`${name}="${value}"`);
  };

  if (shape.kind === 'circle') {
    push('cx', shape.cx);
    push('cy', shape.cy);
    push('r', shape.r);
    push('fill', paint(shape.fill) ?? 'none');
    push('stroke', paint(shape.stroke));
    push('stroke-width', shape.strokeWidth);
    push('stroke-dasharray', shape.dash);
    push('opacity', shape.opacity);
    return `<circle ${attrs.join(' ')} />`;
  }

  if (shape.kind === 'rect') {
    push('x', shape.x);
    push('y', shape.y);
    push('width', shape.width);
    push('height', shape.height);
    push('rx', shape.rx);
    push('fill', paint(shape.fill));
    return `<rect ${attrs.join(' ')} />`;
  }

  // Paths and groups belong to the three archive concepts, which the flicker
  // loaders seat and an app icon never does. Refusing is better than drawing
  // half a mark if `markElements` is ever asked for one of them.
  throw new Error(`the app icon draws the d-pad, which has no ${shape.kind} in it`);
}

/**
 * The icon at one size, as SVG.
 *
 * The mark keeps its own 64-unit grid and is placed by a transform, so nothing
 * here rescales a coordinate by hand -- the numbers in the output are the
 * numbers in astrolabe-mark.ts, which is what makes a diff of this readable
 * against the delivered file.
 */
export function iconSvg(size: number): string {
  const drawn = Math.round(size * MARK_SPAN);
  const inset = (MARK_VIEWBOX * (1 - MARK_SPAN)) / 2;
  const shapes = markElements(drawn, 'dpad').map(element).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}" fill="none">`,
    `<rect width="${MARK_VIEWBOX}" height="${MARK_VIEWBOX}" rx="${MARK_VIEWBOX * PLATE_CORNER}" fill="${PLATE}" />`,
    `<g transform="translate(${inset} ${inset}) scale(${MARK_SPAN})">${shapes}</g>`,
    '</svg>',
  ].join('');
}

/** The icon at one size, as PNG bytes. */
export async function iconPng(size: number): Promise<Buffer> {
  const svg = iconSvg(size).replace(
    `width="${size}" height="${size}"`,
    `width="${size * SUPERSAMPLE}" height="${size * SUPERSAMPLE}"`
  );
  return sharp(Buffer.from(svg))
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../client/public', import.meta.url)));

async function main(): Promise<number> {
  const flag = process.argv.indexOf('--out');
  const out = flag === -1 ? PUBLIC_DIR : path.resolve(process.argv[flag + 1]);
  await mkdir(out, { recursive: true });
  for (const [name, size] of Object.entries(ICON_FILES)) {
    const png = await iconPng(size);
    await writeFile(path.join(out, name), png);
    console.log(`${String(png.length).padStart(7)} bytes  ${name}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  process.exitCode = await main();
}
