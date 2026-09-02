/**
 * What a recorded tool result turns out to be, so the Run Explorer can draw the
 * shape rather than the text.
 *
 * Every tool this agent calls writes a result with a KNOWN structure, and the
 * step panel used to print all of them as prose. That is not a cosmetic
 * complaint. A Genie result carries four separable parts -- which space was
 * asked, how it read the question, the rows it got, and the sentence it wrote --
 * and run together in one paragraph the reader cannot tell the figure that was
 * measured from the figure the model restated. A semantic search result is a
 * preamble and a list of tables, and printed as prose its column lists became a
 * dash-run paragraph fifty words long.
 *
 * THE READING LIVES HERE AND NOT IN THE COMPONENT, for the reason every other
 * `*-map.ts` and `*-view.ts` in this directory exists: vitest runs on `node`, so
 * a rule written inside markup can be asserted against a rendered tree and never
 * against itself. It also means each parse can be handed a malformed payload in
 * a test without mounting anything.
 *
 * NOTHING HERE INVENTS OR REWRITES A FIGURE. The trims are boilerplate removal
 * -- the "Asking Genie space" line, the SEMANTIC SEARCH RESULTS notice, a "let
 * me know if you'd like" offer -- and every one of them is information the
 * header chrome states or the reader did not ask for. A parse that cannot find
 * the shape it is looking for returns null, and its caller falls back to
 * rendered markdown and then to the raw payload. Never to a blank.
 */

/** Which Genie space answered, as the tool recorded it. */
export interface GenieSpace {
  name: string | null;
  id: string;
}

/** A result set the tool returned, as a real grid. */
export interface ResultTable {
  head: string[];
  rows: string[][];
  /**
   * A line that was not a row of this grid, kept rather than dropped.
   *
   * `truncation_note` in agent/tools.py appends a sentence saying the rows are a
   * SAMPLE, which is the one thing a reader must not lose: a table presented
   * without it reads as the whole population.
   */
  note: string | null;
}

export interface GenieResult {
  space: GenieSpace | null;
  /** The interpretation sentence, boilerplate lead trimmed. */
  understood: string | null;
  table: ResultTable | null;
  /** The answer prose, as markdown, restatements of the table's figures removed. */
  answer: string | null;
}

/** One field of the dictionary, as the definition card draws it. */
export interface FieldDefinition {
  column: string;
  table: string | null;
  /** The governance rule on the field, or null when the row states none. */
  guardrail: string | null;
  definition: string;
  /** The answer's own conclusion, as markdown. */
  verdict: string | null;
}

export interface SemanticColumn {
  name: string;
  type: string;
}

export interface SemanticEntry {
  /** `table`, `metric`, … as the index recorded it. */
  kind: string;
  name: string;
  /** The first tag of the heading: `certified`, `uncertified`. */
  certification: string | null;
  description: string;
  columns: SemanticColumn[];
}

export interface SemanticResult {
  entries: SemanticEntry[];
  /** Whatever the tool said about this search that was not one of its standing notices. */
  note: string | null;
  /**
   * What the matches are, for the count above them: `table`, `metric`, `entry`.
   *
   * The entries' own word where they agree on one and `entry` where they do not,
   * so a mixed search says "5 entries matched" rather than calling three metrics
   * tables.
   */
  kind: string;
}

/** One `- **Label:** value` pair out of an agent step's source details. */
export interface Fact {
  label: string;
  /** Markdown, so the value keeps its bold figures and its backticked names. */
  value: string;
}

/**
 * One part of an agent step's markdown.
 *
 * Sectioned rather than handed over as one string because two of the three are
 * not paragraphs at all: a run of `- **Label:** value` pairs is a grid and a
 * trailing "Note:" is a callout, and both used to render as a wall of asterisks
 * inside a single `<p>`.
 */
export type ReportSection =
  | { kind: 'prose'; text: string }
  | { kind: 'facts'; facts: Fact[] }
  | { kind: 'note'; text: string };

export interface StructuredTableItem {
  name: string;
  /** Bracketed qualifiers carried beside the name, never folded into it. */
  metadata: string[];
}

export type StructuredTableSection =
  | { kind: 'prose'; text: string }
  | { kind: 'table-list'; heading: string; tables: StructuredTableItem[] };

export interface StructuredTableResult {
  sections: StructuredTableSection[];
  tableCount: number;
}

const DECLARED_TABLE_CAPTION =
  'This is the declared set in one listing. A missing franchise tag means untagged, not that the table cannot answer.';
const DECLARED_TABLE_HELP = 'Call describe_table for columns, types, and comments.';

/** Remove retired table-list boilerplate from every display projection, including Raw. */
export function withoutDeclaredTableCaption(text: string): string {
  return text
    .replace(DECLARED_TABLE_CAPTION, '')
    .replace('This is the declared set in one listing. A missing franchise tag means untagged.', '')
    .replace(DECLARED_TABLE_HELP, '')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

/** A run of a sentence, and whether it names a table or a column. */
export interface ChipRun {
  text: string;
  chip: boolean;
  /**
   * Where this run starts in the original sentence.
   *
   * Carried for the same reason `ProseSegment` carries one: it gives the renderer
   * a key that is a property of the run rather than of its position in an array.
   */
  start: number;
}

/** The tools whose result is a Genie conversation rather than a result set. */
const GENIE_TOOLS = new Set(['data_genie', 'dictionary_genie']);

/** The tools whose result is a list of semantic entries. */
const SEMANTIC_TOOLS = new Set(['search_semantics', 'search_tagged_assets']);

export type ResultShape = 'genie' | 'semantic' | 'report' | null;

/**
 * Which renderer a step's result gets.
 *
 * Chosen by the TOOL and not sniffed out of the text: which tool ran is a fact
 * the record carries, and a heuristic over the string would eventually promote a
 * result that merely looked like a Genie conversation. Null is the answer for
 * every tool with no shape of its own -- `run_sql`, `describe_table`, anything
 * added later -- and it means the reading the panel already had.
 */
export function resultShape(kind: string, tool: string | null): ResultShape {
  if (kind === 'agent') return 'report';
  if (!tool) return null;
  if (GENIE_TOOLS.has(tool)) return 'genie';
  if (SEMANTIC_TOOLS.has(tool)) return 'semantic';
  return null;
}

/**
 * What the row above the arguments is called.
 *
 * "Arguments" is the label for a payload with no question in it -- a
 * `describe_table` call is handed a table name and was not asked anything -- and
 * the other three say what the step was actually given, which is the design's
 * wording and the honest one for a reader who is not reading the code.
 */
export function argumentLabel(shape: ResultShape, asked: boolean): string {
  if (shape === 'report') return 'Worked from';
  if (shape === 'semantic') return 'Searched for';
  return asked ? 'Asked' : 'Arguments';
}

/**
 * Where an id is cut on the page: the first characters, an ellipsis, the last
 * four.
 *
 * The full value goes in `title` and on the clipboard, which is the rule for
 * every id in this app. Four at the end rather than none, because the reader's
 * actual task is comparing an id on screen with one in another tab, and two
 * space ids from the same workspace share a long prefix.
 */
const ID_HEAD = 8;
const ID_TAIL = 4;

/** A `tr-`-style family prefix, kept whole so the head is 8 of the id itself. */
const ID_PREFIX = /^[a-z]+-/;

export function truncatedId(id: string): string {
  const prefix = ID_PREFIX.exec(id)?.[0] ?? '';
  const body = id.slice(prefix.length);
  // Left whole when cutting it would save nothing. An id shorter than the two
  // halves plus the ellipsis comes back longer than it went in.
  if (body.length <= ID_HEAD + ID_TAIL + 1) return id;
  return `${prefix}${body.slice(0, ID_HEAD)}\u2026${body.slice(-ID_TAIL)}`;
}

/**
 * A sentence split around the table and column names in it.
 *
 * Two kinds of name are found: one the model wrote in backticks, and one it
 * wrote bare. The bare case is what makes this worth doing at all -- Genie's
 * interpretation sentence names `silver_player_profiles` as an ordinary word,
 * and the design sets every identifier in the app as a mono chip.
 *
 * A candidate has to LOOK like an identifier rather than merely be a word:
 * either a segment carries an underscore, or the name has three dotted parts,
 * which is a catalog.schema.object. Without that rule "e.g" in prose is a
 * two-part dotted name and chips itself.
 */
const NAME_CANDIDATE = /`([^`\n]+)`|([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)/g;

function looksLikeName(text: string): boolean {
  const parts = text.split('.');
  return parts.some((part) => part.includes('_')) || parts.length >= 3;
}

export function chipRuns(text: string): ChipRun[] {
  const runs: ChipRun[] = [];
  let plainFrom = 0;
  NAME_CANDIDATE.lastIndex = 0;
  for (let found = NAME_CANDIDATE.exec(text); found; found = NAME_CANDIDATE.exec(text)) {
    const quoted = found[1];
    const name = quoted ?? found[2];
    if (quoted === undefined && !looksLikeName(name)) continue;
    if (found.index > plainFrom) {
      runs.push({ text: text.slice(plainFrom, found.index), chip: false, start: plainFrom });
    }
    runs.push({ text: name, chip: true, start: found.index });
    plainFrom = found.index + found[0].length;
  }
  if (plainFrom < text.length) runs.push({ text: text.slice(plainFrom), chip: false, start: plainFrom });
  return runs;
}

/** Blank-line separated blocks, which is how the agent joins a tool's parts. */
function blocksOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Headings the agent uses before a structural list of governed tables.
 *
 * A heading is required. That is the safety boundary which stops an ordinary
 * sentence containing `one.two.three` from being promoted into a table list.
 */
const TABLE_LIST_HEADING =
  /^(?:declared(?: governed)? (?:sources|tables)|tables available|available tables|governed tables|source tables):?$/i;

const QUALIFIED_TABLE = /^(?:`?[^.`\s]+`?\.){2}`?[^.`\s]+`?$/;

function tableHeading(line: string): string | null {
  const plain = line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim();
  return TABLE_LIST_HEADING.test(plain) ? plain.replace(/:$/, '') : null;
}

function structuredTableLine(line: string): StructuredTableItem | null {
  const withoutBullet = line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
  const firstBracket = withoutBullet.indexOf('[');
  const name = (firstBracket === -1 ? withoutBullet : withoutBullet.slice(0, firstBracket)).trim().replaceAll('`', '');
  if (!QUALIFIED_TABLE.test(name)) return null;
  const remainder = firstBracket === -1 ? '' : withoutBullet.slice(firstBracket).trim();
  const metadata = [...remainder.matchAll(/\[([^\]\n]+)\]/g)].map((match) => match[1].trim());
  if (remainder.replace(/\[[^\]\n]+\]/g, '').trim()) return null;
  return { name, metadata };
}

/**
 * Structural table-list blocks inside a stage payload.
 *
 * The parser is deliberately line- and heading-bound. It accepts both the
 * bulleted `Listed available tables` result and the unbulleted
 * `Declared governed sources` package shown by the finder/writer stages, keeps
 * any number of blocks, and leaves every explanatory line in prose sections.
 * Raw still uses the original payload and never calls this function.
 */
export function structuredTableResult(text: string): StructuredTableResult | null {
  const lines = text.split(/\r?\n/);
  const sections: StructuredTableSection[] = [];
  const prose: string[] = [];
  let tableCount = 0;

  const flushProse = () => {
    const value = prose.join('\n').trim();
    prose.length = 0;
    if (value) sections.push({ kind: 'prose', text: value });
  };

  for (let index = 0; index < lines.length; ) {
    let heading = tableHeading(lines[index]);
    if (!heading) {
      prose.push(lines[index]);
      index += 1;
      continue;
    }

    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    while (cursor < lines.length) {
      const nested = tableHeading(lines[cursor]);
      if (!nested) break;
      heading = nested;
      cursor += 1;
      while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    }

    const tables: StructuredTableItem[] = [];
    while (cursor < lines.length) {
      const entry = structuredTableLine(lines[cursor]);
      if (!entry) break;
      tables.push(entry);
      cursor += 1;
    }

    if (tables.length === 0) {
      prose.push(lines[index]);
      index += 1;
      continue;
    }

    flushProse();
    sections.push({ kind: 'table-list', heading, tables });
    tableCount += tables.length;
    index = cursor;
  }

  flushProse();
  return tableCount > 0 ? { sections, tableCount } : null;
}

/**
 * `Asking Genie space Player Insights Data (d00dfeedd00dfeedd00dfeedd00dfeed).`
 *
 * Written out rather than elided. An eight-character head followed by an ellipsis
 * is the shape a real id leaves when someone shortens it for a comment, and
 * check-mirror-leaks.sh now reports that shape -- a live Genie space id reached a
 * publication in exactly this form, in this file's own sibling.
 *
 * `format_genie_space` in agent/config.py writes the title and the id when a
 * title is configured and the bare id when one is not, so the id is the half
 * that is always there and the name is optional.
 */
const ASKING = /^Asking Genie space\s+(?:(.+?)\s+)?\(?([0-9a-f]{8,}|[^\s()]+)\)?\.$/;

const INTERPRETATION = /^Query interpretation:\s*/;
const RESULT = /^Query result:\s*/;

/**
 * The openers Genie writes before saying what it read the question as.
 *
 * Trimmed so the row reads as its own label's answer: under "Understood as",
 * "You want to see the total number of players" restates the label and then
 * addresses the reader in the second person about their own question.
 */
const INTERPRETATION_OPENERS = [
  /^you want to see\s+/i,
  /^you want to know\s+/i,
  /^you (?:are asking|want to)\s+/i,
  /^you would like\s+/i,
];

/** `the silver_player_profiles table` — the name is the object, not the wrapper. */
const TABLE_WRAPPER = /\bthe (`?[A-Za-z][A-Za-z0-9_.]*`?) table\b/g;

export function understoodAs(interpretation: string): string {
  let text = interpretation.replace(INTERPRETATION, '').trim();
  for (const opener of INTERPRETATION_OPENERS) {
    if (opener.test(text)) {
      text = text.replace(opener, '');
      break;
    }
  }
  text = text.replace(TABLE_WRAPPER, '$1');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A row of `render_rows` output: ` | `-delimited, or one cell when there is one column. */
function splitRow(line: string): string[] {
  return line.includes('|') ? line.split('|').map((cell) => cell.trim()) : [line.trim()];
}

/**
 * The lines under "Query result:" as a grid.
 *
 * A single name over a single value is still a table, deliberately: it is the
 * commonest result this agent gets, and rendered as prose it is the one figure
 * the reader opened the step to check sitting in the middle of a sentence.
 *
 * A line the grid cannot hold is kept as a note rather than dropped or forced
 * into a row. `truncation_note` opens on a bracket, which is how the sample
 * disclosure is recognised even where the grid is one column wide and every
 * line therefore "fits".
 */
function resultTable(lines: string[]): ResultTable | null {
  const present = lines.filter((line) => line.trim() !== '');
  if (present.length === 0) return null;
  const head = splitRow(present[0]);
  const rows: string[][] = [];
  const notes: string[] = [];
  for (const line of present.slice(1)) {
    const cells = splitRow(line);
    if (!line.trim().startsWith('(') && cells.length === head.length) rows.push(cells);
    else notes.push(line.trim());
  }
  return { head, rows, note: notes.length > 0 ? notes.join(' ') : null };
}

/**
 * A clause restating a figure the Result table already shows.
 *
 * Genie writes "…as shown by the distinct_players value of 12,000" after a
 * sentence that has already given the number, and the table above it gives the
 * number a third time. The design's rule is that one figure renders once per
 * card, so the clause goes -- but only when the figure really is in the table,
 * because in a result the panel could not parse the clause is the only place it
 * appears.
 */
const RESTATEMENT = /,?\s*\(?(?:as|which is) (?:shown|reflected|given) (?:by|in)[^.)]*\)?/gi;

/**
 * A sentence that points back at the figure rather than adding to it.
 *
 * Narrow on purpose: it has to open on a demonstrative naming the QUANTITY, so
 * "This count represents the total number of unique players" is recognised and
 * "This result was truncated before it was returned" is not -- the second is a
 * disclosure about the rows, and dropping it would be the renderer hiding a
 * caveat to avoid printing a number twice.
 */
const BACK_REFERENCE = /^This (?:count|figure|number|total|value)\b/i;

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
}

function figuresIn(table: ResultTable | null): string[] {
  if (!table) return [];
  return table.rows.flatMap((row) => row.map((cell) => cell.replace(/[,\s]/g, '')));
}

/**
 * The answer with the table's own figures said once.
 *
 * Only the restating clause and a following sentence that merely points back at
 * it are removed, and only when the figure is in the table. The answer's own
 * substance stays: a real run's Genie answer often carries a bulleted list of
 * six grouped results, and truncating to one sentence would delete the result
 * set to avoid printing one number twice.
 */
function answerWithoutRestatement(paragraphs: string[], table: ResultTable | null): string | null {
  const figures = figuresIn(table);
  const kept = paragraphs.map((paragraph, at) => {
    if (at > 0) return paragraph;
    const trimmed = paragraph.replace(RESTATEMENT, (clause) =>
      figures.some((figure) => clause.replace(/[,\s]/g, '').includes(figure)) ? '' : clause
    );
    const sentences = sentencesOf(trimmed);
    if (sentences.length < 2) return trimmed.trim();
    // Dropped only when the table is there to have stated the figure already,
    // and only when the sentence opens by pointing at it. A closing sentence
    // that qualifies the number survives.
    const restates = figures.length > 0 && BACK_REFERENCE.test(sentences[sentences.length - 1]);
    return (restates ? sentences.slice(0, -1) : sentences).join(' ').trim();
  });
  const answer = kept.filter((paragraph) => paragraph.length > 0).join('\n\n');
  return answer.length > 0 ? answer : null;
}

/**
 * A Genie tool's result, as its four parts.
 *
 * Positional-agnostic: `_genie` in agent/tools.py appends the interpretation,
 * the rows and Genie's prose in whatever order the attachments arrive, and a
 * dictionary space returns the prose after the query it belongs to. So each
 * block is claimed by the marker it carries and everything unclaimed is answer.
 *
 * Null when no marker is found at all, which is a result this parse has nothing
 * to say about -- a refusal, an error, a model version that stopped writing the
 * preamble. The caller renders it as markdown instead.
 */
export function genieResult(text: string): GenieResult | null {
  let space: GenieSpace | null = null;
  let understood: string | null = null;
  let table: ResultTable | null = null;
  const answer: string[] = [];
  for (const block of blocksOf(text)) {
    const asking = ASKING.exec(block);
    if (asking) {
      space = { name: asking[1]?.trim() || null, id: asking[2] };
      continue;
    }
    if (INTERPRETATION.test(block)) {
      understood = understoodAs(block);
      continue;
    }
    if (RESULT.test(block)) {
      table = resultTable(block.replace(RESULT, '').split('\n'));
      continue;
    }
    answer.push(block);
  }
  if (!space && !understood && !table) return null;
  return { space, understood, table, answer: answerWithoutRestatement(answer, table) };
}

/** The dictionary's own column names, which is what makes a row a definition. */
const DEFINITION_COLUMNS = ['column_name', 'business_definition'];

/** How the guardrail's sentences are joined once they are one chip. */
function guardrailChip(text: string): string {
  const clauses = text
    .split('.')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return '';
  // Lower-cased after the first so the run reads as one rule rather than as a
  // row of sentences with the stops taken out. The ORDER is the row's own: this
  // is governance text, and a renderer that rearranges it is rewriting it.
  return clauses
    .map((clause, at) => (at === 0 ? clause : clause.charAt(0).toLowerCase() + clause.slice(1)))
    .join(' \u00b7 ');
}

/** Discourse markers the conclusion opens on, which say nothing about the field. */
const VERDICT_LEAD = /^(?:based on (?:this|the above)[^,]*|according to [^,]+|therefore|in summary|so),\s*/i;

/**
 * The one field a dictionary lookup was about, when its result is a definition.
 *
 * Read off the result table rather than out of the prose, because the table is
 * the dictionary's own row and the prose is the model's summary of it. A lookup
 * that returned several rows is NOT a definition card: the card states one
 * field, and picking the first of five rows would present one row's guardrail as
 * the answer to a question about five.
 */
export function fieldDefinition(result: GenieResult): FieldDefinition | null {
  const table = result.table;
  if (!table || table.rows.length !== 1) return null;
  const head = table.head.map((name) => name.trim().toLowerCase());
  if (!DEFINITION_COLUMNS.every((name) => head.includes(name))) return null;
  const cell = (name: string): string | null => {
    const at = head.indexOf(name);
    return at === -1 ? null : (table.rows[0][at]?.trim() ?? null);
  };
  const column = cell('column_name');
  const definition = cell('business_definition');
  if (!column || !definition) return null;
  const guardrail = cell('usage_guardrail');
  const sentences = result.answer ? sentencesOf(result.answer) : [];
  const verdict = sentences.length > 0 ? sentences[sentences.length - 1].replace(VERDICT_LEAD, '') : null;
  return {
    column,
    table: cell('table_name'),
    guardrail: guardrail ? guardrailChip(guardrail) : null,
    definition,
    verdict,
  };
}

/** `[table] catalog.schema.object (uncertified, Northwind)` */
const ENTRY_HEAD = /^\[([a-z_]+)\]\s+(\S+?)(?:\s+\(([^)]*)\))?\s*$/;

/** `Table catalog.schema.object. Description`, including a table-only block head. */
const TABLE_ENTRY = /^Table\s+((?:`?[^.`\s]+`?\.){2}`?[^.`\s]+`?)\.?(?:\s+(.*))?$/i;

/**
 * `- player_id (string)`, or with the type's own brackets, `- rate (decimal(5,4))`.
 *
 * The type is matched greedily up to the LAST bracket rather than the first,
 * because a type that carries a precision is the common case in this schema and a
 * first-bracket match left the whole line unread -- which did not lose it, it
 * appended it to the entry's description, so one row's `decimal(5,4)` arrived on
 * the end of the sentence above the columns.
 */
const ENTRY_COLUMN = /^-?\s*(\S+)\s+\((.+)\)(?::\s*(.*))?$/;

/** `Table catalog.schema.object.` — the name, which the row's own heading states. */
/**
 * The notices `RetrievalOutcome.rendered` appends to EVERY result, unconditionally.
 *
 * Both are addressed to the model -- what the entries may not be reported as, and
 * that a cached scope snapshot is not permission -- and both arrive verbatim on
 * every semantic step of every run. The first is what the header's "definitions,
 * not data" says in four words. They are the only two blocks dropped by name:
 * anything else the tool appends is kept as a note, because a notice this parse
 * has not been told about is more likely to be about THIS search than boilerplate
 * -- the omission count and the unverified-identity line both are.
 */
const STANDING_NOTICES = [/^SEMANTIC SEARCH RESULTS\b/, /^What appears above was filtered by\b/];

/**
 * A semantic search result as the tables it matched.
 *
 * The two standing notices are not rendered: they are instructions to the MODEL
 * about how to treat what follows, identical on every call, and the design
 * compresses the whole of the first into the phrase beside the count. Everything
 * else the tool appended is kept -- the entries it left out for budget, the line
 * saying the search ran unauthenticated -- because those are measurements of THIS
 * search, and a reader deciding whether a thin result means a thin semantic layer
 * needs them.
 *
 * Null when no entry heading is found, so a failure ("SEMANTIC SEARCH
 * UNAVAILABLE …") or an empty search falls through to markdown and keeps its
 * sentence, rather than rendering as a card saying nothing matched.
 */
export function semanticResult(text: string): SemanticResult | null {
  const entries: SemanticEntry[] = [];
  const notes: string[] = [];
  type Draft = SemanticEntry & { readingColumns: boolean };
  let current: Draft | null = null;
  let skippingNotice = false;

  const flush = () => {
    if (!current) return;
    const { readingColumns: _readingColumns, ...entry } = current;
    entries.push(entry);
    current = null;
  };

  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    const head = ENTRY_HEAD.exec(line);
    const tableLine = TABLE_ENTRY.exec(line);

    if (head) {
      flush();
      skippingNotice = false;
      const tags = head[3]?.split(',').map((tag) => tag.trim()) ?? [];
      current = {
        kind: head[1],
        name: head[2].replaceAll('`', ''),
        certification: tags[0] || null,
        description: '',
        columns: [],
        readingColumns: false,
      };
      continue;
    }

    if (tableLine) {
      const name = tableLine[1].replaceAll('`', '');
      const description = tableLine[2]?.trim() ?? '';
      if (!current || current.name.toLowerCase() !== name.toLowerCase()) {
        flush();
        current = {
          kind: 'table',
          name,
          certification: null,
          description,
          columns: [],
          readingColumns: false,
        };
      } else if (description) {
        current.description = [current.description, description].filter(Boolean).join(' ');
      }
      skippingNotice = false;
      continue;
    }

    if (STANDING_NOTICES.some((notice) => notice.test(line))) {
      skippingNotice = true;
      continue;
    }
    if (line === '') {
      skippingNotice = false;
      continue;
    }
    if (skippingNotice) continue;

    if (!current) {
      notes.push(line);
      continue;
    }
    if (/^Columns:\s*$/i.test(line)) {
      current.readingColumns = true;
      continue;
    }
    const column = current.readingColumns ? ENTRY_COLUMN.exec(line) : null;
    if (column) {
      current.columns.push({ name: column[1], type: column[2] });
      continue;
    }
    if (current.readingColumns) {
      flush();
      notes.push(line);
      continue;
    }
    current.description = [current.description, line].filter(Boolean).join(' ');
  }
  flush();
  if (entries.length === 0) return null;
  const kinds = new Set(entries.map((entry) => entry.kind));
  return {
    entries,
    kind: kinds.size === 1 ? entries[0].kind : 'entry',
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

/** A table name with the catalog dropped, and the object kept apart from it. */
export interface CollapsedName {
  /** The segments before the object, already elided where there were more than two. */
  lead: string;
  object: string;
}

/**
 * `<your_catalog>.<your_schema>.silver_player_profiles` at row width.
 *
 * The catalog is the segment a reader of ONE workspace's runs never needs and
 * the object is the one they are looking for, so the catalog is elided and the
 * object is emphasised. The full name stays in `title`: eliding it on the page
 * is a reading aid, and a name a reader cannot recover is a name they have to
 * open the raw payload for.
 */
export function collapsedName(name: string): CollapsedName {
  const parts = name.split('.');
  const object = parts[parts.length - 1];
  if (parts.length <= 2) return { lead: parts.slice(0, -1).join('.'), object };
  return { lead: `\u2026${parts[parts.length - 2]}`, object };
}

/** `**Source details:** - **Table:** …` — a lead, then inline label/value pairs. */
const FACT_LEAD = /^\*\*[^*\n]+?:?\*\*\s*(?=[-*]\s+\*\*)/;

const FACT_MARKER = /(?:^|\s+)[-*]\s+\*\*([^*\n]+?):?\*\*\s*/g;

/**
 * A run of `- **Label:** value` pairs, as rows of a label grid.
 *
 * The dashes are INLINE in what the agent writes: the whole run arrives as one
 * paragraph, which is why it rendered as a single sixty-word line of asterisks
 * and em dashes. Splitting on the markers is what turns it back into the rows it
 * was written as.
 */
export function factRows(source: string): Fact[] | null {
  const lead = FACT_LEAD.exec(source);
  if (!lead) return null;
  const rest = source.slice(lead[0].length);
  const facts: Fact[] = [];
  FACT_MARKER.lastIndex = 0;
  let found = FACT_MARKER.exec(rest);
  while (found) {
    const label = found[1].trim();
    const from = found.index + found[0].length;
    FACT_MARKER.lastIndex = from;
    const next = FACT_MARKER.exec(rest);
    const value = rest.slice(from, next ? next.index : rest.length).trim();
    if (value.length > 0) facts.push({ label, value });
    found = next;
  }
  return facts.length > 0 ? facts : null;
}

const NOTE_LEAD = /^Note:\s+/i;

/**
 * An offer to do more work, at the end of a note.
 *
 * "— let me know if you'd like that breakdown" is not a caveat about the figure,
 * which is what the callout is for, and it is addressed to a reader of a LIVE
 * answer rather than to somebody inspecting a stored run months later. Cut from
 * a dash or a comma so the sentence it hangs off keeps its stop.
 */
const NOTE_OFFER =
  /\s*[\u2014\u2013,-]?\s*(?:and\s+)?(?:just\s+)?(?:let me know|happy to|I can (?:also )?(?:provide|pull|run|break)|if you(?:'|\u2019)?d like me to)[^.]*\.?\s*$/i;

export function noteBody(source: string): string {
  return source.replace(NOTE_LEAD, '').replace(NOTE_OFFER, '').trim().replace(/[,;]$/, '.');
}

/**
 * An agent step's markdown, split into the three things it actually contains.
 *
 * Ordered as written rather than gathered by kind, because the note follows the
 * figures it qualifies and a callout hoisted above them would be a warning about
 * a number the reader has not seen yet.
 */
export function reportSections(text: string): ReportSection[] {
  return blocksOf(text).map((source): ReportSection => {
    const facts = factRows(source);
    if (facts) return { kind: 'facts', facts };
    if (NOTE_LEAD.test(source)) return { kind: 'note', text: noteBody(source) };
    return { kind: 'prose', text: source };
  });
}

/**
 * The keywords that open a clause, and so a line.
 *
 * A recorded statement arrives as Genie ran it, which is frequently one line
 * three hundred characters long: the Advanced panel wrapped it and the reader
 * got a paragraph of SQL. Broken before a clause rather than at a width, so the
 * same statement always breaks in the same places and two runs of it can be
 * compared down the page. `AND` is deliberately absent -- it joins predicates
 * inside a WHERE, and a line per predicate is a list, not a statement.
 */
const CLAUSE_KEYWORDS = [
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'GROUP BY',
  'ORDER BY',
  'UNION ALL',
  'QUALIFY',
  'HAVING',
  'SELECT',
  'UNION',
  'WHERE',
  'LIMIT',
  'FROM',
  'JOIN',
  'WITH',
];

const CLAUSE_PATTERN = new RegExp(
  `\\b(${CLAUSE_KEYWORDS.map((word) => word.replace(/ /g, '\\s+')).join('|')})\\b`,
  'gi'
);

/**
 * Whether a position in a statement is inside quotes or backticks.
 *
 * A column called `where` and a literal containing the word FROM are both real,
 * and breaking a line inside either produces a statement that no longer parses
 * -- which matters because the block offers a Copy button.
 */
function quotedSpans(statement: string): boolean[] {
  const inside: boolean[] = [];
  let quote: string | null = null;
  for (const character of statement) {
    if (quote) {
      inside.push(true);
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      inside.push(true);
      continue;
    }
    inside.push(false);
  }
  return inside;
}

/** A statement as one clause per line, whatever shape it was recorded in. */
export function sqlClauseLines(statement: string): string[] {
  const flat = statement.replace(/\s+/g, ' ').trim();
  const inside = quotedSpans(flat);
  const breaks: number[] = [];
  CLAUSE_PATTERN.lastIndex = 0;
  for (let found = CLAUSE_PATTERN.exec(flat); found; found = CLAUSE_PATTERN.exec(flat)) {
    if (found.index > 0 && !inside[found.index]) breaks.push(found.index);
  }
  const lines: string[] = [];
  let from = 0;
  for (const at of breaks) {
    lines.push(flat.slice(from, at).trim());
    from = at;
  }
  lines.push(flat.slice(from).trim());
  return lines.filter((line) => line.length > 0);
}

/**
 * The keywords the design picks out, which is a wider set than the ones that
 * open a line: `AND`, `AS` and `DISTINCT` are coloured where they sit rather
 * than broken onto lines of their own.
 *
 * Ordered longest-first, because the pattern is a single alternation and
 * `NOT` placed before `IS NOT NULL` would match inside it and leave the rest of
 * the phrase as plain text.
 */
const HIGHLIGHT_KEYWORDS = [
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'IS NOT NULL',
  'IS NULL',
  'CASE WHEN',
  'GROUP BY',
  'ORDER BY',
  'UNION ALL',
  'DISTINCT',
  'QUALIFY',
  'BETWEEN',
  'HAVING',
  'SELECT',
  'ILIKE',
  'UNION',
  'WHERE',
  'COUNT',
  'ROUND',
  'LIMIT',
  'FROM',
  'JOIN',
  'LIKE',
  'WITH',
  'THEN',
  'ELSE',
  'END',
  'SUM',
  'AND',
  'NOT',
  'AS',
  'ON',
  'OR',
  'IN',
];

const HIGHLIGHT_PATTERN = new RegExp(
  `\\b(${HIGHLIGHT_KEYWORDS.map((word) => word.replace(/ /g, '\\s+')).join('|')})\\b`,
  'gi'
);

/** A stretch of one SQL line, either a keyword or the text between keywords. */
export interface SqlRun {
  text: string;
  keyword: boolean;
  start: number;
}

/**
 * One line of SQL split around the keywords in it.
 *
 * Quoted and backticked stretches are skipped, so a column genuinely called
 * `count` stays the colour of a name. Without that the highlight argues with
 * itself: the reader is being shown which words are the language, and a
 * backticked identifier is the one thing on the line that certainly is not.
 */
export function sqlHighlightRuns(line: string): SqlRun[] {
  const inside = quotedSpans(line);
  const runs: SqlRun[] = [];
  let plainFrom = 0;
  HIGHLIGHT_PATTERN.lastIndex = 0;
  for (let found = HIGHLIGHT_PATTERN.exec(line); found; found = HIGHLIGHT_PATTERN.exec(line)) {
    if (inside[found.index]) continue;
    if (found.index > plainFrom) {
      runs.push({ text: line.slice(plainFrom, found.index), keyword: false, start: plainFrom });
    }
    runs.push({ text: found[0], keyword: true, start: found.index });
    plainFrom = found.index + found[0].length;
  }
  if (plainFrom < line.length) runs.push({ text: line.slice(plainFrom), keyword: false, start: plainFrom });
  return runs;
}

/**
 * The statements a run generated, separated.
 *
 * A run asks two Genie spaces and gets two statements back, recorded as one
 * field. Split on the semicolons that are not inside a literal, so the count in
 * the header is the number of statements and each one gets its own block instead
 * of one block that silently holds two.
 */
export function sqlStatements(sql: string): string[] {
  const inside = quotedSpans(sql);
  const statements: string[] = [];
  let from = 0;
  for (let at = 0; at < sql.length; at += 1) {
    if (sql[at] !== ';' || inside[at]) continue;
    statements.push(sql.slice(from, at + 1));
    from = at + 1;
  }
  statements.push(sql.slice(from));
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}
