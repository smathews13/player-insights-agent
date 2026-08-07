import type { TraceStage } from './answer-shape';

/**
 * The wait, counted rather than mimed.
 */
export function askElapsedLabel(startedAt: number | null, now: number) {
  if (!startedAt) return 'Working…';
  const elapsed = Math.floor((now - startedAt) / 1000);
  if (elapsed < 2) return 'Working…';
  if (elapsed < 20) return `Working… ${elapsed}s`;
  // Past twenty seconds a reader starts wondering whether it is stuck, so say
  // plainly that it is not. Questions here legitimately run this long.
  return `Working… ${elapsed}s, still going, complex questions take a while`;
}

/**
 * The longest stage in a run, read off the run.
 */
export function slowestStageName(stages: TraceStage[]) {
  if (stages.length === 0) return null;
  return stages.reduce((slowest, stage) => (stage.duration > slowest.duration ? stage : slowest)).name;
}
