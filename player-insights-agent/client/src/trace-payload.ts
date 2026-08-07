/**
 * Presenting a stage's recorded arguments and result.
 *
 * - Every tool's `input` is a JSON object, and the interesting one is a single
 *   key whose value is a query: `{"sql": "\nSELECT\n    label,\n..."}`. Pretty-
 *   printing that as JSON is not enough, because the newlines stay escaped and
 *   the query is still one unreadable line. Unwrapping the object into its keys
 *   and rendering each value on its own is what turns it back into SQL.
 * - Outputs are plain text: pipe-delimited result sets, markdown, or a column
 *   list from `describe_table`. 57 of the 196 fields contain newlines, so line
 *   breaks are load-bearing and the renderer preserves them.
 * - The largest field in the capture is 2,701 characters, but the agent's own
 *   ceiling is `MAX_STAGE_CHARS = 20_000`, so that is the size to survive.
 */

/** One key of a JSON payload, laid out on its own. */
export interface PayloadField {
  key: string;
  value: string;
  /** Rendered as a block rather than inline, because it has structure to keep. */
  block: boolean;
}

export interface Payload {
  /** Nothing was recorded for this field. */
  empty: boolean;
  /** Parsed as a JSON object and unwrapped into `fields`. */
  fields: PayloadField[] | null;
  /** The text to show when it is not an unwrapped object. */
  body: string;
  chars: number;
  lines: number;
  /**
   * The agent hit its own size ceiling and said so in the text.
   *
   * Surfaced as a flag so the panel can label it, because a cap the reader does
   * not notice is worse than no cap: they would believe they were looking at
   * the whole value.
   */
  truncated: boolean;
}

/**
 * The notice `agent.py` appends when it clips a field.
 *
 * Matched on the shape rather than the exact sentence (it writes two different
 * ones, for the per-stage and whole-trace ceilings), so a reworded message
 * still gets labelled instead of silently passing as untruncated.
 */
const TRUNCATION_NOTICE = /^…\s*truncated\b/m;

/**
 * Whether a value gets its own block rather than sitting beside its key.
 */
const INLINE_LIMIT = 100;

function isBlock(value: string): boolean {
  return value.includes('\n') || value.length > INLINE_LIMIT;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  // Objects and arrays nested inside a payload keep their JSON form; there is
  // no more faithful way to show them and no example of one in the capture.
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * Decide how to lay out one recorded field.
 *
 * Falls back to the raw string on anything unexpected. A payload that does not
 * parse is shown exactly as recorded rather than rejected: the reader opened
 * this row to see what the tool was actually handed.
 */
export function describePayload(text: string | null | undefined): Payload {
  const raw = typeof text === 'string' ? text : '';
  const base = {
    empty: raw.length === 0,
    body: raw,
    chars: raw.length,
    lines: raw.length === 0 ? 0 : raw.split('\n').length,
    truncated: TRUNCATION_NOTICE.test(raw),
  };
  if (base.empty) return { ...base, fields: null };

  const trimmed = raw.trim();
  // Only object-shaped payloads are unwrapped. An array or a bare scalar has no
  // keys to label, so it reads better pretty-printed whole.
  if (!trimmed.startsWith('{')) return { ...base, fields: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ...base, fields: null };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, fields: null };
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return { ...base, fields: null };

  return {
    ...base,
    fields: entries.map(([key, value]) => {
      const rendered = describeValue(value);
      return { key, value: rendered, block: isBlock(rendered) };
    }),
  };
}

/**
 * How much there is, for the label above a scrollable block.
 */
export function payloadSize(payload: Payload): string {
  if (payload.empty) return '';
  const chars = `${payload.chars.toLocaleString()} character${payload.chars === 1 ? '' : 's'}`;
  return payload.lines > 1 ? `${payload.lines.toLocaleString()} lines · ${chars}` : chars;
}
