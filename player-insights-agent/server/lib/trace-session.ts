import { createHash } from 'node:crypto';

/** Must remain byte-for-byte aligned with agent.py's MAX_ATTACHMENT_CHARS. */
export const TRACE_SESSION_ATTACHMENT_CHARS = 8_000;
/** Marks sessions produced after the app mirrored all agent normalization. */
export const TRACE_SESSION_BASIS = 'agent-question-v1';

const REVISION_REQUEST =
  /^\s*Revise the proposed analysis plan for this question:\s*([\s\S]+?)(?:\n\nWhat to change:\s*([\s\S]+?))?\n\nPropose an updated plan for approval\. Do not run the analysis yet\.\s*$/;

function traceSessionQuestion(question: string): string {
  const revision = REVISION_REQUEST.exec(question);
  return revision ? (revision[1] ?? '').trim() : question;
}

function traceSessionAttachment(attachmentContext: string): string {
  // Python slices `str` by Unicode code point; JavaScript's String.slice uses
  // UTF-16 code units and would cut supplementary-plane characters in half.
  // Iterating the string preserves the agent's exact 8,000-code-point boundary.
  return Array.from(attachmentContext.trim()).slice(0, TRACE_SESSION_ATTACHMENT_CHARS).join('');
}

/**
 * The TypeScript twin of agent.py's `_revision_request`,
 * `_attachment_context`, and `_plan_id` sequence.
 *
 * MLflow uses this value as `mlflow.trace.session`, so the app must stamp the
 * exact same identifier onto the stored answer if Monitoring is to open the
 * same group. Python's default `json.dumps(..., sort_keys=True,
 * ensure_ascii=False)` includes a space after each colon and comma; assembling
 * the three sorted keys explicitly preserves those bytes instead of relying on
 * JavaScript's more compact JSON.stringify object formatting.
 */
export function questionTraceSessionId(question: string, attachmentContext: string): string {
  const cleanQuestion = traceSessionQuestion(question);
  const boundedAttachment = traceSessionAttachment(attachmentContext);
  const fingerprint =
    `{"attachment": ${JSON.stringify(boundedAttachment)}, ` +
    `"question": ${JSON.stringify(cleanQuestion)}, "revision": ""}`;
  return `plan-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}
