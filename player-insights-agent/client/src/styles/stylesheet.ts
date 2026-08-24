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
 * The order is not restated here. It is parsed out of index.css, which is the
 * cascade, so a partial added or moved there is picked up rather than silently
 * skipped by a list nobody remembered to update.
 *
 * THERE IS NO SECOND SOURCE OF PARTIALS ANY MORE, and the reason is a shipped
 * regression. Five of these were moved out of index.css and into side-effect
 * imports inside lazy route modules, to keep them out of Ask's entry chunk. Two
 * of them are not route stylesheets at all: timeline.css paints `TraceTimeline`,
 * which the answer card draws on Ask and the drawer draws on Monitoring, and
 * neither of those surfaces was a route that imported it -- so the timeline
 * rendered with no rules on both while Run Explorer, which did import it, looked
 * correct. The rest arrived after dark-mode.css and responsive.css instead of
 * before them, which inverts every tie those two files were written to win.
 */

const HERE = new URL('.', import.meta.url);

/** fonts.css predates the split. It carries @font-face and no app rules. */
const NOT_A_PARTIAL = new Set(['fonts.css']);

/** The partial filenames, in the order index.css imports them. */
export function partialNames(): string[] {
  const index = readFileSync(new URL('../index.css', HERE), 'utf8');
  return [...index.matchAll(/^@import '\.\/styles\/([\w-]+\.css)';/gm)]
    .map((match) => match[1])
    .filter((name) => !NOT_A_PARTIAL.has(name));
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
