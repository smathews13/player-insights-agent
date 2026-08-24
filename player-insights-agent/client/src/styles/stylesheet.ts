import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The app's stylesheet, reassembled, for the tests that assert against it.
 *
 * index.css used to be one file and five test files read it with `readFileSync`.
 * It is now a set of partials and an import list, so a test that reads index.css
 * alone reads nothing but the imports and passes for the wrong reason -- the
 * failure mode a stylesheet test can least afford, because it looks like green.
 *
 * Eager order is parsed from index.css. Route CSS is parsed from the lazy page
 * modules that own it, so an audit still covers every rule the app ships without
 * forcing those pages back into Ask's entry stylesheet.
 */

const HERE = new URL('.', import.meta.url);

/** fonts.css predates the split. It carries @font-face and no app rules. */
const NOT_A_PARTIAL = new Set(['fonts.css']);
const ROUTE_MODULES = [
  'ConnectionsPage.tsx',
  'MonitoringPage.tsx',
  'OpsPage.tsx',
  'ArchitecturePage.tsx',
  'BenchmarkLab.tsx',
  'RunExplorer.tsx',
];

/** The partial filenames, in the order index.css imports them. */
export function partialNames(): string[] {
  const index = readFileSync(new URL('../index.css', HERE), 'utf8');
  const eager = [...index.matchAll(/^@import '\.\/styles\/([\w-]+\.css)';/gm)]
    .map((match) => match[1])
    .filter((name) => !NOT_A_PARTIAL.has(name));
  const lazy = ROUTE_MODULES.flatMap((module) => {
    const source = readFileSync(new URL(`../${module}`, HERE), 'utf8');
    return [...source.matchAll(/^import '\.\/styles\/([\w-]+\.css)';/gm)].map((match) => match[1]);
  });
  const lazySet = new Set(lazy);
  const beforeSettings = ['benchmark.css', 'runs.css', 'timeline.css', 'connections.css', 'architecture.css'];
  const beforeResponsive = ['time-range.css', 'monitoring.css', 'ops.css'];
  const ordered: string[] = [];
  for (const name of eager) {
    if (name === 'settings.css') ordered.push(...beforeSettings.filter((entry) => lazySet.has(entry)));
    if (name === 'responsive.css') ordered.push(...beforeResponsive.filter((entry) => lazySet.has(entry)));
    ordered.push(name);
  }
  return [...new Set(ordered)];
}

/** One partial, on its own, for a claim that is about where a rule lives. */
export function partial(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, HERE)), 'utf8');
}

/**
 * Every eager and lazy-route partial the client can ship.
 */
export function stylesheet(): string {
  return partialNames().map(partial).join('');
}
