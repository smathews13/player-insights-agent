import { z } from 'zod';
import { BakeOffHistorySchema } from './benchmark-bakeoff';
import { accuracyScore, type AccuracyScore } from './eval-dataset';
import { LabelingSessionSchema } from './eval-review-app';

/**
 * The rest of the evaluation flywheel: compare, promote, re-run, history, and
 * misses that must not count as "Genie got the SQL wrong."
 */

/** 50s: a warehouse still starting, or a cancelled long SQL, is not a wrong answer. */
export const WAREHOUSE_BUDGET_MS = 50_000;

export const GENIE_MISS_KINDS = ['warehouse', 'timeout', 'error'] as const;
export type GenieMissKind = (typeof GENIE_MISS_KINDS)[number];

export function classifyGenieMiss(note: string): GenieMissKind {
  const text = note.toLowerCase();
  if (
    /warehouse/.test(text) &&
    /start|starting|pending|warming|not running|stopped|resuming/.test(text)
  ) {
    return 'warehouse';
  }
  if (/warehouse still starting|compute is starting|cluster is starting/.test(text)) {
    return 'warehouse';
  }
  if (/cancel|cancelled|canceled|timed out|timeout|wait ran out|50\s*s|deadline/.test(text)) {
    return 'timeout';
  }
  return 'error';
}

export function genieMissLabel(kind: GenieMissKind): string {
  if (kind === 'warehouse') return 'Warehouse still starting — not scored as Genie wrong';
  if (kind === 'timeout') return 'SQL cancelled or timed out — not scored as Genie wrong';
  return 'Could not score';
}

export function isExcludedGenieMiss(kind: GenieMissKind): boolean {
  return kind === 'warehouse' || kind === 'timeout';
}

/**
 * Accuracy over compared SQL only. Warehouse/start/timeout misses stay out of
 * both halves of the fraction.
 */
export function scoredAccuracy(passed: number, scored: number, excluded: number): AccuracyScore & { excluded: number } {
  const base = accuracyScore(passed, scored);
  if (excluded <= 0) return { ...base, excluded: 0 };
  if (base.percent === null) {
    return {
      ...base,
      excluded,
      label: `${excluded} not scored (warehouse or timeout)`,
    };
  }
  return {
    ...base,
    excluded,
    label: `${base.label} · ${excluded} not scored (warehouse or timeout)`,
  };
}

export interface AccuracySnapshot {
  at: string;
  spaceId: string;
  spaceLabel: string;
  passed: number;
  scored: number;
  excluded: number;
  percent: number | null;
  label: string;
  note: string;
}

export function historyLine(entry: AccuracySnapshot): string {
  const when = entry.at.slice(0, 10) || entry.at;
  return `${when}: ${entry.label}${entry.note ? ` — ${entry.note}` : ''}`;
}

export interface SideScore {
  side: string;
  runId: string | null;
  passed: number | null;
  total: number | null;
  groundedness: number | null;
  relevance: number | null;
  guidelines: number | null;
  extraRates?: { name: string; rate: number | null }[];
}

export function compareSidesSummary(baseline: SideScore, candidate: SideScore): string {
  const left = formatSide(baseline);
  const right = formatSide(candidate);
  return `Baseline (${baseline.side}): ${left}. Candidate (${candidate.side}): ${right}.`;
}

export function formatJudgeRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export function compareTileRates(side: SideScore): string {
  const base = `Groundedness ${formatJudgeRate(side.groundedness)} · Relevance ${formatJudgeRate(side.relevance)} · Guidelines ${formatJudgeRate(side.guidelines)}`;
  const extras = (side.extraRates ?? [])
    .map((entry) => `${entry.name} ${formatJudgeRate(entry.rate)}`)
    .join(' · ');
  return extras ? `${base} · ${extras}` : base;
}

function formatSide(side: SideScore): string {
  if (side.passed === null || side.total === null) return 'no score yet';
  return `${side.passed}/${side.total}`;
}

export function pickWinner(baseline: SideScore, candidate: SideScore): 'baseline' | 'candidate' | 'tie' | null {
  if (sideValue(baseline) === null || sideValue(candidate) === null) return null;
  const left = sideValue(baseline) as number;
  const right = sideValue(candidate) as number;
  if (right > left) return 'candidate';
  if (left > right) return 'baseline';
  return 'tie';
}

function sideValue(side: SideScore): number | null {
  if (typeof side.passed === 'number' && typeof side.total === 'number' && side.total > 0) {
    return side.passed / side.total;
  }
  return null;
}

/** Eval-only: does the statement name catalog.schema.table? Not the SQL gate. */
export function sqlHasFqn(sql: string): boolean {
  return /\b[a-zA-Z_][\w]*\.[a-zA-Z_][\w]*\.[a-zA-Z_][\w]*\b/.test(sql);
}

export function sqlLooksRefused(sql: string, note: string): boolean {
  const text = `${sql} ${note}`.toLowerCase();
  return /refused|sql refused|identity_required|restricted column|not read-only/.test(text);
}

export function latencyWithinBudget(durationMs: number | null | undefined, budgetMs: number = WAREHOUSE_BUDGET_MS): boolean | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
  return durationMs < budgetMs;
}

export interface DeterministicCheck {
  id: 'fqn-present' | 'no-refused-sql' | 'latency-under-budget';
  label: string;
  passed: boolean | null;
  note: string;
}

export function deterministicChecks(input: {
  sql: string;
  note: string;
  durationMs?: number | null;
}): DeterministicCheck[] {
  const fqn = sqlHasFqn(input.sql);
  const refused = sqlLooksRefused(input.sql, input.note);
  const latency = latencyWithinBudget(input.durationMs);
  return [
    {
      id: 'fqn-present',
      label: 'FQN present',
      passed: input.sql.trim() ? fqn : null,
      note: input.sql.trim()
        ? fqn
          ? 'Statement names catalog.schema.table.'
          : 'No catalog.schema.table name in the statement.'
        : 'No SQL to check.',
    },
    {
      id: 'no-refused-sql',
      label: 'No refused SQL',
      passed: input.sql.trim() || input.note.trim() ? !refused : null,
      note: refused ? 'This look like a refused statement, not a scored miss.' : 'No refusal marker.',
    },
    {
      id: 'latency-under-budget',
      label: 'Latency under 50s',
      passed: latency,
      note:
        latency === null
          ? 'Duration was not recorded.'
          : latency
            ? 'Finished inside the warehouse budget.'
            : 'Took 50s or more — call this a timeout, not a wrong answer.',
    },
  ];
}

export const LastSuiteSchema = z.strictObject({
  kind: z.enum(['genie', 'agent']),
  spaceId: z.string().trim().max(200).default(''),
  spaceLabel: z.string().trim().max(200).default(''),
  at: z.string().trim().max(40).default(''),
});

export type LastSuite = z.infer<typeof LastSuiteSchema>;

export const PromotedAgentSchema = z.strictObject({
  endpoint: z.string().trim().max(200).default(''),
  side: z.string().trim().max(80).default(''),
  at: z.string().trim().max(40).default(''),
  note: z.string().trim().max(400).default(''),
  approver: z.string().trim().max(200).default(''),
  targetKind: z.enum(['prompt-registry', 'genie-space', 'rag-config']).default('prompt-registry'),
  targetId: z.string().trim().max(300).default(''),
});

export type PromotedAgent = z.infer<typeof PromotedAgentSchema>;

/** The alias Ask loads. Moving it is how promote reaches the next question without a code change. */
export const PRODUCTION_PROMPT_ALIAS = 'production';

export const PromotedPromptSchema = z.strictObject({
  name: z.string().trim().max(300).default(''),
  alias: z.string().trim().max(80).default(PRODUCTION_PROMPT_ALIAS),
  version: z.string().trim().max(40).default(''),
  uri: z.string().trim().max(400).default(''),
  template: z.string().trim().max(8_000).default(''),
  status: z.enum(['moved', 'blocked', 'skipped']).default('skipped'),
  note: z.string().trim().max(800).default(''),
});

export type PromotedPrompt = z.infer<typeof PromotedPromptSchema>;

export function promptRegistryUri(name: string, alias: string = PRODUCTION_PROMPT_ALIAS): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return `prompts:/${trimmed}@${alias.trim() || PRODUCTION_PROMPT_ALIAS}`;
}

export const AccuracySnapshotSchema = z.strictObject({
  at: z.string().trim().min(1).max(40),
  spaceId: z.string().trim().max(200).default(''),
  spaceLabel: z.string().trim().max(200).default(''),
  passed: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative().default(0),
  percent: z.number().nullable(),
  label: z.string().trim().max(200),
  note: z.string().trim().max(400).default(''),
});

export const FlywheelStateSchema = z.strictObject({
  lastSuite: LastSuiteSchema.nullable().default(null),
  promoted: PromotedAgentSchema.nullable().default(null),
  rollback: PromotedAgentSchema.nullable().default(null),
  promptRegistryName: z.string().trim().max(300).default(''),
  promotedPrompt: PromotedPromptSchema.nullable().default(null),
  labelingSession: LabelingSessionSchema.nullable().default(null),
  lastAgentRunIds: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
  lastAgentSides: z.array(z.string().trim().max(200)).max(4).default([]),
  history: z.array(AccuracySnapshotSchema).max(50).default([]),
  compareHistory: z.array(BakeOffHistorySchema).max(50).default([]),
  knownFailures: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
});

export type FlywheelState = z.infer<typeof FlywheelStateSchema>;

export const EMPTY_FLYWHEEL_STATE: FlywheelState = {
  lastSuite: null,
  promoted: null,
  rollback: null,
  promptRegistryName: '',
  promotedPrompt: null,
  labelingSession: null,
  lastAgentRunIds: [],
  lastAgentSides: [],
  history: [],
  compareHistory: [],
  knownFailures: [],
};

export function parseFlywheelState(value: unknown): FlywheelState {
  return FlywheelStateSchema.parse(value ?? EMPTY_FLYWHEEL_STATE);
}

export function rememberAccuracy(history: AccuracySnapshot[], next: AccuracySnapshot): AccuracySnapshot[] {
  return [next, ...history].slice(0, 50);
}
