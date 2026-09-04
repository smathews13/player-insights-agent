import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ICON_FILES, INK, PLATE, iconPng, iconSvg } from './app-icons.mts';

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
const CLIENT_DIST = path.resolve(fileURLToPath(new URL('../client/dist', import.meta.url)));

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
    expect(html).not.toMatch(/href="\/(?:favicon|apple-touch-icon)[^"]*"/);
    expect(manifest.icons).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ src: expect.stringMatching(/^\/favicon-/) })])
    );
  });

  it('names the app rather than the partner in the manifest and the title', async () => {
    const html = await readFile(INDEX, 'utf8');
    const manifest = JSON.parse(await readFile(path.join(PUBLIC_DIR, 'site.webmanifest'), 'utf8'));

    expect(html).toContain('<title>Player Insights Agent</title>');
    expect(manifest.name).toEqual('Player Insights Agent');
    expect(manifest.short_name).toEqual('PIA');
  });

  it('declares each size the file it points at is actually drawn at', async () => {
    for (const [name, { size }] of Object.entries(ICON_FILES)) {
      const { width, height } = await decode(await committed(name));
      expect([name, width, height]).toEqual([name, size, size]);
    }
  });

  it('emits the exact icon declarations and files in the Vite production artifact', async () => {
    const sourceHtml = await readFile(INDEX, 'utf8');
    const deployedHtml = await readFile(path.join(CLIENT_DIST, 'index.html'), 'utf8');
    const deployedManifest = JSON.parse(await readFile(path.join(CLIENT_DIST, 'site.webmanifest'), 'utf8'));

    for (const name of Object.keys(ICON_FILES)) {
      expect(await readFile(path.join(CLIENT_DIST, name)), name).toEqual(await committed(name));
    }
    for (const href of sourceHtml.matchAll(/href="(\/pia-dpad-[^"]+\.png)"/g)) {
      expect(deployedHtml, href[1]).toContain(`href="${href[1]}"`);
    }
    expect(deployedManifest.icons).toEqual([
      expect.objectContaining({ src: '/pia-dpad-app-192x192.png', type: 'image/png' }),
      expect.objectContaining({ src: '/pia-dpad-app-512x512.png', type: 'image/png' }),
    ]);
  });
});

describe('every icon is the PIA D-pad on its plate, not a lettered tile', () => {
  it('puts the accent at the centre, where the mark’s blue is', async () => {
    // The discriminator against what was there before: the plate that read
    // "T2" was navy and white and carried no colour at all, so a blue centre
    // cannot be produced by any arrangement of two characters.
    for (const [name, { size }] of Object.entries(ICON_FILES)) {
      const { raw } = await decode(await committed(name));
      const [red, green, blue, alpha] = pixel(raw, size, 0.5, 0.5);

      expect([name, alpha]).toEqual([name, 255]);
      // Stated as a relation rather than as the exact hex because the centre of
      // a 16px tile is one antialiased pixel of a 1px-radius circle. The
      // relation holds at every size; the hex only holds at the large ones.
      expect(blue - red, name).toBeGreaterThan(size === 16 ? 30 : 60);
      expect(blue - green, name).toBeGreaterThan(size === 16 ? 12 : 20);
    }
  });

  it('sets the mark on the navy plate, with the plate’s corners cut', async () => {
    for (const [name, { size }] of Object.entries(ICON_FILES)) {
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
    for (const [name, { size }] of Object.entries(ICON_FILES).filter(([, spec]) => spec.size >= 48)) {
      const { raw } = await decode(await committed(name));
      // A third of the way down the vertical bar of the d-pad, on the centre line.
      expect(apart(pixel(raw, size, 0.5, 0.36).slice(0, 3), rgb(INK)), `${name} cross`).toBeLessThan(24);
    }
  });

  it('uses the static simplified D-pad for every tab density and engraves only large app seats', () => {
    const faceGlyphs = ['M32 12.5 L35.5 18.5 H28.5 Z', 'cx="47.5"', 'M29.5 45.5 L34.5 50.5'];
    for (const { size, cut } of Object.values(ICON_FILES).filter((spec) => spec.cut === 'simplified')) {
      const svg = iconSvg(size, cut);
      for (const glyph of faceGlyphs) expect(svg).not.toContain(glyph);
      expect(svg).not.toMatch(/<animate|<set|<script/i);
    }
    expect(iconSvg(192, 'engraved')).toContain(faceGlyphs[0]);
  });

  it('encodes every committed browser icon as one static PNG frame', async () => {
    for (const name of Object.keys(ICON_FILES)) {
      const metadata = await sharp(await committed(name)).metadata();
      expect(metadata.format, name).toBe('png');
      expect(metadata.pages ?? 1, name).toBe(1);
    }
  });
});

describe('the committed icons are what the mark’s own geometry produces', () => {
  it('matches a fresh render of pia-mark.ts at every size', async () => {
    for (const [name, { size, cut }] of Object.entries(ICON_FILES)) {
      const [was, is] = await Promise.all([decode(await committed(name)), decode(await iconPng(size, cut))]);

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
