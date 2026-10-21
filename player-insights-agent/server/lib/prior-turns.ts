/**
 * The whole conversation, as the structured list the agent reads in place of the
 * last twelve flattened messages (`custom_inputs.prior_turns`).
 *
 * The agent remembers nothing between questions; the app is its only memory. What
 * used to travel was twelve messages, each earlier answer cut to a headline and
 * two sentences, with the rows it was built from dropped. So a long chat forgot its
 * start, and "now split that by region" had to run the whole query again.
 *
 * This file does two separate jobs and keeps them apart:
 *   - `buildPriorTurns` turns stored rows into entries. No size decisions.
 *   - `fitPriorTurns` fits them under the byte caps and says which turns lost their
 *     rows, with `evidence_withheld`. The backend budgets tokens itself; these caps
 *     are about the request, not the prompt.
 *
 * Never sent: the run `trace` and a dashboard's HTML. Both are large and neither is
 * conversation.
 */

/** Total `evidence_blocks` bytes, newest turns first. */
export const PRIOR_TURNS_BLOCK_BUDGET_BYTES = 600_000;
/**
 * The whole request body. Databricks refuses an agent request over 4 MB and does not
 * log one over 1 MB, and an unlogged request is a turn nobody can debug.
 */
export const REQUEST_BODY_BUDGET_BYTES = 900_000;

export interface PriorTurn {
  turn_id?: string;
  question?: string;
  type?: string;
  takeaway?: string;
  narrative?: string;
  content?: string;
  caveats?: string[];
  sources?: unknown[];
  evidence_blocks?: unknown[];
  evidence_withheld?: true;
}

interface StoredRow {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  response_json?: unknown;
}

const TYPES = new Set(['answer', 'clarification', 'plan', 'report', 'dashboard', 'unavailable']);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function parsed(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return record(value);
}

function sourcesOf(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' || record(item)) : undefined;
}

/** One assistant row, and the user message that produced it, as a prior turn. */
function turnFrom(row: StoredRow, question: string | undefined): PriorTurn | null {
  const response = parsed(row.response_json);
  const stored = text(row.content);
  const declared = text(response?.type);
  const type = declared && TYPES.has(declared) ? declared : 'answer';
  const turn: PriorTurn = { type };
  if (question) turn.question = question;

  if (!response) {
    // A row with no structure is still a turn the reader saw.
    if (!stored) return null;
    turn.turn_id = text(row.id);
    turn.narrative = stored;
    return turn;
  }

  if (type === 'clarification') {
    const clarification = record(response.clarification);
    turn.turn_id = text(clarification?.id) ?? text(row.id);
    turn.takeaway = text(clarification?.question) ?? stored;
    const reason = text(clarification?.reason);
    if (reason) turn.narrative = reason;
  } else if (type === 'plan') {
    const plan = record(response.plan);
    turn.turn_id = text(plan?.id) ?? text(row.id);
    turn.takeaway = text(plan?.summary) ?? stored;
  } else if (type === 'report' || type === 'dashboard') {
    const document = record(response[type]);
    turn.turn_id = text(response.id) ?? text(row.id);
    turn.takeaway = text(document?.title) ?? stored;
    // The report's summary; a dashboard has none.
    const summary = text(document?.summary);
    if (summary) turn.narrative = summary;
    const caveats = strings(document?.caveats);
    if (caveats) turn.caveats = caveats;
    const sources = sourcesOf(document?.sources);
    if (sources) turn.sources = sources;
    // Top level, beside the document: blocks never live inside what is exported.
    if (Array.isArray(response.evidence_blocks)) turn.evidence_blocks = response.evidence_blocks;
    return turn;
  } else if (type === 'unavailable') {
    turn.turn_id = text(response.id) ?? text(row.id);
    turn.takeaway = text(response.message) ?? stored;
    return turn;
  } else {
    turn.turn_id = text(response.id) ?? text(row.id);
    turn.takeaway = text(response.takeaway) ?? stored;
    const narrative = text(response.narrative);
    if (narrative) turn.narrative = narrative;
    const content = text(response.content);
    if (content) turn.content = content;
  }

  const caveats = strings(response.caveats);
  if (caveats) turn.caveats = caveats;
  const sources = sourcesOf(response.sources);
  if (sources) turn.sources = sources;
  if (Array.isArray(response.evidence_blocks)) turn.evidence_blocks = response.evidence_blocks;
  return turn;
}

/**
 * One entry per earlier assistant turn, oldest first, from rows in time order.
 *
 * The question is the user message just before the turn. A user message with no
 * answer yet (the one being asked now) produces nothing.
 */
export function buildPriorTurns(rows: readonly StoredRow[]): PriorTurn[] {
  const turns: PriorTurn[] = [];
  let question: string | undefined;
  for (const row of rows) {
    if (row.role === 'user') {
      question = text(row.content);
    } else if (row.role === 'assistant') {
      const turn = turnFrom(row, question);
      if (turn) turns.push(turn);
    }
  }
  return turns;
}

/**
 * Fits the turns under the byte caps.
 *
 * 1. Every turn keeps its text keys.
 * 2. `evidence_blocks` are added newest turn first while they fit both the block
 *    budget and what is left of the body budget.
 * 3. The first turn whose blocks do not fit, and every older turn with blocks, keeps
 *    its text and gets `evidence_withheld: true`. Only a turn that HAD blocks gets it:
 *    the flag is how the backend tells "rows existed and were not carried" from "this
 *    turn read no data".
 * 4. If the text alone is over what is left, the oldest turns are dropped.
 *
 * `baseBytes` is the request body without `prior_turns`.
 */
export function fitPriorTurns(
  turns: readonly PriorTurn[],
  baseBytes: number,
  {
    blockBudget = PRIOR_TURNS_BLOCK_BUDGET_BYTES,
    bodyBudget = REQUEST_BODY_BUDGET_BYTES,
  }: { blockBudget?: number; bodyBudget?: number } = {}
): PriorTurn[] {
  const hadBlocks = turns.map((turn) => Array.isArray(turn.evidence_blocks) && turn.evidence_blocks.length > 0);
  const slim = turns.map(({ evidence_blocks: _blocks, ...rest }) => rest as PriorTurn);

  // Text first. Drop the oldest until it fits; `[]` is a real answer ("no earlier turns").
  let first = 0;
  const room = bodyBudget - baseBytes - bytes({ prior_turns: [] });
  let textBytes = slim.reduce((sum, turn) => sum + bytes(turn) + 1, 0);
  while (first < slim.length && textBytes > room) {
    textBytes -= bytes(slim[first]) + 1;
    first += 1;
  }

  let remaining = Math.min(blockBudget, room - textBytes);
  let withholdingFromHere = false;
  const out: PriorTurn[] = slim.slice(first);
  for (let index = slim.length - 1; index >= first; index -= 1) {
    if (!hadBlocks[index]) continue;
    const blocks = turns[index].evidence_blocks!;
    // "evidence_blocks":[...] adds its key and the brackets on top of the blocks.
    const cost = bytes(blocks) + bytes('evidence_blocks') + 2;
    if (!withholdingFromHere && cost <= remaining) {
      out[index - first] = { ...slim[index], evidence_blocks: blocks };
      remaining -= cost;
    } else {
      withholdingFromHere = true;
      out[index - first] = { ...slim[index], evidence_withheld: true };
    }
  }
  return out;
}

/**
 * The `evidence_blocks` the backend sent beside a report or dashboard, at the top
 * level of `custom_outputs`. `[]` when it sent none (an older backend sends no key).
 * Searched through the same wrappers the document extractors look through.
 */
export function extractEvidenceBlocks(value: unknown, depth = 0): unknown[] {
  const top = record(value);
  if (!top || depth > 3) return [];
  const custom = record(top.custom_outputs);
  if (custom && Array.isArray(custom.evidence_blocks)) return custom.evidence_blocks;
  for (const key of ['data', 'response', 'result', 'body']) {
    if (top[key]) {
      const nested = extractEvidenceBlocks(top[key], depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}
