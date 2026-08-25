import { z } from 'zod';

/**
 * The evaluation dataset Acme runs: questions first, then Genie accuracy,
 * then agent judges on the same rows.
 *
 * A row may carry ground-truth SQL (Phase A) and/or an expected answer
 * (Phase B). Neither is required to save the row; a run only scores the half
 * that has something to compare against.
 */

export const OPERATOR_EVAL_SUITE_ID = 'operator-eval';
export const OPERATOR_EVAL_SUITE_NAME = 'Your evaluation dataset';

export const DATASET_SIZE_MILESTONES = [10, 20, 30] as const;
export type DatasetSizeMilestone = (typeof DATASET_SIZE_MILESTONES)[number];

export const AGENT_JUDGE_IDS = ['groundedness', 'relevance', 'guidelines'] as const;
export type AgentJudgeId = (typeof AGENT_JUDGE_IDS)[number];

export const EvalRowSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  question: z.string().trim().max(2000).default(''),
  groundTruthSql: z.string().trim().max(20_000).default(''),
  expectedAnswer: z.string().trim().max(4000).default(''),
  /** Human: was the predicted SQL right? Empty until someone labels it. */
  sqlCorrect: z.enum(['yes', 'no', '']).default(''),
  /** Human thumbs on the row, for aligning the guidelines judge. */
  thumbs: z.enum(['up', 'down', '']).default(''),
});

export type EvalRow = z.infer<typeof EvalRowSchema>;

export const EvalDatasetSchema = z.strictObject({
  rows: z.array(EvalRowSchema).max(200).default([]),
});

export type EvalDataset = z.infer<typeof EvalDatasetSchema>;

export const EMPTY_EVAL_DATASET: EvalDataset = { rows: [] };

/**
 * The six POC questions, with no SQL and no expected prose.
 *
 * Starter text only. Ground truth is what the operator writes; inventing
 * customer SQL here would be a labelled number that goes stale.
 */
export const POC_STARTER_QUESTIONS: readonly string[] = [
  'How many active players did each title have in the last 30 days?',
  'Which identifier should count unique players?',
  'Compare engagement across our top three titles.',
  'Check null ratios in the latest player activity.',
  'Chart 30-day active players by label and title.',
  'Show me restricted competitor-level player data.',
];

export function emptyEvalRow(id: string = newEvalRowId()): EvalRow {
  return { id, question: '', groundTruthSql: '', expectedAnswer: '', sqlCorrect: '', thumbs: '' };
}

export function newEvalRowId(): string {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseEvalDataset(value: unknown): EvalDataset {
  return EvalDatasetSchema.parse(value ?? EMPTY_EVAL_DATASET);
}

export function starterEvalDataset(): EvalDataset {
  return {
    rows: POC_STARTER_QUESTIONS.map((question, index) => ({
      id: `poc-${index + 1}`,
      question,
      groundTruthSql: '',
      expectedAnswer: '',
      sqlCorrect: '',
      thumbs: '',
    })),
  };
}

export function sqlBackedRows(rows: readonly EvalRow[]): EvalRow[] {
  return rows.filter((row) => row.question.trim() && row.groundTruthSql.trim());
}

export function expectedAnswerRows(rows: readonly EvalRow[]): EvalRow[] {
  return rows.filter((row) => row.question.trim() && row.expectedAnswer.trim());
}

export function questionRows(rows: readonly EvalRow[]): EvalRow[] {
  return rows.filter((row) => row.question.trim());
}

export interface DatasetCounts {
  total: number;
  questions: number;
  sqlBacked: number;
  expectedAnswer: number;
  /** The 10 / 20 / 30 rung the set has reached, or 0 when it is still under 10. */
  milestone: 0 | DatasetSizeMilestone;
}

export function datasetCounts(rows: readonly EvalRow[]): DatasetCounts {
  const questions = questionRows(rows).length;
  const milestone =
    questions >= 30 ? 30 : questions >= 20 ? 20 : questions >= 10 ? 10 : 0;
  return {
    total: rows.length,
    questions,
    sqlBacked: sqlBackedRows(rows).length,
    expectedAnswer: expectedAnswerRows(rows).length,
    milestone,
  };
}

export function datasetSizeLabel(counts: DatasetCounts): string {
  return `${counts.questions} question${counts.questions === 1 ? '' : 's'} · 10 / 20 / 30`;
}

/**
 * Collapse a statement so two equivalent Genie answers can match.
 *
 * Comments and trailing semicolons go; whitespace folds; case is ignored.
 * This is a SQL-text compare, not a result-set compare.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*$/g, '')
    .trim()
    .toLowerCase();
}

export function sqlMatches(predicted: string, groundTruth: string): boolean {
  const left = normalizeSql(predicted);
  const right = normalizeSql(groundTruth);
  return left.length > 0 && left === right;
}

export interface AccuracyScore {
  passed: number;
  total: number;
  /** Null when nothing was scored, so a missing run is never drawn as 0%. */
  percent: number | null;
  label: string;
}

export function accuracyScore(passed: number, total: number): AccuracyScore {
  if (!Number.isFinite(passed) || !Number.isFinite(total) || total <= 0) {
    return { passed: 0, total: 0, percent: null, label: 'No SQL-backed questions to score' };
  }
  const safePassed = Math.max(0, Math.min(Math.floor(passed), Math.floor(total)));
  const percent = (safePassed / total) * 100;
  const shown = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
  return {
    passed: safePassed,
    total,
    percent,
    label: `${safePassed}/${total} = ${shown}%`,
  };
}

export const DEFAULT_GUIDELINES_TEXT =
  'The response is accurate, professional, and stays within the governed data the question asked about.';

/**
 * Fold human labels into the guidelines the judge will read next.
 *
 * This is alignment in the small: the operator's thumbs and "SQL correct?"
 * answers become extra sentences. It does not train a model.
 */
export function alignGuidelinesFromLabels(base: string, rows: readonly EvalRow[]): string {
  const extras: string[] = [];
  for (const row of rows) {
    if (!row.question.trim()) continue;
    if (row.sqlCorrect === 'yes') {
      extras.push(`When asked "${row.question}", a correct response publishes SQL that matches the labelled ground truth.`);
    }
    if (row.sqlCorrect === 'no') {
      extras.push(`When asked "${row.question}", do not publish SQL that disagrees with the labelled ground truth.`);
    }
    if (row.thumbs === 'up' && row.expectedAnswer.trim()) {
      extras.push(`A good answer to "${row.question}" looks like: ${row.expectedAnswer.trim()}`);
    }
    if (row.thumbs === 'down') {
      extras.push(`The previous style of answer to "${row.question}" was rejected. Stay closer to the labelled expected answer.`);
    }
  }
  const unique = [...new Set(extras)];
  if (unique.length === 0) return base.trim();
  return [base.trim(), 'Human labels:', ...unique].filter(Boolean).join('\n');
}

export function labeledRowCount(rows: readonly EvalRow[]): number {
  return rows.filter((row) => row.sqlCorrect || row.thumbs).length;
}

/** Questions from Ask / Monitoring that are not already in the dataset. */
export function uniqueQuestionsToAdd(existing: readonly EvalRow[], incoming: readonly string[]): EvalRow[] {
  const seen = new Set(
    existing.map((row) => row.question.trim().toLowerCase()).filter((question) => question.length > 0)
  );
  const added: EvalRow[] = [];
  for (const raw of incoming) {
    const question = raw.trim();
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ ...emptyEvalRow(newEvalRowId()), question });
  }
  return added;
}

export function parseEnabledJudges(value: unknown): AgentJudgeId[] {
  if (!Array.isArray(value)) return [...AGENT_JUDGE_IDS];
  const allowed = new Set<string>(AGENT_JUDGE_IDS);
  const unique = [...new Set(value.filter((entry): entry is AgentJudgeId => typeof entry === 'string' && allowed.has(entry)))];
  return unique.length > 0 ? unique : [...AGENT_JUDGE_IDS];
}
