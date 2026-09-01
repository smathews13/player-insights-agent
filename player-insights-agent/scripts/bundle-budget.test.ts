import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { budgetFindings, inspectBundle } from './bundle-budget.mjs';

const work = new Set<string>();

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pia-bundle-budget-'));
  work.add(root);
  const assets = path.join(root, 'client', 'dist', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(
    path.join(root, 'client', 'dist', 'index.html'),
    [
      '<script type="module" src="/assets/index-abc.js"></script>',
      '<link rel="modulepreload" href="/assets/appkit-ui-abc.js">',
      '<link rel="stylesheet" href="/assets/index-abc.css">',
    ].join('\n')
  );
  writeFileSync(
    path.join(assets, 'index-abc.js'),
    `import "./rolldown-runtime-abc.js"; import("./zod-abc.js"); console.log("home");`
  );
  writeFileSync(path.join(assets, 'rolldown-runtime-abc.js'), 'export const runtime = true;');
  writeFileSync(path.join(assets, 'appkit-ui-abc.js'), 'export const Button = "public barrel";');
  writeFileSync(path.join(assets, 'zod-abc.js'), 'export const marker = "$ZodType";');
  writeFileSync(path.join(assets, 'index-abc.css'), 'body { color: white; }');
  writeFileSync(path.join(root, 'server.mjs'), 'import "./vendor.mjs"; console.log("server");');
  writeFileSync(path.join(root, 'vendor.mjs'), 'export const sdk = true;');
  return root;
}

afterEach(() => {
  for (const directory of work) rmSync(directory, { recursive: true, force: true });
  work.clear();
});

describe('production bundle budget', () => {
  it('measures the deterministic initial, Home, server, largest-file, and artifact graphs', () => {
    const root = fixture();
    const first = inspectBundle(root);
    const second = inspectBundle(root);

    expect(second).toEqual(first);
    expect(first.files.initialJs).toEqual([
      'client/dist/assets/appkit-ui-abc.js',
      'client/dist/assets/index-abc.js',
      'client/dist/assets/rolldown-runtime-abc.js',
    ]);
    expect(first.files.homeEntry).toEqual(['client/dist/assets/index-abc.js']);
    expect(first.files.appkitJs).toEqual(['client/dist/assets/appkit-ui-abc.js']);
    expect(first.files.lazyValidator).toEqual(['client/dist/assets/zod-abc.js']);
    expect(first.files.eagerServerGraph).toEqual(['server.mjs', 'vendor.mjs']);
    expect(first.metrics.initialCss.raw).toBeGreaterThan(0);
    expect(first.metrics.initialCss.compressed).toBeGreaterThan(0);
    for (const measured of Object.values(first.metrics)) {
      expect(Object.keys(measured).sort()).toEqual(['compressed', 'raw']);
    }
    expect(first.metrics.totalDeployArtifact.raw).toBeGreaterThan(first.metrics.eagerServerGraph.raw);
  });

  it('keeps lazy Zod legal but refuses it anywhere in the initial Ask graph', () => {
    const root = fixture();
    expect(() => inspectBundle(root)).not.toThrow();
    writeFileSync(path.join(root, 'client', 'dist', 'assets', 'index-abc.js'), 'const validator = "$ZodType";');
    expect(() => inspectBundle(root)).toThrow(/Zod entered the initial Ask graph/);
  });

  it('reports the exact metric that crossed its recorded raw or compressed ceiling', () => {
    const report = inspectBundle(fixture());
    const limits = Object.fromEntries(
      Object.entries(report.metrics).map(([name, values]) => [
        name,
        Object.fromEntries(Object.entries(values).map(([kind, value]) => [kind, value])),
      ])
    );
    expect(budgetFindings(report, limits)).toEqual([]);

    limits.homeEntry.raw -= 1;
    limits.initialCss.compressed -= 1;
    expect(budgetFindings(report, limits)).toEqual([
      expect.stringMatching(/^initialCss\.compressed:/),
      expect.stringMatching(/^homeEntry\.raw:/),
    ]);
  });

  it('gates deploy builds, releases, operator checks, and the public mirror without a browser', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['build:deploy']).toMatch(/bundle:deploy.*check:deploy-artifact/);
    expect(manifest.scripts['smoke:deploy-artifact']).toBe('node scripts/smoke-deploy-artifact.mjs');
    const artifactCheck = readFileSync(new URL('./check-deploy-artifact.mjs', import.meta.url), 'utf8');
    expect(artifactCheck).toContain('inspectBundle(deployDir)');
    expect(artifactCheck).toContain('budgetFindings(budgetReport, LIMITS)');
    expect(artifactCheck).toContain('validateRuntimePersonas(serverPath)');
    expect(artifactCheck).toContain('smokeDeployArtifact(deployDir)');

    // bundle/ and mirror/ are publication tooling and are intentionally absent
    // from the derived public checkout. The internal suite verifies their wiring;
    // the public suite still verifies the package-level gate and the artifact.
    const releaseUrl = new URL('../../bundle/app-release.sh', import.meta.url);
    const checksUrl = new URL('../../bundle/run-checks.sh', import.meta.url);
    const syncUrl = new URL('../../sync-mirror.sh', import.meta.url);
    if (existsSync(releaseUrl)) expect(readFileSync(releaseUrl, 'utf8')).toContain('npm run build:deploy');
    if (existsSync(checksUrl)) expect(readFileSync(checksUrl, 'utf8')).toContain('run bundle:budget');
    if (existsSync(syncUrl)) {
      const sync = readFileSync(syncUrl, 'utf8');
      expect(sync).toContain('check-deploy-artifact.mjs');
      expect(sync).toContain('--committed --deploy-dir');
    }
  });

  it('routes SDK roots and subpaths through one deploy vendor module', () => {
    const bundler = readFileSync(new URL('./bundle-server.mjs', import.meta.url), 'utf8');

    expect(bundler).toContain(')(?:/.*)?$');
    expect(bundler).toContain('vendor package code was duplicated in server.mjs');
    expect(bundler).toContain('input.includes(`node_modules/${pkg}/`)');
    expect(bundler).toContain('path: `./${vendorFileName(pkg)}`');
    expect(bundler).toContain("export { WorkspaceClient } from '${base}/WorkspaceClient.js'");
    expect(bundler).toContain("export { Context } from '${base}/context/Context.js'");
    expect(bundler).not.toContain("import * as namespace from '${pkg}'");
    expect(bundler).toContain("chunkNames: '[name]-[hash]'");
    expect(bundler).toContain('splitting: true');
    expect(bundler.match(/charset: 'utf8'/g)).toHaveLength(3);
    expect(bundler).toContain('Dynamic require of "');
    expect(bundler).toContain('split CommonJS helper');
  });
});
