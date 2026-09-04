import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCESS_GUIDE_FILENAME, copyAccessGuideAsset } from './access-guide-asset.mjs';

const EXPECTED_SOURCE_SHA256 = '85c82898d728b26dba1b9305e27e78520987a13529bf86b1729c6873e924fba9';
const EXPECTED_SOURCE_BYTES = 78_714;
const repoRoot = path.resolve(import.meta.dirname, '..');
const source = path.join(repoRoot, 'docs', ACCESS_GUIDE_FILENAME);
const deployed = path.join(repoRoot, 'build', 'deploy', 'assets', ACCESS_GUIDE_FILENAME);
const publishExclusions = readFileSync(path.join(repoRoot, '..', 'mirror', 'publish-exclude.txt'), 'utf8');
const temporary = [];

function classifyAssetPair(sourceBytes, deployedBytes) {
  if (sourceBytes === undefined && deployedBytes === undefined) return 'both-absent';
  if (sourceBytes !== undefined && deployedBytes === undefined) return 'source-only';
  if (sourceBytes === undefined && deployedBytes !== undefined) return 'deploy-only';
  return 'both-present';
}

function validateAssetPair({
  sourceBytes,
  deployedBytes,
  expectedBytes = EXPECTED_SOURCE_BYTES,
  expectedSha256 = EXPECTED_SOURCE_SHA256,
}) {
  const state = classifyAssetPair(sourceBytes, deployedBytes);
  if (state === 'both-absent') {
    return { state, reason: 'Public checkouts intentionally omit both confidential PDF copies.' };
  }
  if (state === 'source-only') {
    throw new Error('Access guide source exists but the deploy copy is absent.');
  }
  if (state === 'deploy-only') {
    throw new Error('Access guide deploy copy exists without its confidential source.');
  }

  if (!sourceBytes.subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii'))) {
    throw new Error('Access guide source does not have a PDF signature.');
  }
  if (sourceBytes.length !== expectedBytes) {
    throw new Error(`Access guide source has ${sourceBytes.length} bytes; expected ${expectedBytes}.`);
  }
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  if (digest !== expectedSha256) {
    throw new Error(`Access guide source checksum is ${digest}; expected ${expectedSha256}.`);
  }
  if (!deployedBytes.equals(sourceBytes)) {
    throw new Error('Access guide deploy copy differs from its source.');
  }
  return { state, digest };
}

function readOptional(pathname) {
  return existsSync(pathname) ? readFileSync(pathname) : undefined;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pia-access-guide-'));
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

  it('accepts the intentional public state when both confidential copies are absent', () => {
    expect(validateAssetPair({ sourceBytes: undefined, deployedBytes: undefined })).toEqual({
      state: 'both-absent',
      reason: 'Public checkouts intentionally omit both confidential PDF copies.',
    });
  });

  it.each([
    {
      label: 'source exists without a deploy copy',
      sourceBytes: Buffer.from('%PDF-fixture'),
      deployedBytes: undefined,
      error: 'source exists but the deploy copy is absent',
    },
    {
      label: 'deploy copy exists without its source',
      sourceBytes: undefined,
      deployedBytes: Buffer.from('%PDF-fixture'),
      error: 'deploy copy exists without its confidential source',
    },
  ])('rejects $label', ({ sourceBytes, deployedBytes, error }) => {
    expect(() => validateAssetPair({ sourceBytes, deployedBytes })).toThrow(error);
  });

  it('requires byte identity, PDF signature, size, and checksum when both copies exist', () => {
    const bytes = Buffer.from('%PDF-fixture', 'ascii');
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    expect(
      validateAssetPair({
        sourceBytes: bytes,
        deployedBytes: Buffer.from(bytes),
        expectedBytes: bytes.length,
        expectedSha256,
      })
    ).toEqual({ state: 'both-present', digest: expectedSha256 });

    expect(() =>
      validateAssetPair({
        sourceBytes: bytes,
        deployedBytes: Buffer.from('%PDF-different', 'ascii'),
        expectedBytes: bytes.length,
        expectedSha256,
      })
    ).toThrow('deploy copy differs from its source');
  });

  it('pins the confidential source and validates a generated deploy copy when present', () => {
    const sourceBytes = readOptional(source);
    const deployedBytes = readOptional(deployed);
    expect(sourceBytes).toBeDefined();
    if (deployedBytes === undefined) {
      expect(createHash('sha256').update(sourceBytes).digest('hex')).toBe(EXPECTED_SOURCE_SHA256);
      expect(sourceBytes.length).toBe(EXPECTED_SOURCE_BYTES);
      return;
    }
    expect(validateAssetPair({ sourceBytes, deployedBytes })).toMatchObject({ state: 'both-present' });
  });

  it('keeps the renamed source, deploy copy, and generation inputs out of the public mirror', () => {
    for (const pathname of [
      'docs/Player_Insights_Agent_Access_Guide.md',
      'docs/Player_Insights_Agent_Security_Access_Specification.md',
      'docs/Player_Insights_Agent_SP_Self_Service_Plan.md',
      'docs/player-insights-agent-access-guide.css',
      `player-insights-agent/docs/${ACCESS_GUIDE_FILENAME}`,
      `player-insights-agent/build/deploy/assets/${ACCESS_GUIDE_FILENAME}`,
    ]) {
      expect(publishExclusions).toContain(`${pathname}\n`);
    }
    expect(publishExclusions).not.toContain('Astrolabe_Access_Patterns_v2.pdf');
  });
});
