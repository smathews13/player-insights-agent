/**
 * Which identifiers in an answer become links, which are merely named, and
 * where the links go.
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
 * WHAT IS NAMED BUT NOT LINKED. A surface can also declare identifiers that no
 * page documents: the columns a plan says it will read, and a table it names
 * that this deployment does not track. Those are marked `emphasis` and drawn
 * bold. They pass through the same candidate-set discipline as the links -- the
 * surface has to have declared them, and a bare name still needs an underscore
 * -- because a false bold on an English word costs the same trust a false link
 * does, and buys less.
 *
 * Nothing here rewrites prose. Segments are cut out of the original string and
 * concatenate back to it exactly, so linkifying cannot silently reword an
 * answer; `answer-prose is never rewritten` in the tests pins that.
 */

/** Search parameter the Connections page reads to highlight one entry. */
export const ENTITY_PARAM = 'entity';

/**
 * DOM id of the row that documents one entry.
 *
 * Entries are fully-qualified table names and the `ConnectedResource` ids the
 * connection rows carry. The two cannot collide: a table name has two dots and
 * a resource id has none, and the registry is a closed list.
 */
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
  /**
   * A named identifier with nowhere to send the reader.
   *
   * A column, or a table this deployment does not track. The reader still needs
   * to see that the sentence is naming a thing in the data rather than using an
   * English word, so the run is drawn bold and left inert. Deliberately not a
   * link: an anchor that navigates nowhere is worse than no anchor, because the
   * first one a reader tries teaches them what the rest are worth.
   */
  emphasis?: true;
  /** The declared table this run spells, even when it has no tracked link. */
  declaredTable?: string;
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

/**
 * The columns a surface declares, taken from the list it writes them in.
 *
 * The plan states them as `Columns: event_date, title_code, active_players`,
 * which is the agent's own convention and the only place in these payloads
 * where a column is declared as data rather than mentioned in a sentence. That
 * list is the candidate set, exactly as `answer.sources` is the candidate set
 * for tables: a name the surface never declared is not bolded anywhere in it.
 *
 * The underscore rule from `surfaceForms` applies here for the same reason and
 * bites harder. A plan reading a column called `title` would otherwise bold the
 * word in "by title over the 30-day window", and a reader who sees that once
 * stops believing the rest.
 *
 * Only the first identifier of each comma-separated item is taken, so a list
 * that runs back into prose -- `Columns: a_b, c_d. Grouped by title.` -- gives
 * up `c_d` and nothing after it.
 */
export function declaredColumns(texts: readonly string[]): string[] {
  const names: string[] = [];
  for (const text of texts) {
    for (const list of text.matchAll(/\bcolumns?\s*:/gi)) {
      const tail = text.slice((list.index ?? 0) + list[0].length).split('\n')[0];
      for (const item of tail.split(',')) {
        const name = /^\s*`?([A-Za-z_][A-Za-z0-9_]*)/.exec(item)?.[1];
        if (name?.includes('_') && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

/**
 * The identifiers a caveat names, for the surface that renders caveats.
 *
 * A caveat is the one place in these payloads where a column is named in a
 * sentence and nowhere declared as data: "active_players is not additive across
 * labels", "the field launch_campaign_sessions is not documented in the data
 * dictionary", "last_play_date is undocumented". `declaredColumns` finds none of
 * these, because there is no `Columns:` list in a caveat to read, and the two
 * that matter most are the ones for a field the dictionary does not have -- so
 * there is no governed list they could ever be looked up in either. That is
 * precisely what `EntityMark` was added for: an identifier a surface names and
 * cannot link.
 *
 * The underscore requirement is the whole safety argument and it is the same one
 * `surfaceForms` and `declaredColumns` make. Without it this would bold the word
 * "sessions" in a sentence about sessions and the word "figures" in every
 * caveat, and a reader who sees one wrong mark stops trusting the rest. With it,
 * what is left is the shape of a Unity Catalog identifier and very little else:
 * English does not hyphenate with underscores.
 *
 * Nothing is linked from here. These names are handed to the existing pipeline
 * as candidates for emphasis, and `proseForms` gives a link precedence over a
 * bold at the same position, so a caveat that names the answer's own source
 * table still gets the link rather than a bold -- which is why this returns
 * table names too rather than trying to exclude them.
 */
export function mentionedIdentifiers(texts: readonly string[]): string[] {
  const names: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g)) {
      const name = match[0];
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** What a matched form makes of the run it covers. */
type FormMark = { entity: string } | { emphasis: true; declaredTable?: string };

/**
 * Every accepted spelling in one map, longest first, links before emphasis.
 *
 * One pass over the prose rather than two, because two passes cannot agree on
 * which of them owns an overlap: a column named after the tail of a table, or a
 * declared table that is both untracked and a prefix of a tracked one, would be
 * cut twice and the second pass would be segmenting text the first had already
 * claimed. A link beats a bold at the same position, since it carries the bold
 * with it and a destination as well.
 */
function proseForms(
  linkable: readonly string[],
  named: readonly string[],
  columns: readonly string[]
): Map<string, FormMark> {
  const marks = new Map<string, FormMark>();
  for (const [form, entity] of entityForms(linkable)) marks.set(form, { entity });
  for (const name of named) {
    for (const form of surfaceForms(name)) {
      const key = form.trim().toLowerCase();
      if (key && !marks.has(key)) marks.set(key, { emphasis: true, declaredTable: name });
    }
  }
  for (const form of columns.filter((column) => column.includes('_'))) {
    const key = form.trim().toLowerCase();
    if (key && !marks.has(key)) marks.set(key, { emphasis: true });
  }
  return new Map([...marks.entries()].sort(([a], [b]) => b.length - a.length));
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
 * Cut `prose` into runs, marking the ones that name something declared.
 *
 * Longest form first at each position, so a fully-qualified mention is linked
 * once as a whole rather than twice as its parts.
 *
 * `columns` is the surface's own column list and never a dictionary; a caller
 * with nothing to declare passes nothing and gets exactly the segmentation this
 * function produced before columns existed.
 */
export function linkifyEntities(
  prose: string,
  declared: readonly string[],
  tracked: readonly string[],
  columns: readonly string[] = []
): ProseSegment[] {
  if (!prose) return [];
  const linkable = linkableEntities(declared, tracked);
  // A declared table with no row on Connections. Named in the prose, so it is
  // bolded as an identifier, and unreachable, so it is not a link.
  const named = declared.filter((name) => !trackedEntity(name, linkable));
  const forms = proseForms(linkable, named, columns);
  if (forms.size === 0) return [{ text: prose, start: 0 }];

  const haystack = prose.toLowerCase();
  const segments: ProseSegment[] = [];
  let plainFrom = 0;
  let cursor = 0;
  while (cursor < prose.length) {
    let hit: { length: number; mark: FormMark } | undefined;
    for (const [form, mark] of forms) {
      if (haystack.startsWith(form, cursor) && boundedAt(prose, cursor, form.length)) {
        hit = { length: form.length, mark };
        break;
      }
    }
    if (!hit) {
      cursor += 1;
      continue;
    }
    if (cursor > plainFrom) segments.push({ text: prose.slice(plainFrom, cursor), start: plainFrom });
    segments.push({ text: prose.slice(cursor, cursor + hit.length), start: cursor, ...hit.mark });
    cursor += hit.length;
    plainFrom = cursor;
  }
  if (plainFrom < prose.length) segments.push({ text: prose.slice(plainFrom), start: plainFrom });
  return segments;
}
