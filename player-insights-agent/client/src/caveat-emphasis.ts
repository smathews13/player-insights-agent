/**
 * What is set apart inside a caveat: the table it is about, and its numbers.
 *
 * The Caveats section is a block of amber prose, and the reported problem
 * with it was that everything in it weighs the same. A reader looking for which
 * table a warning is about, or for how big "understated" turned out to be, had
 * to read every bullet to the end. So a caveat that names exactly one of the
 * answer's own tables leads with that table's short name as a tag, and the
 * counts, percentages and thresholds inside the sentence are drawn bold.
 *
 * NOTHING HERE REWRITES A CAVEAT. `emphasiseFigures` cuts the string into runs
 * that concatenate back to it exactly, so a disclosure cannot be reworded,
 * truncated or reordered on its way to the screen -- the property
 * caveat-list.test.ts has guarded since the caveats were one joined paragraph,
 * now guarded here as a round trip rather than as the absence of a `.replace`.
 */

import { linkifyEntities } from './data-entities';
import { splitSourceName } from './source-rows';

/**
 * One run of a caveat: ordinary text, or a figure the reader should be able to
 * find without reading the sentence.
 */
export interface CaveatRun {
  text: string;
  /** Where this run starts in the caveat, so a renderer has a stable key. */
  start: number;
  /** A count, a percentage or a threshold. Drawn bold. */
  figure?: true;
}

/**
 * A number as the agent writes one: an optional approximation mark, digits with
 * or without thousands separators, an optional decimal, an optional percent.
 *
 * Deliberately not anchored to a unit or a word. The agent writes "~2,833",
 * "1.81%", "only 19 of the 30 calendar days" and "the 6-figure limit", and all
 * four are the quantity the sentence is about.
 */
const FIGURE = /~?\d[\d,]*(?:\.\d+)?%?/g;

/**
 * Whether a match is a quantity rather than part of something else.
 *
 * Three rejections, each for a case seen in a live caveat:
 *
 *   - Inside an identifier. `boundedAt` in data-entities.ts makes the same
 *     check for the same reason: `gold_summary_v2` is one name and the `2` in
 *     it is not a figure.
 *   - Inside a date. An ISO date offers three matches, and bolding two of them
 *     would print "2026-**08**-**16**". The design is explicit that dates stay
 *     at regular weight, so a run touching a `-` or a `/` with digits on the
 *     other side is left alone.
 *   - A bare year. "the 2026 season" is a date written as one number, and there
 *     is nothing in the string to distinguish it from a count, so the range is
 *     the distinguisher. A year with a thousands separator, a decimal or a
 *     percent is not a year and is not caught by this.
 */
function isQuantity(text: string, index: number, match: string): boolean {
  const before = text[index - 1];
  const after = text[index + match.length];
  if (before !== undefined && /[A-Za-z0-9_]/.test(before)) return false;
  if (after !== undefined && /[A-Za-z_]/.test(after)) return false;
  if ((before === '-' || before === '/') && /\d/.test(text[index - 2] ?? '')) return false;
  if ((after === '-' || after === '/') && /\d/.test(text[index + match.length + 1] ?? '')) return false;
  if (/^\d{4}$/.test(match)) {
    const year = Number(match);
    if (year >= 1900 && year <= 2100) return false;
  }
  return true;
}

/**
 * A caveat cut into plain runs and figure runs.
 *
 * Returns a single plain run for a sentence with no figures in it, so the
 * common case costs one element and reads identically to the untreated text.
 */
export function emphasiseFigures(caveat: string): CaveatRun[] {
  if (!caveat) return [];
  const runs: CaveatRun[] = [];
  let plainFrom = 0;
  for (const match of caveat.matchAll(FIGURE)) {
    const index = match.index ?? 0;
    if (!isQuantity(caveat, index, match[0])) continue;
    if (index > plainFrom) runs.push({ text: caveat.slice(plainFrom, index), start: plainFrom });
    runs.push({ text: match[0], start: index, figure: true });
    plainFrom = index + match[0].length;
  }
  if (plainFrom < caveat.length) runs.push({ text: caveat.slice(plainFrom), start: plainFrom });
  return runs;
}

/**
 * The short name of the one table this caveat is about, or `''`.
 *
 * EXACTLY ONE, which is the whole rule. A caveat comparing two tables is not
 * scoped to either of them, and tagging it with whichever it named first would
 * be this surface deciding which half of a comparison mattered. A caveat naming
 * none is run-level -- identity, coverage -- and carries no tag.
 *
 * The matching is `linkifyEntities`, the app's own, rather than a second
 * implementation of "does this sentence name that table". That function already
 * settles the three questions a hand-rolled scan gets wrong: which spellings of
 * a table count, that a match must sit on identifier boundaries so
 * `gold_spend_daily` is not found inside `gold_spend_daily_summary`, and that a
 * single-segment name without an underscore is an English word. The declared
 * list is passed as the tracked list as well, because the question here is only
 * whether the answer's own sources are named, not whether they can be linked.
 */
export function caveatScope(caveat: string, sources: readonly { name: string }[]): string {
  const names = sources.map((source) => source.name);
  if (names.length === 0) return '';
  const named = new Set(
    linkifyEntities(caveat, names, names)
      .map((segment) => segment.entity)
      .filter((entity): entity is string => !!entity)
  );
  if (named.size !== 1) return '';
  return splitSourceName([...named][0]).short;
}
