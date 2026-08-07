/**
 * Which identifiers in an answer become links, and where those links go.
 *
 * 1. THE ANSWER DECLARED IT. Candidates come from `answer.sources`, the
 *    structured list the agent returns and the source chip beneath the answer
 *    already shows, never from scanning prose for anything that looks like a
 *    table. Linking a table the answer did not cite would put provenance on
 *    screen that the run did not claim, which in this product is a worse defect
 *    than a missing link.
 *
 * 2. THE APP TRACKS IT. The name must appear in the preflight report as a
 *    `table` check, because those checks ARE the rows of the Unity Catalog
 *    table matrix on the Connections page. Deriving the link set from the same report the
 *    target page renders is what makes "this link goes nowhere" unreachable:
 *    there is no second list to drift out of step. An identifier that fails
 *    either rule stays exactly as it was.
 *
 * WHY THIS CANNOT LINK AN ORDINARY WORD. The candidate set is one or two names
 * per answer rather than a dictionary, so a word can only be linkified if the
 * answer declared a table by that name. On top of that, a match must be
 * bounded: the characters either side may not continue an identifier, so
 * `gold_title_daily_summary` is not found inside
 * `<your_schema>.gold_title_daily_summary` or inside
 * `gold_title_daily_summary.net_bookings_usd`, and a single-segment name is
 * only accepted when it carries an underscore. That last rule is what keeps a
 * table legitimately called `sessions` or `email` from linkifying the English
 * word: such a name is linked only where the prose qualifies it.
 *
 * Nothing here rewrites prose. Segments are cut out of the original string and
 * concatenate back to it exactly, so linkifying cannot silently reword an
 * answer; `answer-prose is never rewritten` in the tests pins that.
 */

/** Search parameter the Connections page reads to highlight one entry. */
export const ENTITY_PARAM = 'entity';

/** DOM id of the row that documents one fully-qualified table. */
export function entityRowId(fullName: string): string {
  return `entity-${fullName.trim().toLowerCase()}`;
}

/**
 * Where a link to one entry points.
 *
 * `/connections` since Sources & Capabilities merged into it. `/sources` still
 * resolves, and its redirect carries the query string, so links in answers that
 * were rendered against an older build still land on the right row.
 */
export function entityHref(fullName: string): string {
  return `/connections?${ENTITY_PARAM}=${encodeURIComponent(fullName.trim())}`;
}

/**
 * A run of prose, plain or linkable.
 *
 * `text` is a slice of the original string and is never edited: a linked run
 * keeps whatever the answer wrote, including its capitalisation.
 */
export interface ProseSegment {
  text: string;
  /**
   * Where this run starts in the original string.
   *
   * Carried so the renderer has a key that is a property of the run rather
   * than of its position in an array: the same prose segmented before and
   * after the tracked list arrives keys its unchanged runs identically.
   */
  start: number;
  /** The tracked entry this run names, when it names one. */
  entity?: string;
}

/**
 * The table names the Connections page currently has rows for.
 *
 * Reads the preflight payload defensively, because it arrives from the agent by
 * way of a route that deliberately forwards a drifted body rather than dropping
 * it, see `answer-shape.ts` for the same reasoning applied to answers. A
 * report that cannot be read yields no names, which yields no links.
 */
export function trackedTables(report: unknown): string[] {
  const checks = (report as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  const names: string[] = [];
  for (const entry of checks) {
    if (!entry || typeof entry !== 'object') continue;
    const check = entry as { kind?: unknown; name?: unknown };
    if (check.kind !== 'table' || typeof check.name !== 'string') continue;
    const name = check.name.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * The tracked spelling of `name`, or `''` when the app tracks no such entry.
 *
 * Compared case-insensitively because Unity Catalog identifiers are, but the
 * tracked spelling is what comes back: the link and the row it lands on have
 * to agree on one string.
 */
export function trackedEntity(name: string, tracked: readonly string[]): string {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return '';
  return tracked.find((candidate) => candidate.trim().toLowerCase() === wanted)?.trim() ?? '';
}

/** Rule 1 ∩ rule 2: what this answer declared, that the app also tracks. */
export function linkableEntities(declared: readonly string[], tracked: readonly string[]): string[] {
  const linkable: string[] = [];
  for (const name of declared) {
    const match = trackedEntity(name, tracked);
    if (match && !linkable.includes(match)) linkable.push(match);
  }
  return linkable;
}

/**
 * How one tracked table may legitimately be written in prose.
 *
 * The fully-qualified name, the `schema.table` tail, and the bare table name.
 * The bare form is offered only when it contains an underscore: without one it
 * is indistinguishable from an ordinary English word, and a link on the word
 * "sessions" in a sentence about sessions is precisely the false positive that
 * would make every other link untrustworthy.
 */
function surfaceForms(fullName: string): string[] {
  const parts = fullName
    .trim()
    .split('.')
    .filter((part) => part.length > 0);
  if (parts.length === 0) return [];
  const forms: string[] = [];
  if (parts.length > 1) forms.push(parts.join('.'));
  if (parts.length > 2) forms.push(parts.slice(-2).join('.'));
  const bare = parts[parts.length - 1];
  if (bare.includes('_')) forms.push(bare);
  return forms;
}

/**
 * Every accepted spelling mapped to the entry it means, longest form first.
 *
 * A form two different tracked tables could both claim (the same bare name in
 * two schemas), is dropped rather than resolved to whichever was declared
 * first. Guessing which of two governed tables a sentence meant is the one
 * error that would be invisible to the reader and wrong in the way that
 * matters.
 */
export function entityForms(linkable: readonly string[]): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const fullName of linkable) {
    for (const form of surfaceForms(fullName)) {
      const key = form.toLowerCase();
      const owners = claims.get(key) ?? new Set<string>();
      owners.add(fullName);
      claims.set(key, owners);
    }
  }
  const resolved = [...claims.entries()]
    .filter(([, owners]) => owners.size === 1)
    .sort(([a], [b]) => b.length - a.length);
  return new Map(resolved.map(([form, owners]) => [form, [...owners][0]]));
}

function isIdentifierChar(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

/**
 * Whether a match sits on identifier boundaries rather than inside a longer name.
 *
 * Written as a scan rather than as a lookbehind regex deliberately: a regex
 * with `(?<!…)` is a syntax error in engines that do not support it, and it
 * would throw while this module was being evaluated, taking down the whole
 * answer route to add a hyperlink.
 */
function boundedAt(prose: string, index: number, length: number): boolean {
  const before = prose[index - 1];
  if (isIdentifierChar(before)) return false;
  if (before === '.' && isIdentifierChar(prose[index - 2])) return false;
  const after = prose[index + length];
  if (isIdentifierChar(after)) return false;
  if (after === '.' && isIdentifierChar(prose[index + length + 1])) return false;
  return true;
}

/**
 * Cut `prose` into runs, marking the ones that name a linkable entry.
 *
 * Longest form first at each position, so a fully-qualified mention is linked
 * once as a whole rather than twice as its parts.
 */
export function linkifyEntities(prose: string,
  declared: readonly string[],
  tracked: readonly string[]
): ProseSegment[] {
  if (!prose) return [];
  const forms = entityForms(linkableEntities(declared, tracked));
  if (forms.size === 0) return [{ text: prose, start: 0 }];

  const haystack = prose.toLowerCase();
  const segments: ProseSegment[] = [];
  let plainFrom = 0;
  let cursor = 0;
  while (cursor < prose.length) {
    let hit: { length: number; entity: string } | undefined;
    for (const [form, entity] of forms) {
      if (haystack.startsWith(form, cursor) && boundedAt(prose, cursor, form.length)) {
        hit = { length: form.length, entity };
        break;
      }
    }
    if (!hit) {
      cursor += 1;
      continue;
    }
    if (cursor > plainFrom) segments.push({ text: prose.slice(plainFrom, cursor), start: plainFrom });
    segments.push({ text: prose.slice(cursor, cursor + hit.length), start: cursor, entity: hit.entity });
    cursor += hit.length;
    plainFrom = cursor;
  }
  if (plainFrom < prose.length) segments.push({ text: prose.slice(plainFrom), start: plainFrom });
  return segments;
}
