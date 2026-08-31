import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(import.meta.url);
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.mts', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set(['build', 'dist', 'node_modules', 'playwright-report', 'test-results']);
const INDIRECT_RUNTIME_OWNERS = new Map([['tw-animate-css', '@databricks/appkit-ui/styles.css']]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
    if (file === import.meta.filename) return [];
    return [file];
  });
}

function imported(packageName: string, sources: readonly string[]): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const specifier = `['"]${escaped}(?:/[^'"]*)?['"]`;
  const importPattern = new RegExp(
    `(?:\\bfrom\\s+|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+|@import\\s+)${specifier}`
  );
  return sources.some((source) => importPattern.test(readFileSync(source, 'utf8')));
}

function importedByOwnedDependency(packageName: string): boolean {
  const owner = INDIRECT_RUNTIME_OWNERS.get(packageName);
  if (!owner) return false;
  return readFileSync(require.resolve(owner), 'utf8').includes(`"${packageName}"`);
}

describe('direct dependency contract', () => {
  it('keeps only production packages imported by source or build configuration', () => {
    const sources = sourceFiles(ROOT);
    const unowned = Object.keys(MANIFEST.dependencies).filter(
      (name) => !imported(name, sources) && !importedByOwnedDependency(name)
    );

    expect(unowned).toEqual([]);
  });
});
