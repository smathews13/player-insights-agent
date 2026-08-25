import { linkifyEntities, type ProseSegment } from './data-entities';
import { stripToolCallDumps } from './reader-facing-answer';

/**
 * The Markdown the agent writes, as a tree the answer card can render.
 *
 * The orchestrator has always written Markdown. It was authored against a
 * notebook, where `## DATA PACKAGE` is a heading and `- **Interpretation:**` is
 * a bulleted lead-in, and the app rendered both as the literal characters the
 * agent typed. Worse than ugly: `white-space` is not `pre-wrap` on the
 * narrative, so newlines collapsed too and a heading landed mid-sentence.
 *
 * WHY A PARSER HERE RATHER THAN A LIBRARY. Two reasons, and the second is the
 * one that decided it.
 *
 * 1. This output is untrusted. It is written by a model, crosses a serving
 *    endpoint, and lands in a customer's browser. The usual pipeline renders
 *    Markdown to an HTML string and then sanitises it, which is safe only for
 *    as long as the sanitiser's denylist keeps pace. There is no HTML string
 *    anywhere in this module. The tree below has five inline shapes and a small
 *    family of block shapes, none of which carries markup, so a `<script>` in the source
 *    has nowhere to go but a text run, and React escapes text runs. Raw HTML is
 *    not sanitised here, it is unrepresentable.
 *
 * 2. Entity linking has to survive. `linkifyEntities` used to run over one flat
 *    string; over a tree it has to run over the text inside the tree, or a
 *    table named in a heading or in bold silently stops linking. A library
 *    hands back rendered output, and reaching into it to re-segment its text
 *    nodes is more code than parsing the constructs we support, with the
 *    library's whole surface still shipping to the customer.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED. Underscore emphasis, above all: every
 * table this app links has underscores in it, and `_`-delimited emphasis would
 * eat `gold_title_daily_summary` and hand back a half-italic fragment that no
 * longer matches anything. Also absent: block quotes, images and backslash
 * escapes. Anything unsupported survives as the characters the
 * agent wrote, which is what the app did with all of it before this module
 * existed.
 *
 * TABLES ARE SUPPORTED, and they were the last construct in this list that the
 * agent writes on nearly every quantitative answer. An answer that aggregated
 * three weeks of sessions by day put its six columns on screen as the pipes and
 * the dashes the model typed -- `| Date | Sessions |` and a row of `---` under
 * it -- which is the same defect this module was written for, one construct
 * later, and the worst instance of it: a table is the one shape whose whole
 * value is that the figures line up, and unrendered it is the shape that reads
 * worst as plain text. See `tableBlock` below for what counts as one.
 */

/** A run of prose, or a code span, already cut into linkable segments. */
export interface InlineText {
  kind: 'text' | 'code';
  start: number;
  runs: ProseSegment[];
}

export type Inline =
  | InlineText
  | { kind: 'strong'; start: number; children: Inline[] }
  | { kind: 'link'; start: number; href: string; children: Inline[] }
  | { kind: 'break'; start: number };

export interface ListItem {
  start: number;
  children: Inline[];
}

/** How one column is read: down as digits, or across as words. */
export type CellAlign = 'left' | 'right' | 'center';

/**
 * Whether a column's values are single tokens or sentences.
 *
 * A date column is `atomic`: `2026-07-14` is one value, and a renderer that is
 * allowed to break it puts `202 / 6- / 07- / 14` on four lines in a narrow panel,
 * which is what the Monitoring drilldown was doing. A description column is
 * `prose` and has to be allowed to wrap, or one long cell makes the whole table
 * scroll past what a reader can hold.
 */
export type CellWrap = 'atomic' | 'prose';

export interface TableCell {
  start: number;
  children: Inline[];
}

export interface TableRow {
  start: number;
  cells: TableCell[];
}

export type Block =
  | { kind: 'paragraph'; start: number; children: Inline[] }
  | { kind: 'heading'; start: number; level: 2 | 3; children: Inline[] }
  | { kind: 'list'; start: number; ordered: boolean; items: ListItem[] }
  | { kind: 'rule'; start: number }
  | { kind: 'code'; start: number; language: string; text: string }
  | {
      kind: 'table';
      start: number;
      /** One entry per column, so a cell never has to work out its own. */
      align: CellAlign[];
      /**
       * One entry per column, on the same principle as `align`: whether the
       * column's cells are single values a renderer must keep whole, or prose it
       * must be free to wrap.
       */
      wrap: CellWrap[];
      /**
       * Absent when the model wrote data rows and no header. That happens, and
       * it is worth rendering rather than refusing: the stray row an answer
       * leaves after its table -- one day's figures, pipes and all -- is a row a
       * reader can read in columns and cannot read as punctuation.
       */
      header?: TableRow;
      rows: TableRow[];
    };

export type AnswerBlockSelection = 'all' | 'prose' | 'tables';

/**
 * Select parsed answer blocks without editing the Markdown source.
 *
 * This is the boundary used by the answer card to put prose in the narrative
 * column and tables in the evidence section. Filtering the parsed tree keeps
 * every character in the surviving blocks and avoids regex rules that can eat
 * a pipe used as prose or part of a fenced code block.
 */
export function selectAnswerBlocks(blocks: readonly Block[], selection: AnswerBlockSelection): Block[] {
  if (selection === 'all') return [...blocks];
  return blocks.filter((block) => (selection === 'tables' ? block.kind === 'table' : block.kind !== 'table'));
}

/** Plain text represented by an inline subtree, used only for metadata tests. */
function inlineValue(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text' || node.kind === 'code') return node.runs.map((run) => run.text).join('');
      if (node.kind === 'strong' || node.kind === 'link') return inlineValue(node.children);
      return '\n';
    })
    .join('')
    .trim();
}

/**
 * Gold / Silver / Raw / Reference labels. The model writes the first three as
 * a bold line and then bullets the last one, so Reference became a list item
 * while its siblings were headers. A label is that name, optional emoji, and
 * an optional parenthetical — not a lead-in like `- **Interpretation:** …`.
 */
const INVENTORY_TIER_LABEL =
  /^(?:[^\p{L}\p{N}]+\s*)?(gold|silver|raw|bronze|reference(?:\s*\/\s*metadata)?)\b(?:\s*\([^)]*\))?\s*$/iu;

function isInventoryTierLabel(nodes: readonly Inline[]): boolean {
  return INVENTORY_TIER_LABEL.test(inlineValue(nodes));
}

/**
 * Lift a bulleted tier label out of its list so it renders as a header, the
 * same rank as Gold / Silver / Raw, with the tables under it still a list.
 */
function splitInventoryTierLabels(list: Extract<Block, { kind: 'list' }>): Block[] {
  const blocks: Block[] = [];
  let items: ListItem[] = [];
  const flush = () => {
    if (items.length === 0) return;
    blocks.push({ kind: 'list', start: items[0].start, ordered: list.ordered, items });
    items = [];
  };
  for (const item of list.items) {
    if (isInventoryTierLabel(item.children)) {
      flush();
      blocks.push({ kind: 'paragraph', start: item.start, children: item.children });
      continue;
    }
    items.push(item);
  }
  flush();
  return blocks.length > 0 ? blocks : [list];
}

export interface TableStoryMetadata {
  timeSeries: boolean;
  baselineRowStart?: number;
  peakRowStart?: number;
}

const TIME_HEADER = /^(?:date|day|week|month|quarter|period|time|timestamp)$/i;
const TIME_CELL =
  /^(?:\d{4}(?:-\d{1,2}){0,2}|q[1-4]\s+\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+\d{1,2},?)?\s+\d{4})$/i;

function numericCell(nodes: readonly Inline[]): number | null {
  const text = inlineValue(nodes).replace(/[$€£,%\s]/g, '');
  const parenthesized = text.startsWith('(') && text.endsWith(')');
  const normalized = parenthesized ? `-${text.slice(1, -1)}` : text;
  if (!/^[-+\u2212]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized.replace('\u2212', '-'));
  return Number.isFinite(value) ? value : null;
}

/**
 * Whether baseline/peak storytelling is truthful for this table.
 *
 * A date-like heading is not enough: every first-column body cell must also be
 * a date or period. That excludes inventories and aggregate tables with a
 * trailing Total row, so they never acquire invented "baseline" or "peak"
 * labels. The peak is the maximum in the first numeric measure column, not
 * mechanically the last date: calling a declining final period "peak" would
 * reverse the evidence the table is showing.
 */
export function tableStoryMetadata(block: Extract<Block, { kind: 'table' }>): TableStoryMetadata {
  const heading = block.header?.cells[0] ? inlineValue(block.header.cells[0].children) : '';
  const values = block.rows.map((row) => (row.cells[0] ? inlineValue(row.cells[0].children) : ''));
  const timeSeries =
    block.rows.length >= 2 && TIME_HEADER.test(heading) && values.every((value) => TIME_CELL.test(value));
  if (!timeSeries) return { timeSeries: false };
  const measure = block.align.findIndex((align, column) => column > 0 && align === 'right');
  const measured =
    measure < 0
      ? []
      : block.rows.map((row) => ({
          start: row.start,
          value: row.cells[measure] ? numericCell(row.cells[measure].children) : null,
        }));
  const valid = measured.filter((entry): entry is { start: number; value: number } => entry.value !== null);
  const peak =
    valid.length === block.rows.length
      ? valid.reduce((highest, entry) => (entry.value > highest.value ? entry : highest))
      : null;
  return {
    timeSeries: true,
    baselineRowStart: block.rows[0].start,
    ...(peak ? { peakRowStart: peak.start } : {}),
  };
}

/**
 * Line shapes that open a block.
 *
 * Each matches only its marker and the whitespace after it, so the content is
 * the rest of the line and its offset is the length of the match. Requiring
 * that whitespace is what keeps `**Interpretation**` at the start of a line
 * from reading as a bullet whose marker is its first asterisk.
 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+/;
const BULLET = /^ {0,3}[-*+][ \t]+/;
const NUMBERED = /^ {0,3}\d{1,9}[.)][ \t]+/;

/** The schemes a link in agent prose may carry. */
const ALLOWED_SCHEME = /^(?:https?|mailto):/i;

/**
 * The href to render, or `''` when the answer proposed one we will not follow.
 *
 * Whitespace and control characters come out before the scheme is read, because
 * that is what a browser does when it resolves a URL: `java&#9;script:alert(1)`
 * is a working `javascript:` URL once the tab is discarded, and a check that
 * reads the raw string sees a scheme it does not recognise and shrugs.
 *
 * An absolute URL must name an allowed scheme. A relative one is kept: it can
 * only ever address this app. A scheme-relative `//host/path` is rejected,
 * because it is off-site while looking like a path.
 */
export function safeHref(raw: string): string {
  // Written as a scan rather than as a character class, because a class of
  // control characters is a lint error in this repo and suppressing the rule
  // here would read as though the control characters were an oversight. They
  // are the attack.
  let href = '';
  for (const character of raw) if (character.charCodeAt(0) > 0x20) href += character;
  if (!href || href.startsWith('//')) return '';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return ALLOWED_SCHEME.test(href) ? href : '';
  return href;
}

function textNode(kind: 'text' | 'code', text: string, start: number): InlineText {
  return { kind, start, runs: text ? [{ text, start }] : [] };
}

/** What one delimiter consumed: the nodes it produced and how far it reached. */
interface Taken {
  nodes: Inline[];
  length: number;
}

/**
 * A code span, from a run of backticks to the next run of the same length.
 *
 * Content is literal, so nothing inside is parsed further. That is the whole
 * point of the construct and it is also why a stray backtick in prose is safe:
 * with no closing fence this returns nothing and the backtick stays a backtick.
 */
function takeCode(source: string, at: number, base: number): Taken | undefined {
  const fence = /^`+/.exec(source.slice(at))?.[0];
  if (!fence) return undefined;
  const closeAt = source.indexOf(fence, at + fence.length);
  if (closeAt === -1 || closeAt === at + fence.length) return undefined;
  const inner = source.slice(at + fence.length, closeAt);
  return {
    nodes: [textNode('code', inner, base + at + fence.length)],
    length: closeAt + fence.length - at,
  };
}

function takeStrong(source: string, at: number, base: number): Taken | undefined {
  const closeAt = source.indexOf('**', at + 2);
  if (closeAt === -1 || closeAt === at + 2) return undefined;
  return {
    nodes: [{ kind: 'strong', start: base + at, children: parseInline(source.slice(at + 2, closeAt), base + at + 2) }],
    length: closeAt + 2 - at,
  };
}

/**
 * Where a link destination ends, counting nested parentheses.
 *
 * Not the next `)`. Real URLs carry parentheses, and stopping at the first one
 * truncates the destination and spills the rest of it into the prose as text.
 * That is cosmetic for a Wikipedia link and not cosmetic at all for
 * `javascript:alert(1)`, where the truncated half is refused and the `)` left
 * over is rendered.
 */
function closingParen(source: string, from: number): number {
  let depth = 1;
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === '(') depth += 1;
    else if (source[at] === ')') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

/**
 * An inline link, or its label alone when the URL is one we refuse.
 *
 * A refused link keeps its words and loses its target, which is what a reader
 * needs: the sentence still reads, and there is nothing to click. Printing the
 * rejected URL instead would put `javascript:...` on screen in a customer
 * demo, where it looks like a defect and invites someone to copy it.
 */
function takeLink(source: string, at: number, base: number): Taken | undefined {
  const closeLabel = source.indexOf(']', at + 1);
  if (closeLabel === -1 || source[closeLabel + 1] !== '(') return undefined;
  const closeHref = closingParen(source, closeLabel + 2);
  if (closeHref === -1) return undefined;
  const children = parseInline(source.slice(at + 1, closeLabel), base + at + 1);
  const href = safeHref(source.slice(closeLabel + 2, closeHref));
  const length = closeHref + 1 - at;
  return { nodes: href ? [{ kind: 'link', start: base + at, href, children }] : children, length };
}

/**
 * One line, or one span of a line, as inline nodes.
 *
 * `base` is where `source` sits in the whole answer, and every node records its
 * own offset there. That offset is the React key, and it has to be a property
 * of the node rather than its index in an array: the tracked table list arrives
 * one render after the prose does, so the same answer is segmented twice and an
 * index key would reconcile the wrong runs against each other.
 *
 * Delimiters are taken in the order they appear rather than by precedence,
 * which gives code spans priority over the emphasis inside them and emphasis
 * priority over a code span inside it, both of which are what Markdown means.
 */
function parseInline(source: string, base: number): Inline[] {
  const nodes: Inline[] = [];
  let plainFrom = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    let taken: Taken | undefined;
    if (character === '`') taken = takeCode(source, cursor, base);
    else if (character === '*' && source[cursor + 1] === '*') taken = takeStrong(source, cursor, base);
    else if (character === '[') taken = takeLink(source, cursor, base);
    // An unmatched delimiter is not a delimiter. Left where it was written.
    if (!taken) {
      cursor += 1;
      continue;
    }
    if (cursor > plainFrom) nodes.push(textNode('text', source.slice(plainFrom, cursor), base + plainFrom));
    nodes.push(...taken.nodes);
    cursor += taken.length;
    plainFrom = cursor;
  }
  if (plainFrom < source.length) nodes.push(textNode('text', source.slice(plainFrom), base + plainFrom));
  return nodes;
}

/** A line, its offset in the answer, and where its content starts. */
interface SourceLine {
  text: string;
  start: number;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const text of source.split('\n')) {
    lines.push({ text, start });
    start += text.length + 1;
  }
  return lines;
}

/** The content of a line after its block marker, with the offset it starts at. */
function contentAfter(line: SourceLine, marker: string): { text: string; start: number } {
  const rest = line.text.slice(marker.length);
  const lead = rest.length - rest.trimStart().length;
  return { text: rest.trim(), start: line.start + marker.length + lead };
}

/** One cell's source, and where in the answer it starts. */
interface RawCell {
  text: string;
  start: number;
}

/** A line that is a row, and the cells it cut into. */
interface RawRow {
  line: SourceLine;
  cells: RawCell[];
}

/**
 * The cells of a pipe row, or nothing when the line is not one.
 *
 * A LINE HAS TO WEAR AN OUTER PIPE TO PARTICIPATE, which is stricter than GFM,
 * where `Date | Sessions` with no delimiting pipes opens a table. The stricter
 * rule is the whole guard against a false table: this answer is prose written by
 * a model, `|` appears in it as a separator inside a sentence ("GB | DE | FR"),
 * and a rule that reads any pipe as a column boundary turns that sentence into a
 * three-column table with no way for a reader to get the sentence back. Every
 * table the agent actually writes carries the outer pipes.
 *
 * Two cells minimum, for the same reason. A single-cell row is a line that
 * happens to start with a pipe, and one column is not a table.
 *
 * Split on the pipe and nothing else -- not on pipes outside code spans, which
 * is also what GFM does. The row is cut into cells first and each cell is parsed
 * afterwards, so a backtick in one cell cannot reach across into the next.
 */
function rowCells(line: SourceLine): RawCell[] | undefined {
  const trimmed = line.text.trim();
  if (!trimmed.startsWith('|') && !trimmed.endsWith('|')) return undefined;
  const lead = line.text.length - line.text.trimStart().length;
  let from = lead;
  let to = lead + trimmed.length;
  if (trimmed.startsWith('|')) from += 1;
  if (trimmed.endsWith('|') && to - 1 > from) to -= 1;
  if (to < from) return undefined;
  const cells: RawCell[] = [];
  let at = 0;
  for (const piece of line.text.slice(from, to).split('|')) {
    const offset = piece.length - piece.trimStart().length;
    cells.push({ text: piece.trim(), start: line.start + from + at + offset });
    at += piece.length + 1;
  }
  return cells.length >= 2 ? cells : undefined;
}

/**
 * A pipe row that never wore the outer pipes GFM tables carry.
 *
 * Genie and a truncated synthesis both write `platform | players | sessions`
 * as an ASCII grid. The strict branch above refuses those lines so a sentence
 * like `GB | DE | FR` cannot become a table. This branch is the narrower door:
 * the separators must have space on both sides (so `Xbox Series X|S` stays one
 * cell), the line must not be a finished sentence, and the caller still has to
 * see two consecutive matching rows before it commits.
 */
function innerPipeCells(line: SourceLine): RawCell[] | undefined {
  const trimmed = line.text.trim();
  if (!trimmed || trimmed.startsWith('|') || trimmed.endsWith('|')) return undefined;
  if (/[.?!]$/.test(trimmed)) return undefined;
  if (!/\S\s+\|\s+\S/.test(trimmed)) return undefined;
  const parts = trimmed.split(/\s+\|\s+/).map((part) => part.trim());
  if (parts.length < 2) return undefined;
  const lead = line.text.length - line.text.trimStart().length;
  const cells: RawCell[] = [];
  let at = 0;
  for (const part of parts) {
    const slice = trimmed.slice(at);
    const offset = slice.indexOf(part);
    cells.push({ text: part, start: line.start + lead + at + Math.max(0, offset) });
    at += (offset < 0 ? 0 : offset) + part.length;
  }
  return cells;
}

function tableOpensAt(lines: readonly SourceLine[], from: number): RawRow[] | undefined {
  const line = lines[from];
  const strict = rowCells(line);
  if (strict) {
    const raw: RawRow[] = [{ line, cells: strict }];
    for (let at = from + 1; at < lines.length; at += 1) {
      const cells = rowCells(lines[at]);
      if (!cells) break;
      raw.push({ line: lines[at], cells });
    }
    return raw;
  }
  const opening = innerPipeCells(line);
  if (!opening) return undefined;
  const raw: RawRow[] = [{ line, cells: opening }];
  for (let at = from + 1; at < lines.length; at += 1) {
    const cells = innerPipeCells(lines[at]) ?? rowCells(lines[at]);
    if (!cells || cells.length !== opening.length) break;
    raw.push({ line: lines[at], cells });
  }
  // One inner-pipe line is prose. Two matching rows is a grid.
  return raw.length >= 2 ? raw : undefined;
}

/** A delimiter cell: dashes, with a colon on either end to ask for an alignment. */
const DELIMITER_CELL = /^:?-+:?$/;

/**
 * What the delimiter row under a header asked for, or nothing when the row is
 * not a delimiter row at all.
 *
 * A column is `undefined` when its cell is a plain run of dashes, which is what
 * the agent writes: the model states the columns and leaves the alignment to the
 * reader's renderer, and `left` and "unstated" have to be told apart so that
 * `alignFor` below can look at the figures instead of guessing.
 */
function delimiterAligns(cells: readonly RawCell[]): (CellAlign | undefined)[] | undefined {
  if (!cells.every((cell) => DELIMITER_CELL.test(cell.text))) return undefined;
  return cells.map((cell) => {
    const left = cell.text.startsWith(':');
    const right = cell.text.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : undefined;
  });
}

/**
 * A cell's text with its emphasis and its code marks off it.
 *
 * The last row of an aggregate table is the total and the agent bolds it, so the
 * figure in it arrives as `**$1,381.16**`. Read literally that is not a number,
 * and a column whose last cell "is not a number" loses its alignment on the one
 * row a reader most wants lined up under the rest.
 */
function bareCell(text: string): string {
  return text.replace(/[*`]/g, '').trim();
}

/**
 * A figure, as the agent formats one.
 *
 * Currency and a thousands separator are in, because the answers this was
 * written for report bookings in dollars. A date is deliberately OUT: `2026-08-03`
 * is digits and nothing else, and right-aligning the date column of a daily table
 * pushes the one value a reader scans down the column away from its own heading.
 * Which is the whole reason this is a pattern over the whole cell rather than a
 * count of the digits in it.
 */
const NUMERIC_CELL = /^[-+\u2212(]?\s*[$€£]?\s*\d+(?:,\d{3})*(?:\.\d+)?\s*%?\)?$/;

/**
 * How one column is aligned: what the delimiter row said, or what its figures
 * say when the delimiter row said nothing.
 *
 * A column is right-aligned only when EVERY value in it is a figure. One cell of
 * prose in a column of numbers means the column is a mixed column, and a mixed
 * column read as digits sets its sentence flush against the column to its right.
 */
function alignFor(
  column: number,
  declared: readonly (CellAlign | undefined)[] | undefined,
  rows: readonly RawRow[]
): CellAlign {
  const stated = declared?.[column];
  if (stated) return stated;
  let figures = 0;
  for (const row of rows) {
    const cell = row.cells[column];
    if (!cell || !cell.text) continue;
    if (!NUMERIC_CELL.test(bareCell(cell.text))) return 'left';
    figures += 1;
  }
  return figures > 0 ? 'right' : 'left';
}

/**
 * The longest a cell can be and still be one value rather than a sentence.
 *
 * Sized off what the agent's own columns hold: a date (`2026-07-14`), a figure
 * (`$1,381.16`), a country code, an outcome word, a column name in backticks.
 * A description, a caveat or a table's fully-qualified name is longer than this
 * and is the thing that has to keep wrapping.
 */
const ATOMIC_CELL_MAX = 18;

/**
 * Whether a column holds single values or prose.
 *
 * Judged on the body only. Header cells are already drawn on one line -- a
 * column name is one or two words above its numbers -- so a long heading over
 * short values does not make the values wrappable.
 */
function wrapFor(column: number, rows: readonly RawRow[]): CellWrap {
  for (const row of rows) {
    const cell = row.cells[column];
    if (!cell || !cell.text) continue;
    if (bareCell(cell.text).length > ATOMIC_CELL_MAX) return 'prose';
  }
  return 'atomic';
}

function tableRow(row: RawRow, width: number): TableRow {
  return {
    start: row.line.start,
    // Truncated to the header's width, which is GFM's rule and is also the only
    // safe one: an extra cell has no column, so no alignment and no heading, and
    // rendering it would put a figure under a heading that does not describe it.
    cells: row.cells
      .slice(0, width)
      .map((cell) => ({ start: cell.start, children: parseInline(cell.text, cell.start) })),
  };
}

function looksLikeHeaderRow(row: RawRow, rest: readonly RawRow[]): boolean {
  if (rest.length === 0) return false;
  const names = row.cells.every((cell) => Boolean(cell.text) && !NUMERIC_CELL.test(bareCell(cell.text)));
  const figures = rest.some((entry) => entry.cells.some((cell) => NUMERIC_CELL.test(bareCell(cell.text))));
  return names && figures;
}

/**
 * A run of pipe rows, as a table -- or nothing, when there is no table in them.
 *
 * The header is the first row when a delimiter row follows it, which is what
 * tells a heading apart from a datum. Without one, a first row of names over
 * rows of figures is still a heading -- the ASCII grids Genie writes never
 * carry `--- | ---` -- and promoting that row is what lets a renderer draw
 * `<th>` instead of leaving the column names as the first data row.
 *
 * A delimiter row anywhere else is dropped rather than rendered. It carries no
 * cell a reader can read, and a model that writes a second one is ruling off its
 * own rows, not adding to them.
 */
function tableBlock(raw: readonly RawRow[]): Block | undefined {
  if (raw.length === 0) return undefined;
  const declared = raw.length > 1 ? delimiterAligns(raw[1].cells) : undefined;
  const inferred = !declared && raw.length >= 2 && looksLikeHeaderRow(raw[0], raw.slice(1));
  const header = declared || inferred ? raw[0] : undefined;
  const body = raw.slice(header ? (declared ? 2 : 1) : 0).filter((row) => !delimiterAligns(row.cells));
  if (body.length === 0) return undefined;
  const width = header ? header.cells.length : Math.max(...body.map((row) => row.cells.length));
  const align: CellAlign[] = [];
  const wrap: CellWrap[] = [];
  for (let column = 0; column < width; column += 1) {
    align.push(alignFor(column, declared, body));
    wrap.push(wrapFor(column, body));
  }
  const block: Block = {
    kind: 'table',
    start: raw[0].line.start,
    align,
    wrap,
    rows: body.map((row) => tableRow(row, width)),
  };
  return header ? { ...block, header: tableRow(header, width) } : block;
}

/** A fence line: three or more backticks or tildes, whatever follows them. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

/**
 * A nested marker that sat past the three-space window `BULLET` / `NUMBERED`
 * allow, so the line is still an item of the list above it.
 */
const NESTED_MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/**
 * Whether this line opens a different block than the list already being read.
 *
 * Tables, headings, fences and the other list kind stay their own blocks -- a
 * Markdown table under "Findings / data" is still a table. The findings lines
 * themselves are not any of these.
 */
function listStopsAt(lines: readonly SourceLine[], index: number, ordered: boolean): boolean {
  const text = lines[index].text;
  if (HEADING.test(text) || THEMATIC_BREAK.test(text) || FENCE.test(text)) return true;
  if (ordered ? BULLET.test(text) : NUMBERED.test(text)) return true;
  return Boolean(tableOpensAt(lines, index));
}

/**
 * The content of a line that belongs to the open list without a marker in the
 * first three columns.
 *
 * THE DATA PACKAGE WRITES THESE. "Findings / data" is a lead-in; the figures
 * under it -- "90-day headline totals…", "Weekly trend…" -- are their own lines,
 * indented or flush, often without a dash. The list branch used to stop at the
 * first of those, and they came out as a paragraph: same left edge as the items
 * above, no dot. Sources under the same heading already wear `- ` and kept
 * theirs. The card is one list; a line that sits in it is an item of it.
 *
 * A nested `- ` past the three-space window (CommonMark's nested list) is the
 * same case with its marker still on. The marker comes off so the card's dot
 * is the only one.
 */
function looseListItem(line: SourceLine): { text: string; start: number } {
  const indent = line.text.length - line.text.trimStart().length;
  const trimmed = line.text.trim();
  const nested = NESTED_MARKER.exec(trimmed);
  if (nested) return contentAfter({ text: trimmed, start: line.start + indent }, nested[0]);
  return { text: trimmed, start: line.start + indent };
}

/** The next line that has text, or past the end. */
function nextNonBlank(lines: readonly SourceLine[], from: number): number {
  let index = from;
  while (index < lines.length && !lines[index].text.trim()) index += 1;
  return index;
}

/**
 * The table inside a fenced block, when that is all the block holds.
 *
 * WHY THIS RUNS BEFORE THE CODE BRANCH. Fenced blocks are code unless this
 * stricter branch proves that the whole fence is a table. A fenced table is not
 * a rare accident: a model asked for a table
 * inside a JSON field very often fences it, and the reader then gets the pipes
 * AND three backticks above them. The pipes leaking through a fence is one of
 * the two ways this defect reaches a screen and it has the same cause and the
 * same fix as the other.
 *
 * ONLY WHEN THE FENCE HOLDS NOTHING ELSE. Every non-blank line inside has to be
 * a pipe row. A fence with a sentence in it is a fence the agent meant, most
 * likely SQL or JSON, and the pipes in a `CASE WHEN` are not columns.
 */
function fencedTable(lines: readonly SourceLine[], from: number): { block: Block; next: number } | undefined {
  const fence = FENCE.exec(lines[from].text)?.[1];
  if (!fence) return undefined;
  let close = from + 1;
  while (close < lines.length && !lines[close].text.trim().startsWith(fence)) close += 1;
  // An unclosed fence is a fence the agent is still writing, or one it never
  // finished. Either way there is no block here to read to the end of.
  if (close >= lines.length) return undefined;
  const raw: RawRow[] = [];
  for (const line of lines.slice(from + 1, close)) {
    if (!line.text.trim()) continue;
    const cells = rowCells(line) ?? innerPipeCells(line);
    if (!cells) return undefined;
    raw.push({ line, cells });
  }
  const block = tableBlock(raw);
  return block ? { block, next: close + 1 } : undefined;
}

/** A fenced block that is code rather than a table. */
function fencedCode(lines: readonly SourceLine[], from: number): { block: Block; next: number } | undefined {
  const opening = FENCE.exec(lines[from].text);
  const fence = opening?.[1];
  if (!fence) return undefined;
  let close = from + 1;
  while (close < lines.length && !lines[close].text.trim().startsWith(fence)) close += 1;
  if (close >= lines.length) return undefined;
  const language = lines[from].text.slice(opening[0].length).trim().split(/\s+/, 1)[0] ?? '';
  return {
    block: {
      kind: 'code',
      start: lines[from].start,
      language,
      text: lines
        .slice(from + 1, close)
        .map((line) => line.text)
        .join('\n'),
    },
    next: close + 1,
  };
}

/**
 * The answer, as blocks.
 *
 * Blank lines separate blocks; consecutive lines of prose are one paragraph
 * with a hard break between them. A hard break rather than the space Markdown
 * would insert, because this text is read as a chat message: the agent wraps
 * its own lines meaningfully, and joining them is the collapse this module
 * exists to fix, just done deliberately.
 */
export function parseAnswerMarkdown(source: string): Block[] {
  const lines = sourceLines(source);
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.text.trim()) {
      index += 1;
      continue;
    }

    // Before the heading check, because a fence is not a heading and the fence
    // branch declines every block that is not a table -- so a fenced SQL
    // statement falls through to exactly the lines it fell through to before.
    const fenced = fencedTable(lines, index);
    if (fenced) {
      blocks.push(fenced.block);
      index = fenced.next;
      continue;
    }
    const code = fencedCode(lines, index);
    if (code) {
      blocks.push(code.block);
      index = code.next;
      continue;
    }

    const heading = HEADING.exec(line.text);
    if (heading) {
      const content = contentAfter(line, heading[0]);
      // Clamped to two levels. The card already has a heading -- the takeaway
      // above this prose -- so nothing in here may be a title, and six sizes
      // inside one chat bubble would be a document, not an answer.
      const level = heading[1].length <= 2 ? 2 : 3;
      blocks.push({ kind: 'heading', start: line.start, level, children: parseInline(content.text, content.start) });
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line.text)) {
      blocks.push({ kind: 'rule', start: line.start });
      index += 1;
      continue;
    }

    // Before the list check, so that a delimiter row written without its outer
    // pipes -- `--- | ---` -- is read as part of the table above it rather than
    // as a bullet whose marker is its first dash.
    const raw = tableOpensAt(lines, index);
    if (raw) {
      const table = tableBlock(raw);
      // Only the rows the table took. A run of pipe rows that is nothing but
      // delimiters is not a table, and leaving `index` alone lets it fall
      // through to the paragraph branch below -- as the characters it is, which
      // is what every unsupported construct here does.
      if (table) {
        blocks.push(table);
        index += raw.length;
        continue;
      }
    }

    const ordered = !BULLET.test(line.text) && NUMBERED.test(line.text);
    if (ordered || BULLET.test(line.text)) {
      const items: ListItem[] = [];
      const marker = ordered ? NUMBERED : BULLET;
      // Same-kind markers stay items of this list. A numbered list following a
      // bulleted one is still a second list. Lines under a lead-in that do not
      // wear a marker -- the findings body of a data package -- stay items too,
      // so they keep the same dot as Interpretation and Package note.
      while (index < lines.length) {
        if (!lines[index].text.trim()) {
          const next = nextNonBlank(lines, index);
          // A blank between items is still this list. A blank before a table,
          // heading, fence or the other list kind is the end of it.
          if (next >= lines.length || listStopsAt(lines, next, ordered)) break;
          index = next;
          continue;
        }
        const item = marker.exec(lines[index].text);
        const content = item
          ? contentAfter(lines[index], item[0])
          : listStopsAt(lines, index, ordered)
            ? undefined
            : looseListItem(lines[index]);
        if (!content) break;
        items.push({ start: lines[index].start, children: parseInline(content.text, content.start) });
        index += 1;
      }
      blocks.push(...splitInventoryTierLabels({ kind: 'list', start: line.start, ordered, items }));
      continue;
    }

    const children: Inline[] = [];
    for (; index < lines.length; index += 1) {
      const current = lines[index];
      if (!current.text.trim()) break;
      if (
        HEADING.test(current.text) ||
        BULLET.test(current.text) ||
        NUMBERED.test(current.text) ||
        THEMATIC_BREAK.test(current.text) ||
        FENCE.test(current.text)
      )
        break;
      // A table that opens on the line after a sentence, with no blank line
      // between them, is still a table. Without this the paragraph swallowed it
      // and every row of it came out as pipes inside a run of prose -- which is
      // how the reported defect looked on the answer it was reported from,
      // because the agent introduces its tables in a sentence and does not
      // always leave a blank line after it.
      // Not on the paragraph's own first line, which is how a run of pipe rows
      // that the table branch already refused gets to be the text it is rather
      // than a paragraph that breaks before it starts.
      if (children.length > 0 && (rowCells(current) || tableOpensAt(lines, index))) break;
      // Keyed on the newline that produced it, which is a position no node
      // built from the line either side of it can also claim.
      if (children.length > 0) children.push({ kind: 'break', start: current.start - 1 });
      const lead = current.text.length - current.text.trimStart().length;
      children.push(...parseInline(current.text.trim(), current.start + lead));
    }
    blocks.push({ kind: 'paragraph', start: line.start, children });
  }
  return blocks;
}

function linkifyRuns(
  runs: readonly ProseSegment[],
  declared: readonly string[],
  tracked: readonly string[],
  columns: readonly string[]
) {
  const linked: ProseSegment[] = [];
  for (const run of runs) {
    for (const segment of linkifyEntities(run.text, declared, tracked, columns)) {
      linked.push({ ...segment, start: run.start + segment.start });
    }
  }
  return linked;
}

/**
 * The same tree, with the tables this answer declared made clickable.
 *
 * Run over the text inside the tree rather than over the Markdown source, which
 * is the point of doing it here at all. Matching the source would find table
 * names inside `**` and backtick delimiters and cut segments that straddle
 * them, and the offsets it produced would address the source rather than the
 * rendered text.
 *
 * CODE SPANS ARE LINKED. The customer's convention is to write field and table
 * names in backticks, so the alternative is that adopting their own house style
 * silently switches this feature off: every table name in an answer would be in
 * a code span, and none of them would link. The usual objection, that a code
 * span is literal and a link inside one is a surprise, does not carry here
 * because the link set is not a dictionary lookup. A run only links when the
 * answer declared that table as a source AND the Connections page has a row for it,
 * so there is no reading of an answer under which the link is unwanted.
 *
 * LINK LABELS ARE NOT. An `<a>` inside an `<a>` is invalid HTML and the browser
 * un-nests it, so a table name inside a link the agent wrote stays plain text.
 */
function linkifyInline(
  nodes: readonly Inline[],
  declared: readonly string[],
  tracked: readonly string[],
  columns: readonly string[]
): Inline[] {
  return nodes.map((node) => {
    if (node.kind === 'text' || node.kind === 'code') {
      return { ...node, runs: linkifyRuns(node.runs, declared, tracked, columns) };
    }
    if (node.kind === 'strong') return { ...node, children: linkifyInline(node.children, declared, tracked, columns) };
    return node;
  });
}

/**
 * Answer prose as renderable blocks, entities linked.
 *
 * `columns` is optional and empty for an answer: the answer payload declares
 * sources and no columns, so nothing changes for the surface this was written
 * for. The plan card passes the columns its own steps list, which is the only
 * payload in the app that states them.
 */
export function answerBlocks(
  source: string,
  declared: readonly string[],
  tracked: readonly string[],
  columns: readonly string[] = []
): Block[] {
  // Case by case rather than one spread over the union: spreading a union of
  // block shapes widens the result to a shape with every field optional, which
  // is no longer a `Block`.
  return parseAnswerMarkdown(stripToolCallDumps(source)).map((block): Block => {
    const linkRow = (row: TableRow): TableRow => ({
      ...row,
      cells: row.cells.map((cell) => ({ ...cell, children: linkifyInline(cell.children, declared, tracked, columns) })),
    });
    switch (block.kind) {
      // A cell is linked on the same two rules as a sentence: the answer cited
      // the table and Connections has a row for it. Worth stating because a
      // table of geographies looks like a table of entities and is not one --
      // "Germany" is a country, the answer declared no such source, and nothing
      // in the cell matches a tracked name, so nothing in it links.
      case 'table':
        return {
          ...block,
          ...(block.header ? { header: linkRow(block.header) } : {}),
          rows: block.rows.map(linkRow),
        };
      case 'list':
        return {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            children: linkifyInline(item.children, declared, tracked, columns),
          })),
        };
      case 'heading':
        return { ...block, children: linkifyInline(block.children, declared, tracked, columns) };
      case 'paragraph':
        return { ...block, children: linkifyInline(block.children, declared, tracked, columns) };
      case 'rule':
      case 'code':
        return block;
    }
  });
}

/**
 * The same, for the surfaces that are a sentence rather than a document.
 *
 * The caveat list and the degraded-answer banner render inside a running
 * sentence, after a bolded lead-in. Blocks there would break the line and put a
 * heading inside an alert, so those surfaces take the inline constructs --
 * bold, code, links -- and leave a `##` as the characters the agent wrote.
 */
export function answerInline(
  source: string,
  declared: readonly string[],
  tracked: readonly string[],
  columns: readonly string[] = []
): Inline[] {
  return linkifyInline(parseInline(source, 0), declared, tracked, columns);
}

/**
 * Whether any of these bodies carries a table.
 *
 * What decides, in AnswerEvidence.tsx, whether there is anything to fold in
 * behind a chart -- and so whether a chart that fails to paint takes the only
 * copy of the numbers with it. Absent and empty bodies count as carrying
 * nothing, so a caller can pass an optional second body without guarding it.
 */
export function carriesTable(...bodies: (string | null | undefined)[]): boolean {
  return bodies.some((body) =>
    body ? parseAnswerMarkdown(stripToolCallDumps(body)).some((block) => block.kind === 'table') : false
  );
}
