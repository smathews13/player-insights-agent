import { z } from 'zod';
import { SCORER_CATALOG, type ScorerDefinition } from './scorer-catalog';
import type { Scorecard, ScorecardValue } from './scorecard-contract';

/**
 * Benchmark Lab v3: the shared contract UI surfaces import.
 *
 * Behavior lives here so the six regions cannot invent their own counters,
 * gates, or apply paths. Look tokens are the dark-mode / PDF chrome the
 * layout agent already has to match; they are not a second visual system.
 */

export const LAB_V3_SPEC = 'benchmark-lab-v3' as const;

/** Same alias Ask loads. Named here so this module does not import the flywheel. */
export const LAB_PRODUCTION_ALIAS = 'production';

export const LAB_V3_CHROME = {
  referenceWidthPx: 1080,
  contractStripPx: 52,
  spineNodePx: 28,
  spineInsetPx: 62,
  buttonPx: 30,
  surfaceFill: 'rgba(255,255,255,0.04)',
  hairline: 'rgba(255,255,255,0.12)',
  spineLine: 'rgba(143,193,232,0.35)',
  ghostFill: 'rgba(34,114,180,0.28)',
  ghostBorder: 'rgba(143,193,232,0.55)',
  ghostText: '#E8F2FA',
  secondaryFill: 'rgba(255,255,255,0.05)',
  secondaryBorder: 'rgba(255,255,255,0.3)',
  positiveDelta: '#9AD6CE',
  regressionDelta: '#E8A9B8',
  surfaceHeights: { a: 740, b: 600, c: 560, d: 560, e: 480, f: 520 },
} as const;

export const CASE_TAGS = ['happy_path', 'edge_case', 'refusal', 'multi_turn', 'empty_result', 'security'] as const;
export type CaseTag = (typeof CASE_TAGS)[number];

export const CASE_SPLITS = ['tuning', 'held_out'] as const;
export type CaseSplit = (typeof CASE_SPLITS)[number];

export const CASE_REVIEWS = ['draft', 'reviewed', 'disputed', 'approved'] as const;
export type CaseReview = (typeof CASE_REVIEWS)[number];

export const CASE_SOURCES = ['manual', 'trace'] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];

export const IMPORT_FILTERS = ['low_judge_score', 'tool_failure', 'latency', 'customer_feedback'] as const;
export type ImportFilter = (typeof IMPORT_FILTERS)[number];

export const IMPORT_FILTER_LABELS: Record<ImportFilter, string> = {
  low_judge_score: 'low judge score',
  tool_failure: 'tool failure',
  latency: 'latency',
  customer_feedback: 'customer feedback',
};

export const APPLY_TARGET_KINDS = ['prompt_registry', 'genie_space', 'rag_config'] as const;
export type ApplyTargetKind = (typeof APPLY_TARGET_KINDS)[number];

export const SUITE_KINDS = ['complete', 'partial'] as const;
export type SuiteKind = (typeof SUITE_KINDS)[number];

export const GENIE_CASE_OUTCOMES = ['pass', 'fail', 'excluded'] as const;
export type GenieCaseOutcome = (typeof GENIE_CASE_OUTCOMES)[number];

export const HELD_OUT_STATUSES = ['evaluated', 'provisional', 'not_evaluated', 'skipped', 'errored'] as const;
export type HeldOutStatus = (typeof HELD_OUT_STATUSES)[number];

export const SPAN_KINDS = ['AGENT', 'LLM', 'DISCOVERY', 'SQL'] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

/** Amber "slow" on a span when wall time reaches ten seconds. */
export const SPAN_SLOW_MS = 10_000;

export type SpanStatus = 'ok' | 'slow' | 'error';

export interface LabSpan {
  id: string;
  name: string;
  kind: SpanKind;
  durationMs: number | null;
  status: SpanStatus;
  tokens: number | null;
  cost: number | null;
}

export function classifySpanKind(name: string, kind: string): SpanKind {
  const blob = `${name} ${kind}`.toLowerCase();
  if (/\bsql\b|warehouse|query/.test(blob)) return 'SQL';
  if (/discover|catalog|schema|search|retriev|index/.test(blob)) return 'DISCOVERY';
  if (/llm|judge|chat|completion|model|generation/.test(blob)) return 'LLM';
  return 'AGENT';
}

export function spanStatus(input: {
  outcome?: string | null;
  durationMs?: number | null;
  failed?: boolean;
}): SpanStatus {
  if (input.failed) return 'error';
  const outcome = (input.outcome || '').toLowerCase();
  if (outcome === 'failed' || outcome === 'errored' || outcome === 'error') return 'error';
  if (typeof input.durationMs === 'number' && input.durationMs >= SPAN_SLOW_MS) return 'slow';
  return 'ok';
}

export const RUN_SIDES = ['baseline', 'candidate'] as const;
export type RunSide = (typeof RUN_SIDES)[number];

export const THIS_RUN_NEEDS = ['RESPONSE PER CASE', 'TRACE FOR STEP SCORERS', 'SESSION ID FOR MULTI-TURN'] as const;

export const MATCHING_POLICY_ID = 'executed-result-equivalence' as const;

export const MATCHING_POLICY_FACT =
  'Matching policy: executed-result equivalence. Tolerates reordering and extra columns. Rejects under-selection.';

export const MATCHING_POLICY_REFERENCE = '#lab-matching-policy';

export const PARTIAL_RESULTS_FACT =
  'Partial results save as the run goes; one failed case does not void the suite.';

export const HELD_OUT_LOCK_FACT = 'held-out cases are frozen, edits create an audit entry';

export const GOVERNANCE_FACT = 'PII redaction on · role-gated';

export const EvalLabRowExtrasSchema = z.strictObject({
  tag: z.enum(CASE_TAGS).optional(),
  split: z.enum(CASE_SPLITS).optional(),
  review: z.enum(CASE_REVIEWS).optional(),
  sourceKind: z.enum(CASE_SOURCES).optional(),
  sourceTraceId: z.string().trim().max(120).optional(),
  retired: z.boolean().optional(),
  expectedFacts: z.string().trim().max(4000).optional(),
  expectedResponse: z.string().trim().max(8000).optional(),
  perCaseGuidelines: z.string().trim().max(4000).optional(),
  conversation: z.string().trim().max(20_000).optional(),
  heldOutLockedAt: z.string().trim().max(40).optional(),
});

export type EvalLabRowExtras = z.infer<typeof EvalLabRowExtrasSchema>;

export const LAB_ROW_EXTRA_KEYS = [
  'tag',
  'split',
  'review',
  'sourceKind',
  'sourceTraceId',
  'retired',
  'expectedFacts',
  'expectedResponse',
  'perCaseGuidelines',
  'conversation',
  'heldOutLockedAt',
] as const satisfies readonly (keyof EvalLabRowExtras)[];

export interface EvalRowLike extends EvalLabRowExtras {
  id: string;
  question: string;
  groundTruthSql: string;
  expectedAnswer: string;
  sqlCorrect: 'yes' | 'no' | '';
  thumbs: 'up' | 'down' | '';
}

export interface LabCase {
  id: string;
  question: string;
  conversation: string;
  tag: CaseTag | '';
  groundTruthSql: string;
  expectedFacts: string;
  expectedResponse: string;
  perCaseGuidelines: string;
  split: CaseSplit;
  review: CaseReview;
  sourceKind: CaseSource;
  sourceTraceId: string;
  retired: boolean;
  heldOutLockedAt: string;
  sqlCorrect: 'yes' | 'no' | '';
  thumbs: 'up' | 'down' | '';
}

export function labCaseFromRow(row: EvalRowLike): LabCase {
  const expectedResponse = (row.expectedResponse ?? row.expectedAnswer ?? '').trim();
  return {
    id: row.id,
    question: row.question,
    conversation: row.conversation?.trim() ?? '',
    tag: row.tag ?? '',
    groundTruthSql: row.groundTruthSql,
    expectedFacts: row.expectedFacts?.trim() ?? '',
    expectedResponse,
    perCaseGuidelines: row.perCaseGuidelines?.trim() ?? '',
    split: row.split ?? 'tuning',
    review: row.review ?? 'draft',
    sourceKind: row.sourceKind ?? (row.sourceTraceId?.trim() ? 'trace' : 'manual'),
    sourceTraceId: row.sourceTraceId?.trim() ?? '',
    retired: row.retired === true,
    heldOutLockedAt: row.heldOutLockedAt?.trim() ?? '',
    sqlCorrect: row.sqlCorrect,
    thumbs: row.thumbs,
  };
}

export function evalRowPatchFromLabCase(row: LabCase): EvalRowLike {
  return {
    id: row.id,
    question: row.question,
    groundTruthSql: row.groundTruthSql,
    expectedAnswer: row.expectedResponse,
    sqlCorrect: row.sqlCorrect,
    thumbs: row.thumbs,
    tag: row.tag || undefined,
    split: row.split,
    review: row.review,
    sourceKind: row.sourceKind,
    sourceTraceId: row.sourceTraceId || undefined,
    retired: row.retired || undefined,
    expectedFacts: row.expectedFacts || undefined,
    expectedResponse: row.expectedResponse || undefined,
    perCaseGuidelines: row.perCaseGuidelines || undefined,
    conversation: row.conversation || undefined,
    heldOutLockedAt: row.heldOutLockedAt || undefined,
  };
}

export function caseHasSql(row: Pick<LabCase, 'groundTruthSql'>): boolean {
  return row.groundTruthSql.trim().length > 0;
}

export function caseHasAgentLabel(row: Pick<LabCase, 'expectedFacts' | 'expectedResponse' | 'perCaseGuidelines'>): boolean {
  return Boolean(row.expectedFacts.trim() || row.expectedResponse.trim() || row.perCaseGuidelines.trim());
}

export function genieLaneReady(row: Pick<LabCase, 'question' | 'groundTruthSql'>): boolean {
  return Boolean(row.question.trim() && caseHasSql(row));
}

export function agentLaneReady(row: Pick<LabCase, 'question' | 'expectedFacts' | 'expectedResponse' | 'perCaseGuidelines'>): boolean {
  return Boolean(row.question.trim() && caseHasAgentLabel(row));
}

export function isReviewed(review: CaseReview): boolean {
  return review === 'reviewed' || review === 'approved';
}

export interface LabDatasetCounts {
  cases: number;
  active: number;
  retired: number;
  sqlComplete: number;
  reviewed: number;
  heldOut: number;
  genieLaneReady: number;
  agentLaneReady: number;
  reviewerOpen: number;
}

export function labDatasetCounts(cases: readonly LabCase[]): LabDatasetCounts {
  const active = cases.filter((row) => !row.retired);
  return {
    cases: cases.length,
    active: active.length,
    retired: cases.length - active.length,
    sqlComplete: active.filter(caseHasSql).length,
    reviewed: active.filter((row) => isReviewed(row.review)).length,
    heldOut: active.filter((row) => row.split === 'held_out').length,
    genieLaneReady: active.filter(genieLaneReady).length,
    agentLaneReady: active.filter(agentLaneReady).length,
    reviewerOpen: active.filter((row) => row.review === 'draft' || row.review === 'disputed').length,
  };
}

export function datasetHeaderLine(counts: LabDatasetCounts): string {
  return `${counts.cases} cases · ${counts.active} active · ${counts.retired} retired · ${counts.reviewed} reviewed · ${counts.heldOut} held out`;
}

export function laneReadinessLine(counts: LabDatasetCounts): string {
  return `Genie lane ready ${counts.genieLaneReady} · agent lane ready ${counts.agentLaneReady}`;
}

export function stage01Fact(counts: LabDatasetCounts): string {
  return `${counts.cases} cases · ${counts.sqlComplete} SQL complete · ${counts.reviewed} reviewed · ${counts.heldOut} held out`;
}

export function reviewerQueueChip(counts: LabDatasetCounts): string {
  return `Reviewer queue · ${counts.reviewerOpen} open`;
}

export function missingSqlGateCopy(missing: number, selected: number): string {
  return `${missing} of ${selected} selected cases are missing SQL. Fix them in 01 or run partial: the excluded cases and the denominator are shown on the result.`;
}

export function genieSuitePlan(cases: readonly LabCase[], selectedIds?: readonly string[]): {
  kind: SuiteKind;
  selected: LabCase[];
  sqlReady: LabCase[];
  missingSql: LabCase[];
  canRunComplete: boolean;
  gateCopy: string | null;
} {
  const active = cases.filter((row) => !row.retired);
  const selected = selectedIds?.length
    ? active.filter((row) => selectedIds.includes(row.id))
    : active;
  const sqlReady = selected.filter(genieLaneReady);
  const missingSql = selected.filter((row) => row.question.trim() && !caseHasSql(row));
  const canRunComplete = missingSql.length === 0 && sqlReady.length > 0;
  return {
    kind: canRunComplete ? 'complete' : 'partial',
    selected,
    sqlReady,
    missingSql,
    canRunComplete,
    gateCopy: missingSql.length > 0 ? missingSqlGateCopy(missingSql.length, selected.length) : null,
  };
}

export const PassGateSchema = z.strictObject({
  id: z.enum(['genie_accuracy', 'groundedness']),
  label: z.string().trim().min(1).max(80),
  minimum: z.number().min(0).max(1).nullable(),
});

export type PassGate = z.infer<typeof PassGateSchema>;

export const PassGatesSchema = z.strictObject({
  genieAccuracy: PassGateSchema.default({ id: 'genie_accuracy', label: 'Genie accuracy', minimum: null }),
  groundedness: PassGateSchema.default({ id: 'groundedness', label: 'Groundedness', minimum: null }),
  regressionsAlwaysShown: z.literal(true).default(true),
});

export type PassGates = z.infer<typeof PassGatesSchema>;

export const DEFAULT_PASS_GATES: PassGates = {
  genieAccuracy: { id: 'genie_accuracy', label: 'Genie accuracy', minimum: null },
  groundedness: { id: 'groundedness', label: 'Groundedness', minimum: null },
  regressionsAlwaysShown: true,
};

export const ApplyTargetSchema = z.strictObject({
  kind: z.enum(APPLY_TARGET_KINDS),
  identifier: z.string().trim().max(300).default(''),
  snapshotId: z.string().trim().max(80).default(''),
});

export type ApplyTarget = z.infer<typeof ApplyTargetSchema>;

export const DEFAULT_APPLY_TARGET: ApplyTarget = {
  kind: 'prompt_registry',
  identifier: '',
  snapshotId: '',
};

export const LabContractSchema = z.strictObject({
  goalLanes: z.array(z.enum(['genie', 'agent', 'trace'])).min(1).max(3).default(['genie', 'agent']),
  baselineRunId: z.string().trim().max(80).default(''),
  candidateRunId: z.string().trim().max(80).default(''),
  gates: PassGatesSchema.default(DEFAULT_PASS_GATES),
  scorerSetVersion: z.string().trim().max(40).default('ss-1'),
  target: ApplyTargetSchema.default(DEFAULT_APPLY_TARGET),
  approver: z.string().trim().max(200).default(''),
  liveRun: z
    .strictObject({
      runId: z.string().trim().max(80).default(''),
      side: z.enum(RUN_SIDES),
      caseIndex: z.number().int().nonnegative().default(0),
      caseTotal: z.number().int().nonnegative().default(0),
      cancelRequested: z.boolean().default(false),
      note: z.string().trim().max(400).default(''),
    })
    .nullable()
    .default(null),
});

export type LabContract = z.infer<typeof LabContractSchema>;

export const EMPTY_LAB_CONTRACT: LabContract = {
  goalLanes: ['genie', 'agent'],
  baselineRunId: '',
  candidateRunId: '',
  gates: DEFAULT_PASS_GATES,
  scorerSetVersion: 'ss-1',
  target: DEFAULT_APPLY_TARGET,
  approver: '',
  liveRun: null,
};

export const LabDatasetVersionSchema = z.strictObject({
  id: z.string().trim().min(1).max(40),
  parentId: z.string().trim().max(40).default(''),
  createdAt: z.string().trim().min(1).max(40),
  createdBy: z.string().trim().max(200).default(''),
  caseCount: z.number().int().nonnegative(),
  heldOutCount: z.number().int().nonnegative(),
  rows: z.array(z.unknown()).max(200).default([]),
});

export type LabDatasetVersion = z.infer<typeof LabDatasetVersionSchema> & { rows: EvalRowLike[] };

export const HeldOutAuditSchema = z.strictObject({
  at: z.string().trim().min(1).max(40),
  actor: z.string().trim().max(200).default(''),
  caseId: z.string().trim().min(1).max(80),
  versionId: z.string().trim().max(40).default(''),
  note: z.string().trim().max(400),
});

export type HeldOutAuditEntry = z.infer<typeof HeldOutAuditSchema>;

export const KnownFailureSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(80),
  at: z.string().trim().min(1).max(40),
  actor: z.string().trim().max(200).default(''),
  note: z.string().trim().max(400).default(''),
});

export type KnownFailure = z.infer<typeof KnownFailureSchema>;

export const AlignPreviewSchema = z.strictObject({
  preview: z.string().trim().max(4000).default(''),
  labeled: z.number().int().nonnegative().default(0),
  note: z.string().trim().max(800).default(''),
  saved: z.literal(false).default(false),
  at: z.string().trim().max(40).default(''),
});

export type AlignPreview = z.infer<typeof AlignPreviewSchema>;

export const ApplyRecordSchema = z.strictObject({
  at: z.string().trim().min(1).max(40),
  actor: z.string().trim().max(200).default(''),
  approver: z.string().trim().min(1).max(200),
  candidateRunId: z.string().trim().max(80).default(''),
  datasetVersionId: z.string().trim().max(40).default(''),
  target: ApplyTargetSchema,
  status: z.enum(['moved', 'handoff', 'not_configured', 'blocked']),
  changedArtifacts: z.array(z.string().trim().max(200)).max(12).default([]),
  rollbackPath: z.string().trim().max(400).default(''),
  connectionsChanged: z.literal(false).default(false),
  wroteGenieInstructions: z.literal(false).default(false),
  note: z.string().trim().max(800).default(''),
});

export type ApplyRecord = z.infer<typeof ApplyRecordSchema>;

export const LabStateSchema = z.strictObject({
  currentVersionId: z.string().trim().max(40).default(''),
  versions: z.array(LabDatasetVersionSchema).max(50).default([]),
  heldOutAudit: z.array(HeldOutAuditSchema).max(200).default([]),
  knownFailures: z.array(KnownFailureSchema).max(200).default([]),
  contract: LabContractSchema.default(EMPTY_LAB_CONTRACT),
  alignPreview: AlignPreviewSchema.nullable().default(null),
  applyHistory: z.array(ApplyRecordSchema).max(50).default([]),
  configurationSnapshotId: z.string().trim().max(80).default(''),
});

export type LabState = z.infer<typeof LabStateSchema>;

export const EMPTY_LAB_STATE: LabState = {
  currentVersionId: '',
  versions: [],
  heldOutAudit: [],
  knownFailures: [],
  contract: EMPTY_LAB_CONTRACT,
  alignPreview: null,
  applyHistory: [],
  configurationSnapshotId: '',
};

export function parseLabState(value: unknown): LabState {
  return LabStateSchema.parse(value ?? EMPTY_LAB_STATE);
}

export function nextDatasetVersionId(versions: readonly { id: string }[]): string {
  let max = 0;
  for (const entry of versions) {
    const match = /^ds_v(\d+)$/i.exec(entry.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `ds_v${String(max + 1).padStart(3, '0')}`;
}

export function commitDatasetVersion(input: {
  state: LabState;
  rows: readonly EvalRowLike[];
  actor: string;
  at?: string;
}): { state: LabState; version: LabDatasetVersion } {
  const cases = input.rows.map(labCaseFromRow);
  const counts = labDatasetCounts(cases);
  const version: LabDatasetVersion = {
    id: nextDatasetVersionId(input.state.versions),
    parentId: input.state.currentVersionId,
    createdAt: input.at ?? new Date().toISOString(),
    createdBy: input.actor,
    caseCount: counts.cases,
    heldOutCount: counts.heldOut,
    rows: [...input.rows],
  };
  return {
    version,
    state: {
      ...input.state,
      currentVersionId: version.id,
      versions: [version, ...input.state.versions].slice(0, 50),
    },
  };
}

export function heldOutEditCreatesAudit(prior: LabCase, next: LabCase): boolean {
  if (prior.split !== 'held_out' && next.split !== 'held_out') return false;
  if (prior.split !== 'held_out' && next.split === 'held_out') return false;
  return (
    prior.question !== next.question ||
    prior.groundTruthSql !== next.groundTruthSql ||
    prior.expectedFacts !== next.expectedFacts ||
    prior.expectedResponse !== next.expectedResponse ||
    prior.perCaseGuidelines !== next.perCaseGuidelines ||
    prior.conversation !== next.conversation ||
    prior.retired !== next.retired
  );
}

export function auditHeldOutEdits(input: {
  prior: readonly LabCase[];
  next: readonly LabCase[];
  actor: string;
  versionId: string;
  at?: string;
}): HeldOutAuditEntry[] {
  const previous = new Map(input.prior.map((row) => [row.id, row]));
  const at = input.at ?? new Date().toISOString();
  const entries: HeldOutAuditEntry[] = [];
  for (const row of input.next) {
    const last = previous.get(row.id);
    if (!last) continue;
    if (!heldOutEditCreatesAudit(last, row)) continue;
    entries.push({
      at,
      actor: input.actor,
      caseId: row.id,
      versionId: input.versionId,
      note: `Held-out case ${row.id} was edited after the split.`,
    });
  }
  return entries;
}

export function duplicateAsEdgeCase(row: LabCase, newId: string): LabCase {
  return {
    ...row,
    id: newId,
    tag: 'edge_case',
    split: 'tuning',
    review: 'draft',
    sourceKind: 'manual',
    sourceTraceId: '',
    retired: false,
    heldOutLockedAt: '',
  };
}

export function lockHeldOut(row: LabCase, at: string): LabCase {
  if (row.split !== 'held_out') return { ...row, split: 'held_out', heldOutLockedAt: at };
  return { ...row, heldOutLockedAt: row.heldOutLockedAt || at };
}

export function scorerSetSummary(input: {
  version: string;
  enabledJudges: readonly string[];
  extraJudges?: number;
}): { version: string; activeCount: number; nonApplicableCount: number; line: string } {
  const activeCount = input.enabledJudges.length + (input.extraJudges ?? 0);
  const nonApplicableCount = SCORER_CATALOG.filter((entry) => entry.availability === 'unimplementable').length;
  return {
    version: input.version,
    activeCount,
    nonApplicableCount,
    line: `${input.version} · ${activeCount} active · ${nonApplicableCount} not applicable`,
  };
}

export function configurationSnapshotHref(snapshotId: string): string {
  const id = snapshotId.trim();
  return id ? `/benchmarking?snapshot=${encodeURIComponent(id)}#lab-snapshot` : '#lab-snapshot';
}

export function runPermalink(input: { datasetVersionId?: string; baselineRunId?: string; candidateRunId?: string }): string {
  const params = new URLSearchParams();
  if (input.datasetVersionId) params.set('dataset', input.datasetVersionId);
  if (input.baselineRunId) params.set('baseline', input.baselineRunId);
  if (input.candidateRunId) params.set('candidate', input.candidateRunId);
  const query = params.toString();
  return query ? `/benchmarking?${query}` : '/benchmarking';
}

export interface ExecutedTable {
  columns: { name: string; values: unknown[] }[];
  rowCount: number;
}

export interface ResultComparison {
  equivalent: boolean;
  underSelected: boolean;
  reason: string;
}

function columnValues(table: ExecutedTable, name: string): unknown[] | null {
  const wanted = name.trim().toLowerCase();
  const column = table.columns.find((entry) => entry.name.trim().toLowerCase() === wanted);
  return column ? column.values : null;
}

function canonicalizeCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value).trim();
}

function sortedRowKeys(table: ExecutedTable, names: readonly string[]): string[] {
  const cols = names.map((name) => columnValues(table, name) ?? []);
  const keys: string[] = [];
  for (let index = 0; index < table.rowCount; index += 1) {
    keys.push(JSON.stringify(cols.map((col) => canonicalizeCell(col[index]))));
  }
  keys.sort();
  return keys;
}

export function executedTableFromMatrix(columns: readonly string[], rows: readonly unknown[][]): ExecutedTable {
  return {
    rowCount: rows.length,
    columns: columns.map((name, index) => ({
      name,
      values: rows.map((row) => row[index]),
    })),
  };
}

export function compareExecutedResults(generated: ExecutedTable, groundTruth: ExecutedTable): ResultComparison {
  const required = groundTruth.columns.map((entry) => entry.name.trim()).filter(Boolean);
  const missing = required.filter((name) => columnValues(generated, name) == null);
  if (missing.length > 0) {
    const requiredLookup = new Set(required.map((name) => name.toLowerCase()));
    const extra = generated.columns
      .map((entry) => entry.name.trim())
      .filter((name) => name && !requiredLookup.has(name.toLowerCase()));
    const swapped = extra.length === 1 && missing.length === 1;
    return {
      equivalent: false,
      underSelected: true,
      reason: swapped
        ? `Wrong measure column: \`${extra[0]}\` for \`${missing[0]}\`. Row count matches, values do not. Execution clean.`
        : `Under-selection: missing ${missing.map((name) => `\`${name}\``).join(', ')}. Extra columns would have been allowed.`,
    };
  }
  if (generated.rowCount !== groundTruth.rowCount) {
    return {
      equivalent: false,
      underSelected: false,
      reason: `Row count differs: generated ${generated.rowCount} against ground truth ${groundTruth.rowCount}.`,
    };
  }
  const leftRows = sortedRowKeys(generated, required);
  const rightRows = sortedRowKeys(groundTruth, required);
  if (JSON.stringify(leftRows) === JSON.stringify(rightRows)) {
    return {
      equivalent: true,
      underSelected: false,
      reason: 'Executed results match under reordering and extra-column tolerance.',
    };
  }
  for (const name of required) {
    const left = (columnValues(generated, name) ?? []).map(canonicalizeCell).slice().sort();
    const right = (columnValues(groundTruth, name) ?? []).map(canonicalizeCell).slice().sort();
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      return {
        equivalent: false,
        underSelected: false,
        reason: `Wrong measure column: values for \`${name}\` do not match. Row count matches, values do not. Execution clean.`,
      };
    }
  }
  return {
    equivalent: false,
    underSelected: false,
    reason: 'Row pairings differ after allowing reorder. Execution clean.',
  };
}

export type DeltaSign = 'positive' | 'regression' | 'neutral';

export interface MetricDelta {
  label: string;
  baseline: string;
  candidate: string;
  delta: string;
  sign: DeltaSign;
  gate?: string;
}

export function formatLabNumber(value: number | null | undefined, kind: 'percent' | 'count' | 'ms' | 'rate' = 'count'): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (kind === 'percent') return `${Math.round(value * 100)}%`;
  if (kind === 'rate') return value.toFixed(3).replace(/\.?0+$/, '');
  if (kind === 'ms') return `${Math.round(value)} ms`;
  return String(value);
}

export function signedDelta(baseline: number | null | undefined, candidate: number | null | undefined, higherIsBetter = true): {
  delta: string;
  sign: DeltaSign;
} {
  if (typeof baseline !== 'number' || typeof candidate !== 'number' || !Number.isFinite(baseline) || !Number.isFinite(candidate)) {
    return { delta: '-', sign: 'neutral' };
  }
  const diff = candidate - baseline;
  if (diff === 0) return { delta: '0', sign: 'neutral' };
  const improved = higherIsBetter ? diff > 0 : diff < 0;
  const shown = `${diff > 0 ? '+' : ''}${Number.isInteger(diff) ? String(diff) : diff.toFixed(3)}`;
  return { delta: shown, sign: improved ? 'positive' : 'regression' };
}

export interface LaneMetrics {
  genieAccuracy?: number | null;
  geniePassed?: number | null;
  genieTotal?: number | null;
  genieErrors?: number | null;
  genieDurationMs?: number | null;
  groundedness?: number | null;
  relevance?: number | null;
  guidelines?: number | null;
  judgeCoverage?: number | null;
  humanReviewed?: number | null;
  p50LatencyMs?: number | null;
  tokens?: number | null;
  estimatedCost?: number | null;
  toolErrorRate?: number | null;
  traceCoverage?: number | null;
}

export interface CaseOutcome {
  caseId: string;
  passed: boolean;
}

export function newlyFixedAndBroken(baseline: readonly CaseOutcome[], candidate: readonly CaseOutcome[]): {
  newlyFixed: string[];
  newlyBroken: string[];
} {
  const left = new Map(baseline.map((row) => [row.caseId, row.passed]));
  const newlyFixed: string[] = [];
  const newlyBroken: string[] = [];
  for (const row of candidate) {
    const prior = left.get(row.caseId);
    if (prior === false && row.passed) newlyFixed.push(row.caseId);
    if (prior === true && !row.passed) newlyBroken.push(row.caseId);
  }
  return { newlyFixed, newlyBroken };
}

export interface GateCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export function evaluatePassGates(input: {
  gates: PassGates;
  candidate: LaneMetrics;
  regressions: readonly string[];
}): { passed: number; total: number; line: string; checks: GateCheck[]; regressions: readonly string[] } {
  const checks: GateCheck[] = [];
  const accuracy = input.candidate.genieAccuracy;
  if (input.gates.genieAccuracy.minimum != null) {
    const ok = typeof accuracy === 'number' && accuracy >= input.gates.genieAccuracy.minimum;
    checks.push({
      id: 'genie_accuracy',
      label: input.gates.genieAccuracy.label,
      passed: ok,
      detail: ok
        ? `Genie accuracy ${formatLabNumber(accuracy, 'percent')} meets ${formatLabNumber(input.gates.genieAccuracy.minimum, 'percent')}.`
        : `Genie accuracy ${formatLabNumber(accuracy, 'percent')} is below ${formatLabNumber(input.gates.genieAccuracy.minimum, 'percent')}.`,
    });
  }
  const groundedness = input.candidate.groundedness;
  if (input.gates.groundedness.minimum != null) {
    const ok = typeof groundedness === 'number' && groundedness >= input.gates.groundedness.minimum;
    checks.push({
      id: 'groundedness',
      label: input.gates.groundedness.label,
      passed: ok,
      detail: ok
        ? `Groundedness ${formatLabNumber(groundedness, 'percent')} meets ${formatLabNumber(input.gates.groundedness.minimum, 'percent')}.`
        : `Groundedness ${formatLabNumber(groundedness, 'percent')} is below ${formatLabNumber(input.gates.groundedness.minimum, 'percent')}.`,
    });
  }
  const passed = checks.filter((entry) => entry.passed).length;
  return {
    passed,
    total: checks.length,
    line:
      checks.length === 0
        ? 'No numeric gates are set. Regressions are still shown.'
        : `passed ${passed} of ${checks.length} gates`,
    checks,
    regressions: input.regressions,
  };
}

export function gateStatusLine(runId: string, gates: { passed: number; total: number }): string {
  if (gates.total === 0) return `${runId} has no numeric gates set`;
  return `${runId} passed ${gates.passed} of ${gates.total} gates`;
}

export type ApplyDecisionStatus = 'moved' | 'handoff' | 'not_configured' | 'blocked';

export interface ApplyDecision {
  status: ApplyDecisionStatus;
  caption: string;
  changedArtifacts: string[];
  rollbackPath: string;
  connectionsChanged: false;
  wroteGenieInstructions: false;
  movesProductionAlias: boolean;
  note: string;
}

export function applyCandidateDecision(input: {
  target: ApplyTarget;
  approver: string;
  candidateRunId: string;
  datasetVersionId: string;
  gates: { passed: number; total: number; checks: GateCheck[] };
}): ApplyDecision {
  const approver = input.approver.trim();
  const failed = input.gates.checks.filter((entry) => !entry.passed);
  if (!approver) {
    return {
      status: 'blocked',
      caption: 'A named approver is required before applying the candidate.',
      changedArtifacts: [],
      rollbackPath: '',
      connectionsChanged: false,
      wroteGenieInstructions: false,
      movesProductionAlias: false,
      note: 'Apply is blocked until an approver is named.',
    };
  }
  if (failed.length > 0) {
    return {
      status: 'blocked',
      caption: `${input.candidateRunId} failed ${failed.length} of ${input.gates.total} gates.`,
      changedArtifacts: [],
      rollbackPath: '',
      connectionsChanged: false,
      wroteGenieInstructions: false,
      movesProductionAlias: false,
      note: failed.map((entry) => entry.detail).join(' '),
    };
  }
  if (input.target.kind === 'genie_space') {
    return {
      status: 'handoff',
      caption: 'Genie space opens the instruction workflow. This app does not write space instructions.',
      changedArtifacts: [],
      rollbackPath: 'Leave space instructions unchanged.',
      connectionsChanged: false,
      wroteGenieInstructions: false,
      movesProductionAlias: false,
      note: 'Handoff only. Connections are unchanged.',
    };
  }
  if (input.target.kind === 'rag_config') {
    return {
      status: 'not_configured',
      caption: 'Not configured for this target.',
      changedArtifacts: [],
      rollbackPath: '',
      connectionsChanged: false,
      wroteGenieInstructions: false,
      movesProductionAlias: false,
      note: 'Hand this change to the owning configuration. This app does not write RAG config.',
    };
  }
  const identifier = input.target.identifier.trim();
  return {
    status: identifier ? 'moved' : 'blocked',
    caption: identifier
      ? `Prompt Registry moves the ${LAB_PRODUCTION_ALIAS} alias after approval.`
      : 'Set a catalog.schema.prompt name before moving the production alias.',
    changedArtifacts: identifier ? [`prompts:/${identifier}@${LAB_PRODUCTION_ALIAS}`] : [],
    rollbackPath: identifier ? `Restore the previous ${LAB_PRODUCTION_ALIAS} alias on ${identifier}.` : '',
    connectionsChanged: false,
    wroteGenieInstructions: false,
    movesProductionAlias: Boolean(identifier),
    note: identifier
      ? `Candidate ${input.candidateRunId} on dataset ${input.datasetVersionId || 'working copy'}. Connections unchanged.`
      : 'Prompt Registry name is missing.',
  };
}

export function liveRunProgressLine(run: NonNullable<LabContract['liveRun']>): string {
  const id = run.runId || 'run';
  return `${id} ${run.side} in progress · case ${run.caseIndex} of ${run.caseTotal}`;
}

export const CANCEL_RUN_NOTE =
  'Cancel records the request on this tab. The in-flight serving call is not aborted. Partial results already saved stay saved.';

export const RETRY_FAILED_NOTE = 'Retry failed cases starts a new partial suite on those case ids. It does not rewrite the finished run.';

export interface EvidencePack {
  datasetVersionId: string;
  configurationSnapshotId: string;
  metrics: LaneMetrics;
  failedCases: string[];
  traceLinks: { caseId: string; href: string }[];
  reviewerStatus: string;
}

export function evidencePack(input: EvidencePack): EvidencePack {
  return input;
}

export function mlflowTraceHref(traceId: string): string {
  const id = traceId.trim();
  return id ? `/runs?trace=${encodeURIComponent(id)}` : '';
}

export interface HeldOutScorerRow {
  id: string;
  label: string;
  tuning: string;
  heldOut: string;
  status: HeldOutStatus;
  applicable: boolean;
  casesAndTracesHref: string;
}

export function heldOutStatusFor(score: ScorecardValue | null, judgedUnreviewed: boolean): HeldOutStatus {
  if (!score) return 'not_evaluated';
  if (score.state === 'errored') return 'errored';
  if (score.state === 'unimplementable') return 'skipped';
  if (score.state === 'not-applicable') return 'skipped';
  if (score.state === 'scored' && judgedUnreviewed) return 'provisional';
  if (score.state === 'scored') return 'evaluated';
  return 'not_evaluated';
}

export function formatHeldOutCell(score: ScorecardValue | null): string {
  if (!score || score.state !== 'scored' || score.value == null) return '-';
  const applied = score.scored;
  const total = score.scored + score.notApplicable + score.errored;
  return `${formatLabNumber(score.value, 'rate')} · ${applied}/${total}`;
}

/** Tuning cells from a live agent run's per-case scores, never invented zeroes. */
export function tuningCellsFromCaseScores(
  cases: { caseId?: string | null; scores?: ScorecardValue[] | null }[],
  tuningIds: ReadonlySet<string>
): Record<string, string> {
  const byScorer = new Map<string, ScorecardValue[]>();
  for (const row of cases) {
    const id = row.caseId?.trim();
    if (!id || !tuningIds.has(id) || !row.scores) continue;
    for (const score of row.scores) {
      const list = byScorer.get(score.scorerId) ?? [];
      list.push(score);
      byScorer.set(score.scorerId, list);
    }
  }
  const cells: Record<string, string> = {};
  for (const [scorerId, list] of byScorer) {
    const scored = list.filter((entry) => entry.state === 'scored' && entry.value != null);
    if (scored.length === 0) continue;
    const value = scored.reduce((sum, entry) => sum + (entry.value ?? 0), 0) / scored.length;
    cells[scorerId] = formatHeldOutCell({
      scorerId,
      state: 'scored',
      value,
      scored: scored.length,
      notApplicable: list.filter((entry) => entry.state === 'not-applicable').length,
      errored: list.filter((entry) => entry.state === 'errored').length,
      reason: '',
    });
  }
  return cells;
}

export function heldOutScorerRows(input: {
  scorecard: Scorecard | null;
  labelsReviewed: boolean;
  catalog?: readonly ScorerDefinition[];
  hideNonApplicable?: boolean;
  tuningById?: Record<string, string>;
}): { rows: HeldOutScorerRow[]; hiddenNonApplicable: number } {
  const catalog = input.catalog ?? SCORER_CATALOG;
  const byId = new Map((input.scorecard?.aggregates ?? []).map((entry) => [entry.scorerId, entry]));
  const hide = input.hideNonApplicable !== false;
  const rows: HeldOutScorerRow[] = [];
  let hiddenNonApplicable = 0;
  for (const definition of catalog) {
    const score = byId.get(definition.id) ?? null;
    const applicable = definition.availability === 'reported' && score?.state !== 'not-applicable' && score?.state !== 'unimplementable';
    if (hide && !applicable) {
      hiddenNonApplicable += 1;
      continue;
    }
    const judgedUnreviewed = definition.kind === 'judged' && !input.labelsReviewed && score?.state === 'scored';
    rows.push({
      id: definition.id,
      label: definition.label,
      tuning: input.tuningById?.[definition.id] ?? '-',
      heldOut: applicable ? formatHeldOutCell(score) : '-',
      status: applicable ? heldOutStatusFor(score, judgedUnreviewed) : 'skipped',
      applicable,
      casesAndTracesHref: `/benchmarking?scorer=${encodeURIComponent(definition.id)}#lab-evaluation-set`,
    });
  }
  return { rows, hiddenNonApplicable };
}

export function passGatesStripLine(gates: PassGates): string {
  const named: string[] = [];
  if (gates.genieAccuracy.minimum != null) {
    named.push(`${gates.genieAccuracy.label} ${formatLabNumber(gates.genieAccuracy.minimum, 'percent')}`);
  }
  if (gates.groundedness.minimum != null) {
    named.push(`${gates.groundedness.label} ${formatLabNumber(gates.groundedness.minimum, 'percent')}`);
  }
  if (named.length === 0) return 'No numeric thresholds set. Regressions are always shown.';
  return `${named.join(' · ')}. Regressions are always shown.`;
}

export interface PocContractView {
  goal: string;
  dataset: string;
  baseline: string;
  candidate: string;
  passGates: string;
  scorerSet: string;
  target: string;
  snapshotHref: string;
  snapshotDetail: string;
  heldOutLocked: boolean;
}

export function pocContractView(input: {
  counts: LabDatasetCounts;
  versionId: string;
  contract: LabContract;
  scorerSet: { version: string; activeCount: number; nonApplicableCount: number; line?: string };
}): PocContractView {
  const version = input.versionId || 'working copy';
  const targetKind =
    input.contract.target.kind === 'prompt_registry'
      ? 'Prompt Registry'
      : input.contract.target.kind === 'genie_space'
        ? 'Genie space'
        : 'RAG config';
  const identifier = input.contract.target.identifier.trim() || 'not set';
  const snapshotId =
    input.contract.target.snapshotId.trim() ||
    input.contract.candidateRunId.trim() ||
    input.contract.baselineRunId.trim();
  const scorerLine =
    input.scorerSet.line ||
    `${input.scorerSet.version} · ${input.scorerSet.activeCount} active · ${input.scorerSet.nonApplicableCount} not applicable`;
  return {
    goal: input.contract.goalLanes.join(' · '),
    dataset: `${version} · ${input.counts.cases} cases · ${input.counts.heldOut} held out`,
    baseline: input.contract.baselineRunId || '-',
    candidate: input.contract.candidateRunId || '-',
    passGates: passGatesStripLine(input.contract.gates),
    scorerSet: scorerLine,
    target: `${targetKind} · ${identifier}`,
    snapshotHref: configurationSnapshotHref(snapshotId),
    snapshotDetail: snapshotId
      ? `${snapshotId} · ${version} · ${input.counts.cases} cases · ${scorerLine} · baseline ${input.contract.baselineRunId || 'not set'} · candidate ${input.contract.candidateRunId || 'not set'}`
      : '',
    heldOutLocked: input.counts.heldOut > 0,
  };
}

export function applyPreviewLine(input: {
  candidateRunId: string;
  datasetVersionId: string;
  target: ApplyTarget;
}): string {
  const candidate = input.candidateRunId.trim() || 'not set';
  const version = input.datasetVersionId.trim() || 'working copy';
  let artifacts = 'changed artifacts land once a target is named';
  if (input.target.kind === 'prompt_registry') {
    const name = input.target.identifier.trim();
    artifacts = name ? `prompts:/${name}@${LAB_PRODUCTION_ALIAS}` : 'Prompt Registry name not set';
  } else if (input.target.kind === 'genie_space') {
    artifacts = 'Genie space instructions (handoff, not written here)';
  } else {
    artifacts = 'RAG config (not configured)';
  }
  return `Candidate ${candidate} · dataset ${version} · ${artifacts}`;
}

export const STAGE_04_CAPTIONS: Record<ApplyTargetKind, string> = {
  prompt_registry: `Prompt Registry moves the ${LAB_PRODUCTION_ALIAS} alias after approval.`,
  genie_space: 'Genie space opens the instruction workflow. This app does not write space instructions.',
  rag_config: 'Not configured for this target.',
};

export function mergeLabRowExtras<T extends EvalLabRowExtras>(current: T, incoming: T): T {
  const merged = { ...incoming } as EvalLabRowExtras;
  const extra = merged as Record<string, unknown>;
  const prior = current as Record<string, unknown>;
  const next = incoming as Record<string, unknown>;
  for (const key of LAB_ROW_EXTRA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(next, key) || next[key] === undefined) {
      if (Object.prototype.hasOwnProperty.call(prior, key) && prior[key] !== undefined) {
        extra[key] = prior[key];
      }
    }
  }
  return merged as T;
}

export interface LabVersionSummary {
  id: string;
  parentId: string;
  createdAt: string;
  createdBy: string;
  caseCount: number;
  heldOutCount: number;
}

export interface LabWorkspace {
  cases: LabCase[];
  counts: LabDatasetCounts;
  headerLine: string;
  laneLine: string;
  stage01Fact: string;
  reviewerQueue: string;
  matchingPolicy: { id: typeof MATCHING_POLICY_ID; fact: string; reference: string };
  geniePlan: {
    kind: SuiteKind;
    selectedIds: string[];
    sqlReadyIds: string[];
    missingSqlIds: string[];
    canRunComplete: boolean;
    gateCopy: string | null;
  };
  versions: LabVersionSummary[];
  currentVersionId: string;
  contract: LabContract;
  contractView: PocContractView;
  applyCaptions: typeof STAGE_04_CAPTIONS;
  heldOutAudit: HeldOutAuditEntry[];
  knownFailures: KnownFailure[];
  alignPreview: AlignPreview | null;
  applyHistory: ApplyRecord[];
  permalink: string;
  cancelNote: string;
  retryNote: string;
  thisRunNeeds: typeof THIS_RUN_NEEDS;
  governanceFact: string;
  importFilters: { id: ImportFilter; label: string }[];
  heldOutLockFact: string;
  partialResultsFact: string;
}

export function labWorkspacePayload(input: {
  rows: readonly EvalRowLike[];
  state: LabState;
  enabledJudges: readonly string[];
  extraJudges?: number;
}): LabWorkspace {
  const cases = input.rows.map(labCaseFromRow);
  const counts = labDatasetCounts(cases);
  const plan = genieSuitePlan(cases);
  const scorerSet = scorerSetSummary({
    version: input.state.contract.scorerSetVersion,
    enabledJudges: input.enabledJudges,
    extraJudges: input.extraJudges,
  });
  return {
    cases,
    counts,
    headerLine: datasetHeaderLine(counts),
    laneLine: laneReadinessLine(counts),
    stage01Fact: stage01Fact(counts),
    reviewerQueue: reviewerQueueChip(counts),
    matchingPolicy: { id: MATCHING_POLICY_ID, fact: MATCHING_POLICY_FACT, reference: MATCHING_POLICY_REFERENCE },
    geniePlan: {
      kind: plan.kind,
      selectedIds: plan.selected.map((row) => row.id),
      sqlReadyIds: plan.sqlReady.map((row) => row.id),
      missingSqlIds: plan.missingSql.map((row) => row.id),
      canRunComplete: plan.canRunComplete,
      gateCopy: plan.gateCopy,
    },
    versions: input.state.versions.map((entry) => ({
      id: entry.id,
      parentId: entry.parentId,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      caseCount: entry.caseCount,
      heldOutCount: entry.heldOutCount,
    })),
    currentVersionId: input.state.currentVersionId,
    contract: input.state.contract,
    contractView: pocContractView({
      counts,
      versionId: input.state.currentVersionId,
      contract: input.state.contract,
      scorerSet,
    }),
    applyCaptions: STAGE_04_CAPTIONS,
    heldOutAudit: input.state.heldOutAudit,
    knownFailures: input.state.knownFailures,
    alignPreview: input.state.alignPreview,
    applyHistory: input.state.applyHistory,
    permalink: runPermalink({
      datasetVersionId: input.state.currentVersionId,
      baselineRunId: input.state.contract.baselineRunId,
      candidateRunId: input.state.contract.candidateRunId,
    }),
    cancelNote: CANCEL_RUN_NOTE,
    retryNote: RETRY_FAILED_NOTE,
    thisRunNeeds: THIS_RUN_NEEDS,
    governanceFact: GOVERNANCE_FACT,
    importFilters: IMPORT_FILTERS.map((id) => ({ id, label: IMPORT_FILTER_LABELS[id] })),
    heldOutLockFact: HELD_OUT_LOCK_FACT,
    partialResultsFact: PARTIAL_RESULTS_FACT,
  };
}

