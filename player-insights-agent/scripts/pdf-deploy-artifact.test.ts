import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const deploy = path.join(root, 'build', 'deploy');
const serverArtifact = path.join(deploy, 'server.mjs');
const workerArtifact = path.join(deploy, 'pdf-text-worker.mjs');
const oldVendorArtifact = path.join(deploy, 'vendor-unpdf.mjs');
const sdkVendorArtifact = path.join(deploy, 'vendor-databricks-sdk-experimental.mjs');
const fixture = path.join(root, 'server', 'lib', '__fixtures__', 'simple-text.pdf');
const MAX_DEPLOY_FILE_BYTES = 10 * 1024 * 1024;

function runWorker(bytes: Buffer): Promise<string> {
  const owned = new Uint8Array(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerArtifact, {
      workerData: { bytes: owned.buffer, maxChars: 50_000 },
      transferList: [owned.buffer],
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Deploy PDF worker did not answer within five seconds.'));
    }, 5_000);
    worker.once('message', (result: { ok?: boolean; text?: unknown; error?: unknown }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (result.ok === true && typeof result.text === 'string') resolve(result.text);
      else reject(new Error(`Deploy PDF worker failed: ${JSON.stringify(result.error)}`));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('PDF deploy artifact', () => {
  it('keeps unpdf out of the normal startup graph and ships no install manifest', () => {
    const server = readFileSync(serverArtifact, 'utf8');
    const worker = readFileSync(workerArtifact, 'utf8');

    expect(server).not.toContain('vendor-unpdf.mjs');
    expect(server).not.toContain('node_modules/unpdf/');
    expect(server).toContain('pdf-text-worker.mjs');
    expect(worker).toContain('node_modules/unpdf/');
    expect(existsSync(oldVendorArtifact)).toBe(false);
    expect(existsSync(path.join(deploy, 'package.json'))).toBe(false);
  });

  it('keeps every eager and worker module below the platform file limit', () => {
    for (const file of [serverArtifact, sdkVendorArtifact, workerArtifact]) {
      expect(statSync(file).size, path.basename(file)).toBeLessThan(MAX_DEPLOY_FILE_BYTES);
    }
  });

  it('executes the bundled worker without node_modules in the deploy tree', async () => {
    await expect(runWorker(readFileSync(fixture))).resolves.toBe('Hello player insights');
  });
});
