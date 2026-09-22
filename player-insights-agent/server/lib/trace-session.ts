import { createHash } from 'node:crypto';

/**
 * The TypeScript twin of agent.py's `_plan_id`.
 *
 * MLflow uses this value as `mlflow.trace.session`, so the app must stamp the
 * exact same identifier onto the stored answer if Monitoring is to open the
 * same group. Python's default `json.dumps(..., sort_keys=True,
 * ensure_ascii=False)` includes a space after each colon and comma; assembling
 * the three sorted keys explicitly preserves those bytes instead of relying on
 * JavaScript's more compact JSON.stringify object formatting.
 */
export function questionTraceSessionId(question: string, attachmentContext: string): string {
  const fingerprint =
    `{"attachment": ${JSON.stringify(attachmentContext)}, ` +
    `"question": ${JSON.stringify(question)}, "revision": ""}`;
  return `plan-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}
