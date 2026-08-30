import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_GUIDE_FILENAME, copyAccessGuideAsset } from './access-guide-asset.mjs';

const EXPECTED_SOURCE_SHA256 = 'a8b862e70b2eb2b60ae4255e0d16f68317fcc5739f127148198860dc5a40a8b9';
const repoRoot = path.resolve(import.meta.dirname, '..');
const source = path.join(repoRoot, 'docs', ACCESS_GUIDE_FILENAME);
const deployed = path.join(repoRoot, 'build', 'deploy', 'assets', ACCESS_GUIDE_FILENAME);
const temporary = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'astrolabe-access-guide-'));
  temporary.push(directory);
  const root = path.join(directory, 'app');
  const outDir = path.join(root, 'build', 'deploy');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  return { root, outDir };
}

describe('access guide deploy asset', () => {
  it('copies the source bytes exactly', async () => {
    const { root, outDir } = await fixture();
    const bytes = Buffer.from('%PDF-1.7\nfixed test guide\n', 'utf8');
    await writeFile(path.join(root, 'docs', ACCESS_GUIDE_FILENAME), bytes);

    const result = await copyAccessGuideAsset({ root, outDir, log: () => undefined });

    expect(result.copied).toBe(true);
    expect(await readFile(path.join(outDir, 'assets', ACCESS_GUIDE_FILENAME))).toEqual(bytes);
  });

  it('skips a public checkout with no source and removes stale output', async () => {
    const { root, outDir } = await fixture();
    await mkdir(path.join(outDir, 'assets'), { recursive: true });
    const destination = path.join(outDir, 'assets', ACCESS_GUIDE_FILENAME);
    await writeFile(destination, 'stale confidential bytes');
    await rm(path.join(root, 'docs', ACCESS_GUIDE_FILENAME), { force: true });

    const result = await copyAccessGuideAsset({ root, outDir, log: () => undefined });

    expect(result.copied).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });

  it('keeps the tracked source byte-identical to the supplied v2 PDF', () => {
    const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
    expect(digest).toBe(EXPECTED_SOURCE_SHA256);
    expect(readFileSync(source)).toHaveLength(542_752);
  });

  it('fails internal checks when the committed deploy copy is absent or different', () => {
    expect(existsSync(source)).toBe(true);
    expect(existsSync(deployed)).toBe(true);
    expect(readFileSync(deployed)).toEqual(readFileSync(source));
  });
});
