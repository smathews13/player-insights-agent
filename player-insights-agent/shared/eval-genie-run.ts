import { z } from 'zod';
import {
  MATCHING_POLICY_FACT,
  MATCHING_POLICY_ID,
  MATCHING_POLICY_REFERENCE,
  SUITE_KINDS,
  type ExecutedTable,
} from './benchmark-lab-v3';
import { GENIE_MISS_KINDS } from './eval-flywheel';

/**
 * The Genie accuracy run the Evaluation set / diagnostics surfaces persist.
 *
 * Matching is executed-result equivalence. SQL text is evidence on a failure,
 * not the pass test. A warehouse still starting, or a 50s cancel, is excluded
 * from the denominator rather than scored as Genie-wrong.
 */

export const GenieAccuracyOutcomeSchema = z.enum(['pass', 'fail', 'error', 'excluded']);
export type GenieAccuracyOutcome = z.infer<typeof GenieAccuracyOutcomeSchema>;

const ExecutedColumnSchema = z.strictObject({
  name: z.string(),
  values: z.array(z.unknown()).max(500),
});

export const ExecutedTableViewSchema = z.strictObject({
  rowCount: z.number().int().nonnegative(),
  columns: z.array(ExecutedColumnSchema).max(80),
});

export const GenieAccuracyCaseViewSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  question: z.string().trim().max(4000).default(''),
  outcome: GenieAccuracyOutcomeSchema,
  predictedSql: z.string().trim().max(20_000).default(''),
  groundTruthSql: z.string().trim().max(20_000).default(''),
  note: z.string().trim().max(800).default(''),
  durationMs: z.number().nonnegative().default(0),
  missKind: z.enum(GENIE_MISS_KINDS).nullable().default(null),
  excluded: z.boolean().default(false),
  conversationId: z.string().trim().max(120).default(''),
  comparisonReason: z.string().trim().max(800).default(''),
  predictedTable: ExecutedTableViewSchema.nullable().optional(),
  groundTable: ExecutedTableViewSchema.nullable().optional(),
});

export type GenieAccuracyCaseView = z.infer<typeof GenieAccuracyCaseViewSchema>;

export const GenieAccuracyRunViewSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  spaceId: z.string().trim().min(1).max(200),
  spaceLabel: z.string().trim().max(200).default(''),
  startedAt: z.string().trim().min(1).max(40),
  finishedAt: z.string().trim().min(1).max(40),
  suiteKind: z.enum(SUITE_KINDS),
  datasetVersion: z.string().trim().max(40).default('unversioned'),
  matchingPolicyId: z.literal(MATCHING_POLICY_ID).default(MATCHING_POLICY_ID),
  matchingPolicyFact: z.literal(MATCHING_POLICY_FACT).default(MATCHING_POLICY_FACT),
  matchingPolicyHref: z.literal(MATCHING_POLICY_REFERENCE).default(MATCHING_POLICY_REFERENCE),
  score: z.strictObject({
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percent: z.number().nullable(),
    label: z.string().trim().max(200),
    excluded: z.number().int().nonnegative().default(0),
  }),
  cases: z.array(GenieAccuracyCaseViewSchema).max(200),
});

export type GenieAccuracyRunView = z.infer<typeof GenieAccuracyRunViewSchema>;

export function parseGenieAccuracyRun(value: unknown): GenieAccuracyRunView | null {
  const parsed = GenieAccuracyRunViewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function tableView(table: ExecutedTable | null | undefined): z.infer<typeof ExecutedTableViewSchema> | null {
  if (!table) return null;
  return {
    rowCount: table.rowCount,
    columns: table.columns.map((column) => ({
      name: column.name,
      values: column.values.slice(0, 500),
    })),
  };
}
