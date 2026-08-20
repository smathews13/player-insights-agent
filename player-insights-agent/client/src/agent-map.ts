/**
 * What the Agent map prints, decided here rather than inside the markup.
 *
 * The map draws a card per stage and a panel under whichever card is open, and
 * every string on both is a re-reading of something the run recorded. Keeping
 * that reading in a module of its own is what lets the suite check it without a
 * DOM: vitest runs on `node`, so a rule that only exists inside a component can
 * be asserted against rendered markup and never against the rule itself.
 *
 * Nothing here invents a figure. A stage that recorded no start, no arguments or
 * no result comes back as an absence the caller has to render as words; there is
 * no branch that substitutes a zero for a measurement nobody took.
 */
import { formatMs, toolNameFromId } from './trace-timeline';
import type { TraceStage } from './answer-shape';

/**
 * The step's place in the run, two digits.
 *
 * A wrapped grid takes reading order away from position, so the number is what
 * puts it back, and a fixed width is what makes a column of them line up:
 * "1" beside "12" reads as a ragged edge before it reads as an index. Runs past
 * ninety-nine steps print their real number rather than being clipped to two.
 *
 * The map and the rail both read this, which is what makes their numbers the
 * same numbers: the design asks a reader to carry a step number from one pane to
 * the other, and two independent counters would eventually let them differ.
 */
export function stepNumber(step: number): string {
  return step < 10 ? `0${step}` : String(step);
}

/**
 * The card's duration badge, formatted exactly like the Timeline.
 *
 * Calls are deliberately separate. Combining unlike measures into one string
 * made the duration jump horizontally as the count grew and left neither value
 * looking like the compact badge it is.
 */
export function cardTiming(stage: Pick<TraceStage, 'duration'>): string {
  return formatMs(stage.duration);
}

/** The card's call-count badge, with its unit always explicit. */
export function cardCalls(stage: Pick<TraceStage, 'calls'>, toolCalls = false): string {
  const unit = toolCalls ? 'tool call' : 'call';
  return `${stage.calls} ${unit}${stage.calls === 1 ? '' : 's'}`;
}

/** The model turn that hands work to tools is an Orchestrator step. */
export function isOrchestratorStep(stage: Pick<TraceStage, 'id' | 'name'>): boolean {
  return /^step-\d+$/.test(stage.id) && stage.name === 'Chose the next step';
}

/**
 * The panel's right-pinned line: when the stage started, how long it took, and
 * how many calls it was.
 *
 * One line rather than the two labelled rows this panel used to open with, which
 * is the design's decision and also removes the two things a reader had to scan
 * a grid for. A start that was never measured says so in words: `startMeasured`
 * exists because a missing origin and an origin of zero arrive as the same
 * number, and the first stage of every run legitimately starts at zero.
 */
export function detailTiming(stage: TraceStage, origin: number): string {
  const started =
    stage.startMeasured === false ? 'start not recorded' : `started +${formatMs(stage.start - origin)}`;
  const calls = `${stage.calls} call${stage.calls === 1 ? '' : 's'}`;
  return `${started} · took ${formatMs(stage.duration)} · ${calls}`;
}

/**
 * The rail's right-pinned figure: how long the step took, and nothing else.
 *
 * No call count, which is the live spec's instruction and also the reading that
 * matches the pane: a step that made N sub-calls shows them as its own indented
 * children, each numbered, so "· 3" beside the parent would be counting the
 * three cards underneath it a second time.
 */
export function railTiming(stage: Pick<TraceStage, 'duration' | 'status'>, elapsedMs: number | null = null
): string {
  if (stage.status !== 'running') return formatMs(stage.duration);
  // A step that has been announced and has not reported has no duration to
  // print, and `stage.duration` is 0 for exactly that reason. `elapsedMs` is the
  // rail's own count of how long ago the announcement arrived, so it is present
  // while the run is going and absent the instant it ends.
  return elapsedMs === null ? RAIL_UNFINISHED : tickingTiming(elapsedMs);
}

/**
 * The counter on the step in progress: whole seconds, and an ellipsis saying the
 * figure is still moving.
 *
 * Whole seconds because it is a number the reader watches rather than compares:
 * `formatMs` prints two decimals, which at one update a second is three digits
 * changing under the eye to say the same thing. The ellipsis is the part that
 * makes it honest — every other figure in this pane is a completed measurement,
 * and this one is a measurement in progress, so it must not be readable as one
 * of them.
 *
 * Measured from the browser clock rather than from the stage's own `start`,
 * which is an offset into the agent's run and shares no epoch with this machine.
 */
export function tickingTiming(elapsedMs: number): string {
  return `${Math.max(0, Math.floor(elapsedMs / 1000))}s\u2026`;
}

/**
 * What a step that was announced and never reported shows instead of a duration.
 *
 * A run that dies mid-step leaves its last row unresolved, and the reader is
 * looking at it: the badge names that step as where the run stopped. It cannot
 * print a duration, because none was ever reported, and it must not keep the
 * live counter's ellipsis, which reads as a figure still moving on a run that
 * has ended.
 */
export const RAIL_UNFINISHED = 'not finished';

/** How far one nesting level indents a card in the rail. */
export const RAIL_INDENT = 26;

/** Where the first lane sits: the centre of a left-edge card's number badge. */
export const RAIL_LANE = 19;

/** The height of the connector row between two cards. */
export const RAIL_CONNECTOR_HEIGHT = 16;

/** The x a card's number badge is centred on, for a card at this depth. */
export function railLane(depth: number): number {
  return RAIL_LANE + depth * RAIL_INDENT;
}

/**
 * Which of the four glyphs a step is marked with.
 *
 * Keyed on the tool's own name out of the stage id, so the same tool cannot be
 * filed under two marks, and grouped the way the design groups them: searching
 * for something, looking up what a thing means, and querying governed data. A
 * tool nobody has mapped keeps the wrench, which is the fallback the map already
 * uses for one.
 *
 * `agent` was `robot` until the mark became the agent. The name is the KIND of
 * step rather than the figure drawn for it, which is what it should have been all
 * along: a glyph name that describes the artwork has to be renamed every time the
 * artwork changes, and one rename was enough to make the point.
 */
export type RailGlyph = 'agent' | 'search' | 'wrench' | 'database';

const RAIL_GLYPHS: Record<string, RailGlyph> = {
  search_semantics: 'search',
  search_tagged_assets: 'search',
  data_genie: 'database',
  run_sql: 'database',
  query_named_table: 'database',
  describe_table: 'wrench',
  list_data_assets: 'wrench',
  dictionary_genie: 'wrench',
};

export function railGlyph(stage: Pick<TraceStage, 'id' | 'kind'>): RailGlyph {
  if (stage.kind === 'agent') return 'agent';
  return RAIL_GLYPHS[toolNameFromId(stage.id)] ?? 'wrench';
}

/**
 * Which of the three connectors joins two consecutive cards.
 *
 * `out` is a decision reaching the tool it called, `back` is a tool call
 * returning to the next decision, and `down` is one card following another at
 * the same indent. That is the whole relation, and it is the reason the words
 * "calls" and "then" are gone from this pane: the shape carries what the words
 * used to say, and a word in a 16px gutter of a 264px column was the thing the
 * design removed.
 */
export type ConnectorShape = 'out' | 'down' | 'back';

export interface RailConnector {
  shape: ConnectorShape;
  /** Wide enough to hold both lanes and the arrowhead, and no wider. */
  width: number;
  /** The stroked run, in the connector row's own coordinates. */
  line: string;
  /**
   * The arrowhead, as a second open path rather than a filled triangle or a
   * marker: a marker inherits the stroke's own join rules and a filled triangle
   * at 1.5px reads as a blob at the zoom levels this pane is read at.
   */
  head: string;
}

export function railConnector(fromDepth: number, toDepth: number): RailConnector {
  const from = railLane(fromDepth);
  const to = railLane(toDepth);
  const width = Math.max(from, to) + 6;
  if (toDepth > fromDepth) {
    return { shape: 'out', width, line: `M${from} 1V8H${to}`, head: `M${to - 4} 4.5L${to} 8L${to - 4} 11.5` };
  }
  if (toDepth < fromDepth) {
    return {
      shape: 'back',
      width,
      line: `M${from} 1V8H${to}V15`,
      head: `M${to - 3.5} 11L${to} 15L${to + 3.5} 11`,
    };
  }
  return {
    shape: 'down',
    width,
    line: `M${from} 1V15`,
    head: `M${from - 3.5} 11L${from} 15L${from + 3.5} 11`,
  };
}

/** One run of characters in a stage name, and whether it is the tool's own id. */
export interface NamePart {
  text: string;
  /** Set in mono, and never broken across two lines. */
  mono: boolean;
}

/**
 * A stage name split around the tool's own identifier.
 *
 * `_TOOL_STAGE_NAMES` in agent.py gives a tool a reader's label ("Queried
 * governed data") and falls back to "Called {name}" for one it has no label for,
 * so a name can carry a raw identifier in the middle of ordinary words. That
 * identifier is a value rather than prose and takes the mono face every other
 * identifier in the app takes -- which is also what stops it breaking mid-word,
 * the defect reported against "Called search_semantics" when the shared
 * `overflow-wrap: anywhere` split it as "search_semantic" with a lone "s" on the
 * next line.
 *
 * The identifier comes from the stage id, which carries it verbatim, so this
 * cannot mark up a word that merely looks like a tool name.
 */
export function nameParts(name: string, id: string): NamePart[] {
  const tool = toolNameFromId(id);
  if (!tool) return [{ text: name, mono: false }];
  const at = name.indexOf(tool);
  if (at === -1) return [{ text: name, mono: false }];
  return [
    { text: name.slice(0, at), mono: false },
    { text: tool, mono: true },
    { text: name.slice(at + tool.length), mono: false },
  ].filter((part) => part.text.length > 0);
}

/** A row of a result that turned out to be a table. */
export interface ResultRow {
  cells: string[];
  /**
   * Carries a non-zero value in a column whose other rows are zero.
   *
   * The one thing a reader is scanning a null-rate or a count breakdown FOR, and
   * derived from the numbers in the table rather than from any knowledge of what
   * the table is: a table with nothing at zero has no findings to mark, because
   * then every row would be marked and the tint would say nothing.
   */
  finding: boolean;
}

/** The uniform tail of a table, folded into one line. */
export interface ResultTail {
  count: number;
  value: string;
}

export type ResultView =
  | { kind: 'table'; head: string[]; rows: ResultRow[]; tail: ResultTail | null }
  | { kind: 'text'; paragraphs: string[] };

/** A markdown table's rule row, which is layout rather than data. */
const SEPARATOR = /^:?-{2,}:?$/;

/**
 * Rows below this many are printed rather than folded.
 *
 * Folding two rows into "2 more rows, all 0.00%" saves nothing and costs the
 * reader the two values.
 */
const UNIFORM_TAIL = 3;

function splitCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

/**
 * A cell as a number, or null when it is not one.
 *
 * Percent signs and thousands separators are stripped first, because the agent's
 * results carry both and "0.00%" is a zero however it is written.
 */
export function numericCell(cell: string): number | null {
  const cleaned = cell.replace(/[,%\s]/g, '');
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * What a recorded result turns out to be, so the panel can render it as that.
 *
 * The agent's tools return pipe-delimited result sets, markdown tables and
 * prose, and the panel used to show all three as one preformatted block. A table
 * printed as text is a table the reader has to align by eye, which on a
 * twenty-column `describe_table` is most of the work they opened the step to do.
 *
 * Anything that is not a consistent grid stays text. That is deliberate: half a
 * table read as a table is worse than the raw text, because the rows that did
 * not parse are the ones silently missing from it. The Raw segment shows the
 * untouched text either way.
 */
export function describeResult(text: string): ResultView {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const grids = lines.every((line) => line.includes('|'))
    ? lines.map(splitCells).filter((cells) => !cells.every((cell) => SEPARATOR.test(cell)))
    : [];
  const width = grids[0]?.length ?? 0;
  if (width >= 2 && grids.length >= 2 && grids.every((cells) => cells.length === width)) {
    return asTable(grids, width);
  }
  return { kind: 'text', paragraphs: paragraphsOf(text) };
}

function asTable(grids: string[][], width: number): ResultView {
  const [head, ...body] = grids;
  const last = body.map((cells) => numericCell(cells[width - 1]));
  // Marked only when there is something to contrast against. Every row non-zero
  // means the reader is looking at a plain result set, not at a scan whose point
  // is the rows that are not clean.
  const contrasts = last.every((value) => value !== null) && last.some((value) => value === 0);
  const rows = body.map((cells, index) => ({ cells, finding: contrasts && last[index] !== 0 }));
  const tail = uniformTail(rows, width);
  return { kind: 'table', head, rows: tail ? rows.slice(0, rows.length - tail.count) : rows, tail };
}

/**
 * The run of identical values a long table ends on.
 *
 * A twenty-column null-rate scan is one interesting row and nineteen zeros, and
 * the nineteen are the reason the panel needed a scrollbar. Folded only from the
 * END, and never over the whole table: a table that is uniform throughout has no
 * tail, it has a single value, and collapsing it would leave the reader with a
 * count and no data.
 */
function uniformTail(rows: ResultRow[], width: number): ResultTail | null {
  if (rows.length === 0) return null;
  const value = rows[rows.length - 1].cells[width - 1];
  let start = rows.length;
  while (start > 0 && rows[start - 1].cells[width - 1] === value) start -= 1;
  const count = rows.length - start;
  return count >= UNIFORM_TAIL && start > 0 ? { count, value } : null;
}

/** Blank-line separated paragraphs, so prose renders as prose. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * The keywords the SQL block colours, longest first.
 *
 * Longest first is load-bearing rather than tidy: an alternation matches the
 * first branch that fits, so a bare `END` listed before `CASE WHEN` would leave
 * `WHEN` uncoloured in the middle of a coloured pair. The list is the design's
 * and is deliberately short -- a statement with every token coloured is a
 * statement with nothing emphasised.
 */
export const SQL_KEYWORDS = [
  'CASE WHEN',
  'IS NULL',
  'SELECT',
  'ROUND',
  'COUNT',
  'FROM',
  'THEN',
  'ELSE',
  'END',
  'SUM',
  'AS',
];

const SQL_PATTERN = new RegExp(`\\b(${SQL_KEYWORDS.map((word) => word.replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');

/** One run of characters in a SQL line, and whether it is a keyword. */
export interface SqlToken {
  text: string;
  keyword: boolean;
}

/**
 * A line of SQL split into keywords and everything else.
 *
 * Matched on word boundaries and case-insensitively, so a column named
 * `count_of_players` keeps its own name rather than having `count` picked out of
 * the middle of it.
 */
export function sqlTokens(line: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let at = 0;
  SQL_PATTERN.lastIndex = 0;
  for (let found = SQL_PATTERN.exec(line); found; found = SQL_PATTERN.exec(line)) {
    if (found.index > at) tokens.push({ text: line.slice(at, found.index), keyword: false });
    tokens.push({ text: found[0], keyword: true });
    at = found.index + found[0].length;
  }
  if (at < line.length) tokens.push({ text: line.slice(at), keyword: false });
  return tokens;
}

/** The statement's lines, with the leading blank the agent's `"\nSELECT"` opens on removed. */
export function sqlLines(sql: string): string[] {
  return sql.replace(/^\n+/, '').replace(/\s+$/, '').split('\n');
}

/**
 * The whole run's payloads as one JSON document, for the collapsed Raw I/O row.
 *
 * Every stage, in run order, so what the row promises -- the request and the
 * response of every stage -- is what opening it gives. It is built from the same
 * `input` and `output` the panel above renders, so this discloses nothing the
 * open step does not; it is the same record without the reading applied.
 */
export function rawIo(stages: TraceStage[]): { text: string; lines: number } {
  const text = JSON.stringify(
    stages.map((stage, index) => ({
      step: index + 1,
      name: stage.name,
      request: stage.input,
      response: stage.output,
    })),
    null,
    2
  );
  return { text, lines: text.split('\n').length };
}
