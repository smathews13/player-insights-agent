import {
  judgeProvenance,
  MLFLOW_JUDGE_PROMPT_VERSION,
  type BenchmarkJudgement,
} from '../../shared/benchmark-contract';
import { withDeadline } from './deadline';

/**
 * MLflow's built-in LLM judges, run from Node.
 */

/** Assessment names are MLflow's own, so a score can be matched to its rubric. */
export const GROUNDEDNESS_FEEDBACK_NAME = 'groundedness';
export const RELEVANCE_TO_QUERY_ASSESSMENT_NAME = 'relevance_to_context';
export const GUIDELINES_FEEDBACK_NAME = 'guidelines';

export type BuiltinJudgeName =
  | typeof GROUNDEDNESS_FEEDBACK_NAME
  | typeof RELEVANCE_TO_QUERY_ASSESSMENT_NAME
  | typeof GUIDELINES_FEEDBACK_NAME;

/** Built-in names, plus custom / multi-turn `Guidelines(name=…)` assessments. */
export type JudgeName = BuiltinJudgeName | string;

export function conversationTranscript(question: string, response: string): string {
  return `User: ${question}\nAssistant: ${response}`;
}

// ---------------------------------------------------------------------------
// The prompts, verbatim from mlflow 3.14.0
//
// Left as single template literals with MLflow's own `{{placeholder}}` markers
// and its exact line breaks, so a future upgrade can be diffed against the
// Python source rather than re-derived from prose.
// ---------------------------------------------------------------------------

/** `mlflow/genai/judges/prompts/groundedness.py` */
export const GROUNDEDNESS_PROMPT = `Consider the following claim and document. You must determine whether claim is supported by the document. Do not focus on the correctness or completeness of the claim. Do not make assumptions, approximations, or bring in external knowledge.

<claim>
  <question>{{input}}</question>
  <answer>{{output}}</answer>
</claim>
<document>{{retrieval_context}}</document>

Please indicate whether each statement in the claim is supported by the document using only the following json format. Do not use any markdown formatting or output additional lines.
{
  "rationale": "Reason for the assessment. If the claim is not fully supported by the document, state which parts are not supported. Start each rationale with \`Let's think step by step\`",
  "result": "yes|no"
}`;

/** `mlflow/genai/judges/prompts/relevance_to_query.py` */
export const RELEVANCE_TO_QUERY_PROMPT = `Consider the following question and answer. You must determine whether the answer provides information that is (fully or partially) relevant to the question. Do not focus on the correctness or completeness of the answer. Do not make assumptions, approximations, or bring in external knowledge.

<question>{{input}}</question>
<answer>{{output}}</answer>

Please indicate whether the answer contains information that is relevant to the question using only the following json format. Do not use any markdown formatting or output additional lines.
{
  "rationale": "Reason for the assessment. If the answer does not provide any information that is relevant to the question then state which parts are not relevant. Start each rationale with \`Let's think step by step\`",
  "result": "yes|no"
}
\`result\` must only be \`yes\` or \`no\`.`;

/** `mlflow/genai/judges/prompts/guidelines.py` */
export const GUIDELINES_PROMPT = `Given the following set of guidelines and some inputs, please assess whether the inputs fully comply with all the provided guidelines. Only focus on the provided guidelines and not the correctness, relevance, or effectiveness of the inputs.

<guidelines>
{{guidelines}}
</guidelines>
{{guidelines_context}}

Please provide your assessment using only the following json format. Do not use any markdown formatting or output additional lines. If any of the guidelines are not satisfied, the result must be "no". If none of the guidelines apply to the given inputs, the result must be "yes".
{
  "rationale": "Detailed reasoning for your assessment. If the assessment does not satisfy the guideline, state which parts of the guideline are not satisfied. Start each rationale with \`Let's think step by step. \`",
  "result": "yes|no"
}`;

/**
 * MLflow's `format_prompt`: a literal `{{name}}` substitution.
 */
export function formatPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

/** `_render_guidelines` / `_render_guidelines_context` from the Python source. */
function renderGuidelines(guidelines: string[]): string {
  return guidelines.map((guideline) => `<guideline>${guideline}</guideline>`).join('\n');
}

function renderGuidelinesContext(context: Record<string, string>): string {
  return Object.entries(context)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('\n');
}

export function groundednessPrompt(request: string, response: string, context: string): string {
  return formatPrompt(GROUNDEDNESS_PROMPT, {
    input: request,
    output: response,
    retrieval_context: context,
  });
}

export function relevanceToQueryPrompt(request: string, response: string): string {
  return formatPrompt(RELEVANCE_TO_QUERY_PROMPT, { input: request, output: response });
}

export function guidelinesPrompt(guidelines: string[],
  context: Record<string, string>
): string {
  return formatPrompt(GUIDELINES_PROMPT, {
    guidelines: renderGuidelines(guidelines),
    guidelines_context: renderGuidelinesContext(context),
  });
}

// ---------------------------------------------------------------------------
// Response handling, ported from MLflow
// ---------------------------------------------------------------------------

/**
 * `_strip_markdown_code_blocks`. Some models fence their JSON even when told
 * not to, and MLflow unwraps both a whole-response fence and a ```json block
 * embedded after a preamble.
 */
export function stripMarkdownCodeBlocks(response: string): string {
  const cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    let endIndex = lines.length;
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '```') {
        endIndex = index;
        break;
      }
    }
    return lines.slice(1, endIndex).join('\n');
  }
  const embedded = /```json\s*\n([\s\S]*?)\n```/i.exec(cleaned);
  return embedded ? embedded[1].trim() : cleaned;
}

/** `_sanitize_justification`. MLflow removes the preamble it asked for. */
export function sanitizeRationale(rationale: string): string {
  return rationale.replace("Let's think step by step. ", '');
}

/**
 * Pull the assistant text out of a chat completion.
 *
 * Mirrors `_create_message_from_databricks_response`, including the list-of-
 * blocks form a reasoning model returns, where the verdict is in a `text`
 * block behind a `reasoning` one.
 */
export function extractJudgeContent(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const choices = (result as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((block): block is { text: string } => Boolean(block) && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string')
      .map((block) => block.text);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

export type ParsedJudgeResponse =
  | { ok: true; value: 'yes' | 'no'; rationale: string }
  | { ok: false; error: string };

/**
 * `_parse_databricks_judge_response`, with one addition: MLflow accepts
 * whatever string sits in `result`, and this refuses anything that is not yes
 * or no.
 *
 * The addition matters here. MLflow hands a stray value on to a `Feedback`
 * object a human reads; this feeds a denominator. A `result` of "partially"
 * counted as anything other than unscored would put a number nobody measured
 * into a rate a stakeholder reads as a percentage.
 */
export function parseJudgeResponse(content: string | null): ParsedJudgeResponse {
  if (!content || !content.trim()) return { ok: false, error: 'Empty response from the judge model.' };
  const stripped = stripMarkdownCodeBlocks(content);
  let payload: unknown;
  try {
    payload = JSON.parse(stripped);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON response from the judge model: ${(error as Error).message}. Output: ${stripped.slice(0, 400)}`,
    };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: `Judge response was not an object: ${stripped.slice(0, 400)}` };
  }
  const record = payload as Record<string, unknown>;
  if (!('result' in record)) {
    return { ok: false, error: `Judge response missing 'result' field: ${stripped.slice(0, 400)}` };
  }
  const verdict = typeof record.result === 'string' ? record.result.trim().toLowerCase() : '';
  if (verdict !== 'yes' && verdict !== 'no') {
    return {
      ok: false,
      error: `Judge returned a verdict that is neither yes nor no (${JSON.stringify(record.result)}), so this case is unscored rather than scored at a guess.`,
    };
  }
  const rationale = typeof record.rationale === 'string' ? sanitizeRationale(record.rationale) : '';
  return { ok: true, value: verdict, rationale };
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

/**
 * How a judge prompt reaches a model.
 *
 * A closure rather than a client, so this module owns the judge protocol (the
 * prompt, the payload, the parsing), and owns no transport at all. The caller
 * binds it to the same `apiClient.request()` transport the ask route uses, one
 * endpoint path along. That is what keeps a second HTTP path from growing here,
 * which is the defect the serving-transport guards exist to prevent.
 */
export type JudgeInvoker = (payload: Record<string, unknown>) => Promise<unknown>;

export interface JudgeConfig {
  invoke: JudgeInvoker;
  judgeEndpoint: string;
  /** Upper bound on one judge call, so a hung judge cannot stall a suite. */
  timeoutMs?: number;
}

export const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/**
 * The chat body. `temperature: 0` is the documented deviation above; the
 * token ceiling is generous because a groundedness rationale quotes the
 * document back and a truncated rationale would parse as invalid JSON.
 */
export function judgeRequestPayload(prompt: string): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 2048,
  };
}

/**
 * Bounds a promise without cancelling it.
 *
 * The underlying request is not aborted (the injected transport exposes no
 * signal), so a timed-out judge call may still complete in the background and
 * its result is discarded. Stated because "timeout" here means "we stopped
 * waiting", not "the call was stopped".
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return withDeadline(work,
    ms,
    `${label} did not answer within ${ms} ms; the call was abandoned, not cancelled.`
  );
}

/** A judgement that never ran, with the reason it did not. */
export function notApplicable(name: JudgeName,
  judgeEndpoint: string,
  reason: string
): BenchmarkJudgement {
  return {
    name,
    state: 'not-applicable',
    value: null,
    rationale: '',
    reason,
    provenance: judgeProvenance(name, judgeEndpoint),
    promptVersion: MLFLOW_JUDGE_PROMPT_VERSION,
    judgeEndpoint,
    durationMs: null,
  };
}

/**
 * Run one judge prompt and return its judgement.
 *
 * Never throws and never invents a verdict: a transport failure, a timeout, a
 * malformed body and an out-of-vocabulary verdict all land as
 * `state: 'errored'` with the reason attached, which the aggregate counts as
 * unscored rather than as a no.
 */
export async function runJudge(config: JudgeConfig,
  name: JudgeName,
  prompt: string
): Promise<BenchmarkJudgement> {
  const judgeEndpoint = config.judgeEndpoint;
  const base = {
    name,
    provenance: judgeProvenance(name, judgeEndpoint),
    promptVersion: MLFLOW_JUDGE_PROMPT_VERSION,
    judgeEndpoint,
  };
  const started = Date.now();
  let raw: unknown;
  try {
    raw = await withTimeout(config.invoke(judgeRequestPayload(prompt)),
      config.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
      `The ${name} judge (${judgeEndpoint})`
    );
  } catch (error) {
    return {
      ...base,
      state: 'errored',
      value: null,
      rationale: '',
      reason: `The judge model could not be reached: ${(error as Error).message}`,
      durationMs: Date.now() - started,
    };
  }
  const durationMs = Date.now() - started;
  const parsed = parseJudgeResponse(extractJudgeContent(raw));
  if (!parsed.ok) {
    return { ...base, state: 'errored', value: null, rationale: '', reason: parsed.error, durationMs };
  }
  return {
    ...base,
    state: 'scored',
    value: parsed.value,
    rationale: parsed.rationale,
    reason: '',
    durationMs,
  };
}
