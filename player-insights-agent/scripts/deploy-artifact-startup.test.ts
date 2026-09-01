import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { smokeDeployArtifact } from './smoke-deploy-artifact.mjs';

const root = path.resolve(import.meta.dirname, '..');
const deploy = path.join(root, 'build', 'deploy');
const modules = readdirSync(deploy)
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => path.join(deploy, name));

describe('dependency-free deploy startup', () => {
  it('evaluates the actual production entry without listening or connecting', () => {
    expect(smokeDeployArtifact(deploy)).toEqual({
      node: process.version,
      stdout: 'module-smoke ok',
    });
  });

  it('keeps Lakebase pg bundled behind a working split CommonJS bridge', async () => {
    const server = readFileSync(path.join(deploy, 'server.mjs'), 'utf8');
    expect(server).toContain('@databricks/lakebase/dist/pool.js');
    const pgClients = new Set(server.match(/node_modules\/(?:@[^/]+\/[^/]+\/node_modules\/)?pg\/lib\/client\.js/g));
    expect(pgClients).toEqual(new Set(['node_modules/pg/lib/client.js']));
    expect(modules.filter((file) => path.basename(file).startsWith('chunk-')).length).toBeGreaterThan(0);

    const helperFiles = modules.filter(
      (file) => path.basename(file).startsWith('chunk-') && readFileSync(file, 'utf8').includes('Dynamic require of "')
    );
    expect(helperFiles).toHaveLength(1);
    const helperSource = readFileSync(helperFiles[0], 'utf8');
    expect(helperSource).toContain("createRequire as __createRequire } from 'node:module'");

    const helper = (await import(pathToFileURL(helperFiles[0]).href)) as {
      __require: (specifier: string) => unknown;
    };
    const knownBuiltins = new Set(
      builtinModules.flatMap((name) => {
        const bare = name.replace(/^node:/, '');
        return [bare, `node:${bare}`];
      })
    );
    const requiredBuiltins = new Set<string>();
    for (const file of modules) {
      for (const match of readFileSync(file, 'utf8').matchAll(/__require\("([^"]+)"\)/g)) {
        if (knownBuiltins.has(match[1])) requiredBuiltins.add(match[1]);
      }
    }
    expect([...requiredBuiltins]).toEqual(expect.arrayContaining(['events', 'fs', 'crypto', 'stream', 'node:events']));
    for (const specifier of requiredBuiltins) {
      expect(() => helper.__require(specifier), specifier).not.toThrow();
    }
  });

  it('aligns the direct pg tool dependency so AppKit and Lakebase share one bundled copy', () => {
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
    };
    expect(lock.packages[''].devDependencies?.pg).toBe(lock.packages['node_modules/pg'].version);
    expect(
      Object.keys(lock.packages).filter((name) => /node_modules\/@databricks\/[^/]+\/node_modules\/pg$/.test(name))
    ).toEqual([]);
  });

  it('ships no dependency manifest in the deploy tree', () => {
    for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      expect(existsSync(path.join(deploy, name)), name).toBe(false);
    }
  });
});
