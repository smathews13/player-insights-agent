/**
 * Apparatus the stored answer still carries, and must not be shown as the story.
 *
 * A truncated or deadline-stopped run often stores the last tool call as the
 * narrative -- `data_genie({"question": "..."})` then an ASCII grid -- under a
 * canned takeaway. The Run Explorer's Final Answer module, and the shared prose
 * renderer Ask PIA uses, both have to refuse that dump rather than print it.
 *
 * Nothing here rewrites a finding. Tool-call JSON is dropped, a canned headline
 * is replaced only when a real sentence survives, and the status label is read
 * off the caveats the agent already wrote.
 */
import { CAVEAT_RISK, caveatRisk } from './caveat-priority';

/** Governed tools whose call-site JSON has been seen dumped into a stored narrative. */
const TOOL_CALL = /\b(data_genie|dictionary_genie|query_named_table|run_sql|search_sources)\s*\(/;

/**
 * Headlines that describe the shape of the reply, not a finding.
 *
 * "The analysis completed from assessed sources." is the one on the reported
 * run: it sits over a tool dump and a deadline caveat, and reads as a success
 * the rest of the card then contradicts.
 */
const CANNED_TAKEAWAY = [
  /^the analysis completed\b/i,
  /\bfrom assessed sources\b/i,
  /^the agent returned an answer\b/i,
  /^the agent answered in prose\b/i,
];

/** How much of a surviving sentence is used when the stored takeaway was canned. */
const TAKEAWAY_LIMIT = 220;

function matchingParen(source: string, openAt: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openAt; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The narrative with tool-call JSON removed.
 *
 * Unclosed calls -- a deadline often cuts the dump mid-argument -- drop through
 * the end of their line rather than leaving a `data_genie({` stub in the prose.
 * Surrounding findings are kept, including a pipe table that followed the call.
 */
export function stripToolCallDumps(source: string): string {
  if (!source) return '';
  let index = 0;
  let out = '';
  while (index < source.length) {
    const rest = source.slice(index);
    const match = TOOL_CALL.exec(rest);
    if (!match || match.index === undefined) {
      out += rest;
      break;
    }
    out += rest.slice(0, match.index);
    const openAt = index + match.index + match[0].length - 1;
    const closeAt = matchingParen(source, openAt);
    if (closeAt < 0) {
      const newline = source.indexOf('\n', openAt);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    index = closeAt + 1;
    if (source[index] === ';') index += 1;
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isCannedTakeaway(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  return CANNED_TAKEAWAY.some((pattern) => pattern.test(value));
}

/**
 * The headline a reader should see.
 *
 * A canned completion line is not a finding. When the stored takeaway is one,
 * the first surviving sentence of the cleaned narrative stands in; when nothing
 * usable survives, the headline is empty and the module's status label carries
 * the honesty instead of inventing a result.
 */
export function readerFacingTakeaway(takeaway: string, narrative: string): string {
  if (!isCannedTakeaway(takeaway)) return takeaway.trim();
  const first = stripToolCallDumps(narrative)
    .split('\n')
    .map((line) => line.trim().replace(/^#+\s*/, ''))
    .find((line) => line && !line.includes('|') && !isCannedTakeaway(line) && !TOOL_CALL.test(line));
  if (!first) return '';
  return first.length > TAKEAWAY_LIMIT ? `${first.slice(0, TAKEAWAY_LIMIT - 1)}…` : first;
}

/**
 * The narrative with the headline removed when it is the same sentence twice.
 *
 * The deadline path used to put the canned takeaway in both slots. The card
 * then printed it as the title and again as the first line of the body.
 */
export function readerFacingNarrative(takeaway: string, narrative: string): string {
  const cleaned = stripToolCallDumps(narrative);
  const headline = readerFacingTakeaway(takeaway, narrative);
  const lines = cleaned.split('\n');
  const firstAt = lines.findIndex((line) => line.trim());
  if (firstAt < 0) return cleaned;
  const first = lines[firstAt].trim();
  // Drop a leading line that restates the title: the stored takeaway, the
  // headline we just chose, or the canned completion the deadline path wrote.
  if (first === headline || first === takeaway.trim() || isCannedTakeaway(first)) {
    lines.splice(firstAt, 1);
    return lines.join('\n').replace(/^\n+/, '').trim();
  }
  return cleaned;
}

export interface AnswerWarning {
  /** Short chip label, in the words the header uses. */
  label: string;
  /** The agent's caveat, shown in full under the label. */
  text: string;
}

export interface AnswerHonesty {
  /** Section title. Partial when the run did not finish cleanly. */
  eyebrow: string;
  tone: 'complete' | 'partial';
  /** Evidence and refusal caveats, lifted out of the quiet list. */
  warnings: AnswerWarning[];
}

function warningLabel(text: string): string {
  if (/turn deadline|budget for this turn was spent|stopped early/i.test(text)) return 'Turn deadline reached';
  if (/sources for this answer are incomplete/i.test(text)) return 'Incomplete sources';
  if (/could not be determined/i.test(text)) return 'Tables unresolved';
  if (caveatRisk(text) === CAVEAT_RISK.refused) return 'Request refused';
  return 'Partial evidence';
}

/**
 * Whether this section may be labelled "Final answer", and which warnings must
 * lead if it may not.
 *
 * `truncated` is the run row's own flag. The caveats are a second, independent
 * signal: a stored row from before that column existed can still say the turn
 * deadline was reached, and that sentence has to change the header even when
 * the flag is absent.
 */
export function answerHonesty(input: {
  truncated?: boolean | null;
  caveats: readonly string[];
}): AnswerHonesty {
  const caveats = input.caveats.map((caveat) => caveat.trim()).filter(Boolean);
  const warnings = caveats
    .filter((text) => {
      const risk = caveatRisk(text);
      return risk === CAVEAT_RISK.refused || risk === CAVEAT_RISK.evidence;
    })
    .map((text) => ({ label: warningLabel(text), text }));
  const truncated =
    input.truncated === true ||
    caveats.some((text) => /turn deadline|budget for this turn was spent|stopped early/i.test(text));
  const incomplete = caveats.some((text) => /sources for this answer are incomplete/i.test(text));
  if (!truncated && !incomplete && warnings.length === 0) {
    return { eyebrow: 'Final answer', tone: 'complete', warnings: [] };
  }
  return {
    eyebrow: truncated ? 'Partial answer' : incomplete ? 'Incomplete answer' : 'Qualified answer',
    tone: 'partial',
    warnings,
  };
}
