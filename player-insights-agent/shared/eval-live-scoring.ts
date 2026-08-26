import { z } from 'zod';
import { deterministicChecks, type DeterministicCheck } from './eval-flywheel';

/**
 * Always-on scoring of sampled Ask traffic.
 *
 * A sampled turn is scored without anyone pressing Run. Deterministic checks
 * run in this app. LLM judges run when a judge model can be reached. MLflow
 * GenAI monitoring is used when the workspace already has scorers registered;
 * Apps cannot register Python scorers from a notebook, so a missing workspace
 * monitor is reported rather than invented.
 */

export const DEFAULT_LIVE_SAMPLE_RATE = 0.2;
export const LIVE_SCORE_KEEP = 50;

export const LiveJudgeVerdictSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  value: z.enum(['yes', 'no']).nullable(),
  state: z.enum(['scored', 'errored', 'not-applicable', 'skipped']),
  note: z.string().trim().max(400).default(''),
});

export type LiveJudgeVerdict = z.infer<typeof LiveJudgeVerdictSchema>;

export const LiveTraceScoreSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  at: z.string().trim().min(1).max(40),
  conversationId: z.string().trim().min(1).max(80),
  messageId: z.string().trim().min(1).max(80),
  traceId: z.string().trim().max(80).default(''),
  question: z.string().trim().max(2000).default(''),
  sampled: z.boolean(),
  sampleRate: z.number().min(0).max(1),
  checks: z.array(
    z.strictObject({
      id: z.enum(['fqn-present', 'no-refused-sql', 'latency-under-budget']),
      label: z.string(),
      passed: z.boolean().nullable(),
      note: z.string(),
    })
  ),
  judges: z.array(LiveJudgeVerdictSchema).default([]),
});

export type LiveTraceScore = z.infer<typeof LiveTraceScoreSchema>;

export const WorkspaceMonitorSchema = z.strictObject({
  status: z.enum(['active', 'blocked', 'unknown']),
  note: z.string().trim().max(800),
  scorers: z.array(z.string().trim().min(1).max(80)).default([]),
});

export type WorkspaceMonitor = z.infer<typeof WorkspaceMonitorSchema>;

export function parseLiveTraceScore(value: unknown): LiveTraceScore {
  return LiveTraceScoreSchema.parse(value);
}

/**
 * Stable sample: the same Ask turn is in or out forever at a given rate.
 *
 * FNV-1a over the seed, then compare to the rate. Not a random draw, so a
 * refresh cannot quietly score a different 20%.
 */
export function shouldSampleLiveTrace(seed: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  const key = seed.trim();
  if (!key) return false;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff < rate;
}

export function liveChecksFromAnswer(input: {
  sql: string;
  note: string;
  durationMs?: number | null;
}): DeterministicCheck[] {
  return deterministicChecks(input);
}

export function liveScoreSummary(score: Pick<LiveTraceScore, 'checks' | 'judges'>): string {
  const checked = score.checks.filter((entry) => entry.passed !== null);
  const passed = checked.filter((entry) => entry.passed === true).length;
  const judged = score.judges.filter((entry) => entry.state === 'scored');
  const yes = judged.filter((entry) => entry.value === 'yes').length;
  const checks = checked.length > 0 ? `${passed}/${checked.length} checks` : 'no checks';
  const judges = judged.length > 0 ? `${yes}/${judged.length} judges` : 'no LLM judges';
  return `${checks} · ${judges}`;
}
