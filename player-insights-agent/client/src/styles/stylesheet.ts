import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The app's stylesheet, reassembled, for the tests that assert against it.
 *
 * index.css used to be one file and five test files read it with `readFileSync`.
 * It is now a set of partials and an import list, so a test that reads index.css
 * alone reads nothing but the imports and passes for the wrong reason -- the
 * failure mode a stylesheet test can least afford, because it looks like green.
 *
 * The order is not restated here. Global imports come from index.css and
 * route-owned imports come from the route entry sheets. Tests can therefore
 * audit the complete supported cascade without putting route-only bytes back in
 * Ask's entry bundle.
 */

const HERE = new URL('.', import.meta.url);
const ROUTES = new URL('./routes/', HERE);

/** fonts.css predates the split. It carries @font-face and no app rules. */
const NOT_A_PARTIAL = new Set(['fonts.css']);
const COMPONENT_PARTIALS = ['timeline.css'];

/** The partial filenames, in the order index.css imports them. */
export function partialNames(): string[] {
  const index = readFileSync(new URL('../index.css', HERE), 'utf8');
  const global = [...index.matchAll(/^@import '\.\/styles\/([\w-]+\.css)';/gm)]
    .map((match) => match[1])
    .filter((name) => !NOT_A_PARTIAL.has(name));
  const routes = readdirSync(ROUTES)
    .filter((name) => name.endsWith('.css'))
    .sort()
    .flatMap((entry) => {
      const source = readFileSync(new URL(entry, ROUTES), 'utf8');
      return [...source.matchAll(/^@import '\.\.\/([\w-]+\.css)';/gm)].map((match) => match[1]);
    });
  return [...new Set([...global, ...COMPONENT_PARTIALS, ...routes])];
}

/** One partial, on its own, for a claim that is about where a rule lives. */
export function partial(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, HERE)), 'utf8');
}

/**
 * Every partial concatenated in import order, which is exactly the body the
 * single file used to hold.
 */
export function stylesheet(): string {
  return partialNames().map(partial).join('');
}
