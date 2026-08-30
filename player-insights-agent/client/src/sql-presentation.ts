import { describePayload } from './trace-payload';

/** The live/stored stage-summary ceiling. Keep this level with `live-progress.ts`. */
export const SQL_SUMMARY_LIMIT = 180;

const SENSITIVE_ASSIGNMENT =
  /\b(password|passwd|token|secret|credential|authorization|api[_-]?key)\b(\s*(?:=|=>|:)\s*)('(?:''|[^'])*'|"(?:\\"|[^"])*")/gi;
const IDENTIFIED_BY = /\b(identified\s+by\s+)('(?:''|[^'])*'|"(?:\\"|[^"])*")/gi;

/**
 * SQL safe for reader-facing presentation.
 *
 * The trace boundary already allowlists the recorded stage fields. This is the
 * narrower display pass: comments are never promoted into a title/label, and a
 * credential-shaped literal is redacted if one survived the upstream contract.
 * Quoted `--` and `/*` text stays literal SQL rather than being mistaken for a
 * comment.
 */
export function sanitizeSqlForDisplay(sql: string): string {
  let safe = '';
  let quote: "'" | '"' | '`' | null = null;
  for (let at = 0; at < sql.length; at += 1) {
    const character = sql[at];
    const next = sql[at + 1];
    if (quote) {
      safe += character;
      if (character === '\\' && next !== undefined) {
        safe += next;
        at += 1;
      } else if (character === quote && next === quote) {
        safe += next;
        at += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      safe += character;
      continue;
    }
    if (character === '-' && next === '-') {
      while (at < sql.length && sql[at] !== '\n' && sql[at] !== '\r') at += 1;
      safe += ' ';
      continue;
    }
    if (character === '/' && next === '*') {
      at += 2;
      while (at < sql.length && !(sql[at] === '*' && sql[at + 1] === '/')) at += 1;
      if (at < sql.length) at += 1;
      safe += ' ';
      continue;
    }
    safe += character;
  }
  return safe
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}'[REDACTED]'`)
    .replace(IDENTIFIED_BY, (_match, lead: string) => `${lead}'[REDACTED]'`)
    .trim();
}

export function compactSql(sql: string): string {
  return sanitizeSqlForDisplay(sql).replace(/\s+/g, ' ').trim();
}

/** A statement opener, used only where a generic `query` field may also be prose. */
export function isSqlText(text: string): boolean {
  return /^\s*(?:\(\s*)*(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|CALL|EXPLAIN)\b/.test(
    sanitizeSqlForDisplay(text)
  );
}

/** Cut before a token (or at punctuation), never through one when a boundary exists. */
export function truncateSql(sql: string, limit = SQL_SUMMARY_LIMIT): { text: string; truncated: boolean } {
  const compact = compactSql(sql);
  if (compact.length <= limit) return { text: compact, truncated: false };
  const budget = Math.max(1, limit - 1);
  let boundary = -1;
  for (let at = 1; at <= budget; at += 1) {
    if (/[\s,;()]/.test(compact[at])) boundary = at;
  }
  const minimumUsefulBoundary = Math.floor(budget * 0.5);
  const cut = boundary >= minimumUsefulBoundary ? boundary : Array.from(compact).slice(0, budget).join('').length;
  return { text: `${compact.slice(0, cut).trimEnd()}…`, truncated: true };
}

/** A partially streamed JSON string, decoded only as far as it has safely arrived. */
function partialJsonString(value: string): string {
  let decoded = '';
  for (let at = 0; at < value.length; at += 1) {
    const character = value[at];
    if (character === '"') break;
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escape = value[++at];
    if (escape === undefined) break;
    const simple: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escape in simple) {
      decoded += simple[escape];
      continue;
    }
    if (escape === 'u') {
      const hex = value.slice(at + 1, at + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      at += 4;
    }
  }
  return decoded;
}

/**
 * The SQL argument only, including an incomplete stream envelope.
 *
 * Named fields are the detection boundary. Ordinary prose containing "select"
 * or "from" is never treated as SQL.
 */
export function sqlFromStageInput(input: string): string {
  const payload = describePayload(input);
  const field = payload.fields?.find((entry) => entry.key === 'sql' || entry.key === 'query');
  if (field?.value.trim()) return field.value;
  const partial = /"(?:sql|query)"\s*:\s*"/i.exec(input);
  if (!partial) return '';
  return partialJsonString(input.slice((partial.index ?? 0) + partial[0].length));
}
