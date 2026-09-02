/**
 * Reader-facing answer cleanup owned by the app.
 *
 * The served model may describe its own process in `caveats`, and older stored
 * answers contain several app-generated versions of the same thing. Those
 * sentences are not findings. New answers are normalized before persistence;
 * historical answers pass through the same policy only while being read.
 *
 * Matching is deliberately narrow. Caveats are a structured answer field, so
 * known generated patterns can be classified there. Narrative cleanup only
 * touches complete, unquoted Markdown lines and explicitly named process-only
 * sections; quoted user text and fenced code are left byte-for-byte intact.
 */

import { DSF_CLIP_NOTE } from './run-verdict';

export interface AnswerContentEvidence {
  sql?: string | null;
  sources?: readonly unknown[] | null;
}

export interface ReaderAnswerContent extends AnswerContentEvidence {
  takeaway?: string;
  narrative?: string;
  content?: string;
  caveats?: readonly string[];
}

const MATERIAL_WARNING =
  /\b(?:permission|privilege|denied|refused|unauthori[sz]ed|forbidden|error|fail(?:ed|ure)|not found|does not exist|rate limit|(?:query|sql|statement)(?: execution)? (?:failed|timed out)|(?:failed|timed out) (?:query|sql|statement)|timeout|stale|out[- ]of[- ]date|incomplete (?:source|data)|(?:source|citation) (?:is )?unavailable|conflicting evidence|conflict|uncertain|unsupported|safety|policy refusal|required (?:input|field)|missing required|data quality|invalid|duplicate|coverage gap|dataset (?:ends|ended)|only \d+ of)\b/i;

const NO_GOVERNED_READ =
  /^(?:no|none of the) governed tables?(?: (?:was|were|has been|have been))? (?:read|queried|accessed)(?: for (?:this|the) (?:answer|response|result))?(?:,? so (?:it|the (?:answer|response|result)) (?:is|was) not grounded in (?:queried|source) data)?[.!]?$/i;
const NOT_GROUNDED =
  /^(?:this|the) (?:answer|response|result) (?:is|was) not grounded in (?:queried|source) data[.!]?$/i;
const NO_SQL =
  /^no (?:sql|sql statement|query|statement)(?:s)? (?:was|were|has been|have been)? ?(?:generated(?: or executed)?|executed|run|produced)(?: for (?:this|the) (?:answer|response|result))?[.!]?$/i;
const NO_EVIDENCE_TOOL =
  /^no (?:source|sources|citation|citations|tool|tools|tool call|tool calls|source\/citation\/tool)(?: (?:was|were|has been|have been))? (?:used|called|cited|provided)(?: for (?:this|the) (?:answer|response|result))?[.!]?$/i;
const NO_MLFLOW_TRACE = /^no mlflow trace was recorded for this answer, so it cannot be opened in mlflow[.!]?$/i;
const INTERNAL_PROCESS_NEGATIVE =
  /^the agent (?:did not|could not|was unable to) (?:read|query|generate|execute|run|use|call|cite|retrieve|inspect|access)\b[^.!?]*[.!]?$/i;
const GOVERNED_READ_PARAPHRASE =
  /^(?:this|the) (?:answer|response|result) (?:did not|does not) (?:query|read|use) any governed tables?(?: and|,)? (?:so|therefore) (?:it )?(?:is|was) not grounded in (?:queried|source) data[.!]?$/i;
const PROCESS_SECTION_LINE =
  /^what (?:wasn['’]t|was not) (?:included|done)\s*:\s*(?:sql|sources?|citations?|tools?|queries?|governed tables?)(?:\s*(?:,|and|or)\s*(?:sql|sources?|citations?|tools?|queries?|governed tables?))*[.!]?$/i;
const PROCESS_ONLY_TAKEAWAY =
  /^(?:the agent did not return a structured result|no steps and no structured result were recorded|the run stopped without a structured result)[.!]?$/i;
const INCOMPLETE_FORMAT =
  /^(?:this answer is degraded:\s*)?(?:no structured result arrived and no tool steps were recorded|the run stopped after \d+ steps? without a structured result)[.!]?$/i;
const GENERIC_REVIEW =
  /^(?:validation:\s*)?(?:review|verify|check)(?: the)? (?:(?:generated )?sql(?: and (?:the )?(?:source details|sources))?|source details|sources)(?: before using (?:this|the) result)?[.!]?$/i;
const UNTAGGED_TABLE_SCOPE =
  /^(?:all|none of the) (\d+) tables? (?:are|is|have been) untagged(?: \(no franchise label\))?[;,] (?:this means )?franchise scope is unknown until (?:a|each|the) tables? (?:is|are) described or queried[.!]?$/i;
const UNTAGGED_CATALOG_NOTE =
  /^(?:all|none of the) \d+ tables? (?:are|is|have been) untagged(?: by franchise)? in the current catalog listing[;,—-]+ franchise-scoped filtering is not available from metadata alone[.!]?$/i;
const DECLARED_ACCESS_NOTES = [
  /^all \d+ tables? are declared but read access depends on the caller['’]s unity catalog grants\b.*\ba declared table is not a guarantee of row-level access[.!]?$/i,
  /^declaring a table does not guarantee read access[;,] unity catalog grants are evaluated per query and a refusal will be named explicitly if it occurs[.!]?$/i,
  /^these \d+ tables? are declared by the deployment[;,] unity catalog grant evaluation happens at query time, so the signed-in user may not have select access to all of them\.? any refused table will be named explicitly if a query against (?:it|them) fails[.!]?$/i,
] as const;
const FIGURE_LIMIT =
  /^(.+?) (?:are|is) (?:omitted from|not shown in) (?:the )?figures?(?: due to the (\d+)[- ]figure limit)?(?: but (?:are|is) included in the narrative)?[.!]?$/i;
const FIGURE_LIMIT_RANKED =
  /^.+? (?:are|is) .{1,80}\bbut (?:omitted from|not shown in) (?:the )?figures? due to the \d+[- ]figure limit[.!]?$/i;

const PROCESS_SECTION =
  /^(?:what (?:wasn['’]t|was not) (?:included|done)|work (?:not|wasn['’]t) (?:included|performed)|what the agent (?:didn['’]t|did not) do)$/i;

function generatedText(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .trim();
}

function isQuotedLine(line: string): boolean {
  return /^\s*(?:>|["'“‘])/.test(line);
}

/**
 * One generated caveat, converted to useful scope/validation language or
 * omitted. Material failures are returned unchanged.
 */
export function normalizeAnswerCaveat(caveat: string, _evidence: AnswerContentEvidence = {}): string | null {
  let text = caveat.trim();
  if (!text) return null;

  // These are complete generated templates. Check them before the broader
  // warning vocabulary: their hypothetical "access" and "may be incomplete"
  // wording is not evidence that this answer actually failed.
  if (
    DSF_CLIP_NOTE.test(text) ||
    GENERIC_REVIEW.test(text) ||
    UNTAGGED_TABLE_SCOPE.test(text) ||
    UNTAGGED_CATALOG_NOTE.test(text) ||
    DECLARED_ACCESS_NOTES.some((pattern) => pattern.test(text))
  ) {
    return null;
  }

  if (
    NO_GOVERNED_READ.test(text) ||
    GOVERNED_READ_PARAPHRASE.test(text) ||
    NOT_GROUNDED.test(text) ||
    NO_SQL.test(text) ||
    NO_EVIDENCE_TOOL.test(text) ||
    NO_MLFLOW_TRACE.test(text) ||
    PROCESS_SECTION_LINE.test(text)
  ) {
    return null;
  }

  if (INCOMPLETE_FORMAT.test(text)) {
    return 'This answer is degraded: the response format was incomplete. Retry the question before using this result.';
  }

  // Keep concrete validation findings, but not the generated label in front of
  // them. The issue/action is the useful part of the caveat.
  text = text.replace(/^validation:\s*/i, '').trim();
  if (!text) return null;

  // A failure or correctness warning wins over the generic "the agent could
  // not..." pattern. This preserves actual permission, query, freshness,
  // conflict, support, safety, and required-input failures.
  if (MATERIAL_WARNING.test(text)) return text;

  if (INTERNAL_PROCESS_NEGATIVE.test(text)) return null;

  if (FIGURE_LIMIT.test(text) || FIGURE_LIMIT_RANKED.test(text)) return null;

  return text;
}

/**
 * Markdown/plain text cleanup for takeaway, narrative, raw stored fallback,
 * copy, export, and print surfaces.
 */
export function normalizeReaderText(
  value: string,
  evidence: AnswerContentEvidence = {},
  field: 'takeaway' | 'narrative' | 'content' | 'raw' = 'narrative'
): string {
  const text = value.trim();
  if (!text) return '';
  if (field === 'takeaway' && PROCESS_ONLY_TAKEAWAY.test(text)) {
    return 'Answer format incomplete. Retry the question.';
  }

  const output: string[] = [];
  let changed = false;
  let fenced = false;
  let droppedHeadingLevel = 0;

  for (const line of value.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (!droppedHeadingLevel) output.push(line);
      continue;
    }
    if (fenced) {
      if (!droppedHeadingLevel) output.push(line);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (droppedHeadingLevel) {
        if (level > droppedHeadingLevel) continue;
        droppedHeadingLevel = 0;
      }
      if (PROCESS_SECTION.test(heading[2].replace(/\s+#+\s*$/, '').trim())) {
        droppedHeadingLevel = level;
        changed = true;
        continue;
      }
      output.push(line);
      continue;
    }
    if (droppedHeadingLevel) continue;
    if (isQuotedLine(line)) {
      output.push(line);
      continue;
    }

    const generated = generatedText(line);
    if (!generated) {
      output.push(line);
      continue;
    }
    const normalized = normalizeAnswerCaveat(generated, evidence);
    if (normalized === generated) {
      output.push(line);
      continue;
    }
    changed = true;
    if (!normalized) continue;
    const prefix = line.slice(0, line.indexOf(generated));
    output.push(`${prefix}${normalized}`);
  }

  if (!changed) return value;
  return output
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One idempotent policy for live, stored, rendered, copied, and exported answers. */
export function normalizeReaderAnswer<T extends ReaderAnswerContent>(answer: T): T {
  const evidence: AnswerContentEvidence = { sql: answer.sql, sources: answer.sources };
  const normalizedCaveats = answer.caveats
    ?.map((caveat) => normalizeAnswerCaveat(caveat, evidence))
    .filter((caveat): caveat is string => Boolean(caveat));
  const seen = new Set<string>();
  const uniqueCaveats = normalizedCaveats?.filter((caveat) => {
    const key = caveat
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...answer,
    ...(typeof answer.takeaway === 'string'
      ? { takeaway: normalizeReaderText(answer.takeaway, evidence, 'takeaway') }
      : {}),
    ...(typeof answer.narrative === 'string'
      ? { narrative: normalizeReaderText(answer.narrative, evidence, 'narrative') }
      : {}),
    ...(typeof answer.content === 'string'
      ? { content: normalizeReaderText(answer.content, evidence, 'content') }
      : {}),
    ...(answer.caveats ? { caveats: uniqueCaveats } : {}),
  } as T;
}

/** Plain-text export uses the same normalized fields as the visual answer. */
export function readerAnswerPlainText(answer: ReaderAnswerContent): string {
  const normalized = normalizeReaderAnswer(answer);
  const sections = [normalized.takeaway, normalized.narrative, normalized.content].filter(
    (section): section is string => Boolean(section?.trim())
  );
  const caveats = normalized.caveats?.filter((caveat) => caveat.trim()) ?? [];
  if (caveats.length > 0) sections.push(`Keep in mind\n${caveats.map((caveat) => `- ${caveat}`).join('\n')}`);
  return sections.join('\n\n').trim();
}
