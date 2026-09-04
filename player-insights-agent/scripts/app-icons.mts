/**
 * The app icons: the PIA simplified/engraved D-pad on its navy plate.
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
 * AT ALL. Every coordinate comes from `piaMarkElements` in
 * client/src/pia-mark.ts -- the same array the component renders, pinned
 * to the delivered PIA SVGs by pia-mark.test.tsx. So "never redraw, never
 * restroke" holds here by construction rather than by a second person's care:
 * there is no copy of the mark in this file to drift, and a change to the
 * delivered artwork reaches the favicon by regenerating rather than by
 * somebody remembering that the favicon exists.
 *
 * The size decides the drawing, exactly as it does on screen: `piaMarkElements`
 * hands back the simplified cut below 24px, so the 16px tab icon drops the
 * engraved glyphs rather than rendering them as a grey smudge. It is asked for
 * the size the MARK is drawn at, not the size of
 * the tile it sits on, which is why MARK_SPAN is applied before the call.
 *
 * WHY A PLATE AT ALL, given the delivered SVGs are ink on transparency. A tab
 * strip is a surface the app does not control and does not know the colour of.
 * The navy plate is the mark's dark seating from pia-brand.css --
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

import { PIA_MARK_VIEWBOX, piaMarkElements, type PiaMarkElement, type PiaMarkPaint } from '../client/src/pia-mark.ts';

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

/** The dark-surface PIA inks. Engravings cut back into the navy plate. */
export const INK = '#ffffff';
export const ACCENT = '#6faedd';
export const ENGRAVING = PLATE;

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

function paint(which: PiaMarkPaint | undefined): string | undefined {
  if (!which) return undefined;
  if (which === 'ink') return INK;
  if (which === 'accent') return ACCENT;
  return ENGRAVING;
}

/** One element of the mark, as SVG. */
function element(shape: PiaMarkElement): string {
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
    push('opacity', shape.opacity ?? (shape.stroke === 'engraving' ? 0.35 : undefined));
    return `<circle ${attrs.join(' ')} />`;
  }

  if (shape.kind === 'rect') {
    push('x', shape.x);
    push('y', shape.y);
    push('width', shape.width);
    push('height', shape.height);
    push('rx', shape.rx);
    push('fill', paint(shape.fill) ?? 'none');
    push('stroke', paint(shape.stroke));
    push('stroke-width', shape.strokeWidth);
    push('opacity', shape.opacity ?? (shape.stroke === 'engraving' ? 0.35 : undefined));
    return `<rect ${attrs.join(' ')} />`;
  }

  push('d', shape.d);
  push('fill', paint(shape.fill) ?? 'none');
  push('stroke', paint(shape.stroke));
  push('stroke-width', shape.strokeWidth);
  push('stroke-dasharray', shape.dash);
  push('stroke-linecap', shape.linecap);
  push('stroke-linejoin', shape.linejoin);
  push('opacity', shape.opacity ?? (shape.stroke === 'engraving' ? 0.35 : undefined));
  return `<path ${attrs.join(' ')} />`;
}

/**
 * The icon at one size, as SVG.
 *
 * The mark keeps its own 64-unit grid and is placed by a transform, so nothing
 * here rescales a coordinate by hand -- the numbers in the output are the
 * numbers in pia-mark.ts, which is what makes a diff of this readable
 * against the delivered file.
 */
export function iconSvg(size: number): string {
  const drawn = Math.round(size * MARK_SPAN);
  const inset = (PIA_MARK_VIEWBOX * (1 - MARK_SPAN)) / 2;
  const shapes = piaMarkElements(drawn, 'dpad').map(element).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${PIA_MARK_VIEWBOX} ${PIA_MARK_VIEWBOX}" fill="none">`,
    `<rect width="${PIA_MARK_VIEWBOX}" height="${PIA_MARK_VIEWBOX}" rx="${PIA_MARK_VIEWBOX * PLATE_CORNER}" fill="${PLATE}" />`,
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
  return sharp(Buffer.from(svg)).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
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
