import { z } from 'zod';
import { DEFAULT_JUDGE_ENDPOINT } from './benchmark-contract';

/**
 * Bake-off and MLflow defaults the Settings Experimental pane edits.
 *
 * ONE STORE, TWO READERS. Settings writes this; the top-nav Benchmarking page
 * reads the same row to start a run. A second form on the lab would drift.
 */

export const CURRENT_AGENT_SIDE = 'current';

export const EVAL_SET_IDS = ['poc-benchmark', 'held-out-eval'] as const;
export type EvalSetId = (typeof EVAL_SET_IDS)[number];

export const EVAL_SET_OPTIONS: readonly { id: EvalSetId; label: string; note: string }[] = [
  {
    id: 'poc-benchmark',
    label: 'POC benchmark suite',
    note: 'The six cases this demo is tuned and shown against.',
  },
  {
    id: 'held-out-eval',
    label: 'Held-out evaluation set',
    note: 'Twelve labelled cases none of which the demo is tuned against.',
  },
];

export const BenchmarkSettingsSchema = z.strictObject({
  experimentId: z.string().trim().max(80).default(''),
  alwaysOnTraces: z.boolean().default(true),
  evalSetId: z.enum(EVAL_SET_IDS).default('poc-benchmark'),
  judgeEndpoint: z.string().trim().min(1).max(200).default(DEFAULT_JUDGE_ENDPOINT),
  compareSideA: z.string().trim().max(200).default(CURRENT_AGENT_SIDE),
  compareSideB: z.string().trim().max(200).default(''),
});

export type BenchmarkSettings = z.infer<typeof BenchmarkSettingsSchema>;

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = {
  experimentId: '',
  alwaysOnTraces: true,
  evalSetId: 'poc-benchmark',
  judgeEndpoint: DEFAULT_JUDGE_ENDPOINT,
  compareSideA: CURRENT_AGENT_SIDE,
  compareSideB: '',
};

export function parseBenchmarkSettings(value: unknown): BenchmarkSettings {
  return BenchmarkSettingsSchema.parse(value);
}

/**
 * The suite id a run should send, or the canonical POC suite when the saved
 * value is empty or unknown.
 */
export function suiteIdFromSettings(settings: Pick<BenchmarkSettings, 'evalSetId'>): string {
  return settings.evalSetId || 'poc-benchmark';
}

/**
 * The two endpoints a bake-off will call, with `current` meaning the deployed
 * agent. A blank side B, or the same name twice, is a single run.
 */
export function compareSides(settings: Pick<BenchmarkSettings, 'compareSideA' | 'compareSideB'>): string[] {
  const sideA = settings.compareSideA.trim() || CURRENT_AGENT_SIDE;
  const sideB = settings.compareSideB.trim();
  if (!sideB || sideB === sideA) return [sideA];
  return [sideA, sideB];
}
