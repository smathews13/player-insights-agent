import type { TraceStage } from './answer-shape';

export const PLANNING_STAGE_LABEL = 'Planning out your answer';
export const WORKING_STAGE_LABEL = 'Working on your answer';

export type CurrentStageMode = 'idle' | 'planning' | 'active' | 'completed' | 'final';

/**
 * The single reader-facing account of where an Ask run is now.
 *
 * Stage events are retained for the life of the run, so observing one is also
 * the latch that prevents the UI from falling back to pre-stage planning copy.
 */
export interface CurrentStageView {
  mode: CurrentStageMode;
  label: string;
  index: number;
  stageId: string | null;
  hasStageEvidence: boolean;
}

function isPlanningPlaceholder(stage: TraceStage): boolean {
  const id = stage.id.trim().toLowerCase();
  return stage.name.trim() === PLANNING_STAGE_LABEL || id === 'planning' || id === 'orchestrator';
}

function stageStart(stage: TraceStage): number | null {
  return stage.startMeasured === false || !Number.isFinite(stage.start) ? null : stage.start;
}

function laterStageIndex(stages: readonly TraceStage[], indexes: number[], completed: boolean): number {
  return indexes.reduce((latest, index) => {
    const candidate = stages[index];
    const held = stages[latest];
    const candidateStart = stageStart(candidate);
    const heldStart = stageStart(held);
    if (candidateStart !== null && heldStart !== null) {
      const candidateAt = completed ? candidateStart + Math.max(0, candidate.duration) : candidateStart;
      const heldAt = completed ? heldStart + Math.max(0, held.duration) : heldStart;
      if (candidateAt !== heldAt) return candidateAt > heldAt ? index : latest;
    }
    const candidateDepth = candidate.depth ?? 0;
    const heldDepth = held.depth ?? 0;
    if (!completed && candidateDepth !== heldDepth) return candidateDepth > heldDepth ? index : latest;
    return index > latest ? index : latest;
  });
}

function stageView(
  stage: TraceStage,
  index: number,
  mode: 'active' | 'completed',
  missingLabel: string
): CurrentStageView {
  const label = stage.name.trim();
  return {
    mode,
    label: label && label !== PLANNING_STAGE_LABEL ? label : missingLabel,
    index,
    stageId: stage.id,
    hasStageEvidence: true,
  };
}

export function deriveCurrentStageView({
  stages,
  runActive,
  hasFinalAnswer = false,
}: {
  stages: readonly TraceStage[];
  runActive: boolean;
  hasFinalAnswer?: boolean;
}): CurrentStageView {
  const realIndexes = stages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => !isPlanningPlaceholder(stage))
    .map(({ index }) => index);
  const activeIndexes = realIndexes.filter((index) => stages[index].status === 'running');
  if (activeIndexes.length > 0) {
    const index = laterStageIndex(stages, activeIndexes, false);
    return stageView(stages[index], index, 'active', WORKING_STAGE_LABEL);
  }

  const completedIndexes = realIndexes.filter((index) => stages[index].status !== 'running');
  if (completedIndexes.length > 0) {
    const index = laterStageIndex(stages, completedIndexes, true);
    return stageView(
      stages[index],
      index,
      'completed',
      runActive ? WORKING_STAGE_LABEL : hasFinalAnswer ? 'Answer complete' : ''
    );
  }

  if (runActive) {
    return {
      mode: 'planning',
      label: PLANNING_STAGE_LABEL,
      index: -1,
      stageId: null,
      hasStageEvidence: false,
    };
  }
  if (hasFinalAnswer) {
    return {
      mode: 'final',
      label: 'Answer complete',
      index: -1,
      stageId: null,
      hasStageEvidence: false,
    };
  }
  return {
    mode: 'idle',
    label: '',
    index: -1,
    stageId: null,
    hasStageEvidence: false,
  };
}
