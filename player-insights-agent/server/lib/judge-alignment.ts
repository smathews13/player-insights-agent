import { appTable } from '../../shared/app-schema';
import type { AlignableRow } from '../../shared/eval-judge-alignment';
import {
  agreementFromPairs,
  agreementLine,
  alignmentRewritePrompt,
  distillGuidelinesFromPairs,
  pairLabelsWithCases,
  parseAlignedGuidelines,
  type AlignmentAgreement,
  type AlignmentPair,
  type JudgeCaseForAlignment,
} from '../../shared/eval-judge-alignment';
import type { LakebaseReader } from './lakebase-store';
import { extractJudgeContent, type JudgeInvoker } from './mlflow-judges';

/**
 * True alignment: last Phase B guidelines verdicts vs human labels, then a
 * replacement rubric. MLflow judge.align is tried when the workspace answers;
 * Apps usually cannot call it.
 */

export const JUDGE_ALIGN_PATHS = [
  '/api/2.0/mlflow/genai/judges/align',
  '/api/2.0/mlflow/judges/align',
] as const;

export interface AlignApiClient {
  request(input: { method: string; path: string; payload?: Record<string, unknown> }): Promise<unknown>;
}

export interface AlignmentResult {
  guidelinesText: string;
  agreement: AlignmentAgreement;
  method: 'mlflow' | 'rewrite' | 'distill';
  note: string;
  pairs: AlignmentPair[];
}

export async function loadCasesForAlignment(
  client: LakebaseReader,
  runIds: readonly string[]
): Promise<JudgeCaseForAlignment[]> {
  const cases: JudgeCaseForAlignment[] = [];
  for (const id of runIds) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    try {
      const result = await client.lakebase.query(
        `SELECT metrics_json FROM ${appTable('benchmark_runs')} WHERE id = $1`,
        [trimmed]
      );
      const raw = result?.rows?.[0]?.metrics_json;
      const metrics = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const listed = Array.isArray((metrics as { cases?: unknown } | null)?.cases)
        ? ((metrics as { cases: JudgeCaseForAlignment[] }).cases)
        : [];
      cases.push(...listed);
    } catch {
      // A missing run is a missing pair, not a failed align.
    }
  }
  return cases;
}

export function guidelinesFromAlignBody(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const instructions =
    record.instructions ??
    record.guidelines ??
    (record.judge as { instructions?: unknown; guidelines?: unknown } | undefined)?.instructions ??
    (record.judge as { guidelines?: unknown } | undefined)?.guidelines;
  return typeof instructions === 'string' ? instructions.trim() : '';
}

export async function tryMLflowJudgeAlign(
  client: AlignApiClient,
  input: { experimentId: string; guidelines: string; pairs: readonly AlignmentPair[] }
): Promise<string> {
  let lastError: unknown = new Error('No judge-align path answered.');
  for (const path of JUDGE_ALIGN_PATHS) {
    try {
      const body = await client.request({
        method: 'POST',
        path,
        payload: {
          name: 'guidelines',
          instructions: input.guidelines,
          experiment_id: input.experimentId.trim() || undefined,
          assessments: input.pairs.map((pair) => ({
            name: 'guidelines',
            question: pair.question,
            human: pair.human,
            judge: pair.judge,
          })),
        },
      });
      const next = guidelinesFromAlignBody(body);
      if (next) return next;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function rewriteGuidelinesWithJudge(
  invoke: JudgeInvoker,
  base: string,
  pairs: readonly AlignmentPair[]
): Promise<string> {
  const raw = await invoke({
    messages: [{ role: 'user', content: alignmentRewritePrompt(base, pairs) }],
    temperature: 0,
    max_tokens: 2048,
  });
  const next = parseAlignedGuidelines(extractJudgeContent(raw) ?? '');
  if (!next) throw new Error('The judge model did not return replacement guidelines.');
  return next.slice(0, 4000);
}

export async function alignGuidelinesToHumans(input: {
  base: string;
  rows: readonly AlignableRow[];
  cases: readonly JudgeCaseForAlignment[];
  experimentId?: string;
  alignClient?: AlignApiClient;
  invokeJudge?: JudgeInvoker;
}): Promise<AlignmentResult> {
  const pairs = pairLabelsWithCases(input.rows, input.cases);
  const agreement = agreementFromPairs(pairs);
  if (pairs.length === 0) {
    return {
      guidelinesText: input.base.trim(),
      agreement,
      method: 'distill',
      note: 'Label at least one row before aligning.',
      pairs,
    };
  }

  if (input.alignClient) {
    try {
      const next = await tryMLflowJudgeAlign(input.alignClient, {
        experimentId: input.experimentId ?? '',
        guidelines: input.base,
        pairs,
      });
      return {
        guidelinesText: next.slice(0, 4000),
        agreement,
        method: 'mlflow',
        note: `MLflow aligned the guidelines judge. ${agreementLine(agreement)}`,
        pairs,
      };
    } catch {
      // Apps usually cannot call judge.align. Fall through.
    }
  }

  if (input.invokeJudge) {
    try {
      const next = await rewriteGuidelinesWithJudge(input.invokeJudge, input.base, pairs);
      return {
        guidelinesText: next,
        agreement,
        method: 'rewrite',
        note: `Guidelines were rewritten to match human verdicts. ${agreementLine(agreement)}`,
        pairs,
      };
    } catch (error) {
      const distilled = distillGuidelinesFromPairs(input.base, input.rows, pairs);
      return {
        guidelinesText: distilled,
        agreement,
        method: 'distill',
        note: `The judge model could not rewrite the rubric (${(error as Error).message}). Distilled replacement guidelines from the labels instead. ${agreementLine(agreement)}`,
        pairs,
      };
    }
  }

  const distilled = distillGuidelinesFromPairs(input.base, input.rows, pairs);
  return {
    guidelinesText: distilled,
    agreement,
    method: 'distill',
    note: `Replacement guidelines distilled from human labels. ${agreementLine(agreement)} MLflow judge.align was not available from this app.`,
    pairs,
  };
}
