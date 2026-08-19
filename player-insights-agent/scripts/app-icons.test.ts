import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ACCENT, ICON_FILES, INK, PLATE, iconPng } from './app-icons.mts';

/**
 * The tab shows this app's mark, and it shows the mark the app draws elsewhere.
 *
 * Two separate claims, and the second is the one that needed a test. The tab
 * carried a plate reading "T2" for as long as the app had no identity of its
 * own -- the partner's initials, on the one surface a reader sees before any of
 * ours has painted. Replacing the artwork fixes that once; what keeps it fixed
 * is that the committed PNGs are checked against what `astrolabe-mark.ts`
 * produces, so an icon set that drifts from the mark fails here rather than in
 * somebody's browser tab a release later.
 *
 * COMPARED AS PIXELS, WITH A TOLERANCE, RATHER THAN AS BYTES. A byte
 * comparison would pin the encoder as well as the drawing, and libvips moves
 * its antialiasing across releases -- so a `sharp` bump that changed nothing
 * about the artwork would fail this file and cost somebody a regeneration to
 * find that out. The tolerance below is far tighter than any difference between
 * two marks and far looser than the difference between two rasterisers.
 *
 * What this cannot say is that the icon is legible at 16px on a dark tab strip.
 * That needs an eye, and it had one when these were drawn.
 */

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../client/public', import.meta.url)));
const INDEX = path.resolve(fileURLToPath(new URL('../client/index.html', import.meta.url)));

/** `#rrggbb` as the three channels sharp hands back. */
function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

/** One pixel of a decoded icon, as RGBA, addressed in fractions of the tile. */
function pixel(raw: Buffer, size: number, atX: number, atY: number): [number, number, number, number] {
  const x = Math.min(size - 1, Math.floor(size * atX));
  const y = Math.min(size - 1, Math.floor(size * atY));
  const offset = (y * size + x) * 4;
  return [raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]];
}

/** How far apart two colours are, as the largest single-channel difference. */
function apart(a: readonly number[], b: readonly number[]): number {
  return Math.max(...b.map((channel, at) => Math.abs(channel - a[at])));
}

async function decode(bytes: Buffer): Promise<{ raw: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { raw: data, width: info.width, height: info.height };
}

const committed = async (name: string) => readFile(path.join(PUBLIC_DIR, name));

describe('the icon set is the one the app’s markup asks for', () => {
  it('writes every file index.html and the manifest resolve, and no others', async () => {
    // The set belongs to the markup, not to the script: a name here that the
    // markup does not ask for is a file nobody serves, and a name there that is
    // missing here is a `<link>` resolving to nothing.
    const html = await readFile(INDEX, 'utf8');
    const manifest = JSON.parse(await readFile(path.join(PUBLIC_DIR, 'site.webmanifest'), 'utf8'));

    const asked = new Set([
      ...[...html.matchAll(/href="\/([\w-]+\.png)"/g)].map((match) => match[1]),
      ...manifest.icons.map((icon: { src: string }) => icon.src.replace(/^\//, '')),
    ]);

    expect([...asked].sort()).toEqual(Object.keys(ICON_FILES).sort());
  });

  it('names the app rather than the partner in the manifest and the title', async () => {
    const html = await readFile(INDEX, 'utf8');
    const manifest = JSON.parse(await readFile(path.join(PUBLIC_DIR, 'site.webmanifest'), 'utf8'));

    expect(html).toContain('<title>astrolabe</title>');
    expect(manifest.name).toEqual('astrolabe');
    expect(manifest.short_name).toEqual('astrolabe');
  });

  it('declares each size the file it points at is actually drawn at', async () => {
    for (const [name, size] of Object.entries(ICON_FILES)) {
      const { width, height } = await decode(await committed(name));
      expect([name, width, height]).toEqual([name, size, size]);
    }
  });
});

describe('every icon is the astrolabe mark on its plate, not a lettered tile', () => {
  it('puts the accent at the centre, where the mark’s blue is', async () => {
    // The discriminator against what was there before: the plate that read
    // "T2" was navy and white and carried no colour at all, so a blue centre
    // cannot be produced by any arrangement of two characters.
    for (const [name, size] of Object.entries(ICON_FILES)) {
      const { raw } = await decode(await committed(name));
      const [red, green, blue, alpha] = pixel(raw, size, 0.5, 0.5);

      expect([name, alpha]).toEqual([name, 255]);
      // Stated as a relation rather than as the exact hex because the centre of
      // a 16px tile is one antialiased pixel of a 1px-radius circle. The
      // relation holds at every size; the hex only holds at the large ones.
      expect(blue - red, name).toBeGreaterThan(60);
      expect(blue - green, name).toBeGreaterThan(20);
    }
  });

  it('sets the mark on the navy plate, with the plate’s corners cut', async () => {
    for (const [name, size] of Object.entries(ICON_FILES)) {
      const { raw } = await decode(await committed(name));

      // Above the mark's rim and inside the plate.
      expect(apart(pixel(raw, size, 0.5, 0.04).slice(0, 3), rgb(PLATE)), `${name} plate`).toBeLessThan(12);
      // The corner is outside the rounded plate, so there is nothing there.
      expect(pixel(raw, size, 0, 0)[3], `${name} corner`).toBeLessThan(128);
    }
  });

  it('draws the cross in white, which is the mark’s dark seating', async () => {
    // Only above 32px. Below it the cross is two device pixels wide and every
    // one of them is antialiased against the plate, so a colour read there
    // measures the rasteriser rather than the drawing.
    for (const [name, size] of Object.entries(ICON_FILES).filter(([, at]) => at >= 48)) {
      const { raw } = await decode(await committed(name));
      // A third of the way down the vertical bar of the d-pad, on the centre line.
      expect(apart(pixel(raw, size, 0.5, 0.36).slice(0, 3), rgb(INK)), `${name} cross`).toBeLessThan(24);
    }
  });

  it('inks the quadrant dots in the accent the dark seating uses', async () => {
    // 41.5 / 64 of the mark, which is inset by 8% of the tile and spans 84% of
    // it: 0.08 + 0.84 * (41.5 / 64). The dots are the first thing a redraw
    // moves and the last thing anybody looks at.
    const at = 0.08 + 0.84 * (41.5 / 64);
    for (const [name, size] of Object.entries(ICON_FILES).filter(([, drawn]) => drawn >= 180)) {
      const { raw } = await decode(await committed(name));
      expect(apart(pixel(raw, size, at, 1 - at).slice(0, 3), rgb(ACCENT)), `${name} dot`).toBeLessThan(24);
    }
  });
});

describe('the committed icons are what the mark’s own geometry produces', () => {
  it('matches a fresh render of astrolabe-mark.ts at every size', async () => {
    for (const [name, size] of Object.entries(ICON_FILES)) {
      const [was, is] = await Promise.all([decode(await committed(name)), decode(await iconPng(size))]);

      expect([name, is.width, is.height]).toEqual([name, was.width, was.height]);

      let total = 0;
      for (let at = 0; at < was.raw.length; at += 1) total += Math.abs(was.raw[at] - is.raw[at]);
      // Averaged over every channel of every pixel. Two rasterisers disagreeing
      // about an edge move this by a fraction of a level; two different
      // drawings move it by tens.
      expect(total / was.raw.length, `${name} mean channel difference`).toBeLessThan(2);
    }
  });
});
