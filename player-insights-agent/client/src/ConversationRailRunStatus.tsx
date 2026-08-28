import type { TraceStage } from './answer-shape';
import type { ActiveConversationRun } from './active-conversation-runs';
import { isWorkingConversationRun } from './conversation-run';
import { runningStepNumber } from './live-progress';
import type { RailRunSummary } from './rail-run-summary';
import { RunStatusPill } from './RunStatusPill';
import { runStatusFor } from './run-status';

/**
 * The run badge in one conversation-rail card.
 *
 * Kept as a rendered component so a background conversation computes its badge
 * from its own ledger row and stages. Passing the selected conversation's
 * `runStatus` here was what let conversation B repaint a still-running A as
 * Complete or Failed.
 */
export function ConversationRailRunStatus({
  run,
  stages,
  streamed,
  fallback,
}: {
  run: ActiveConversationRun | null;
  stages: TraceStage[];
  streamed: boolean;
  fallback: RailRunSummary | null;
}) {
  if (streamed || isWorkingConversationRun(run?.status ?? null)) {
    return (
      <RunStatusPill
        status={runStatusFor({
          loading: true,
          liveSteps: stages.length,
          runningStep: runningStepNumber(stages),
          runStopped: false,
          awaitingApproval: false,
          asked: false,
          answered: false,
          readiness: 'unchecked',
        })}
      />
    );
  }

  const summary = run?.summary ?? fallback;
  if (!summary) return null;
  return (
    <span className={`ast-pill conversation-status ${summary.tone}`} title={`Latest turn: ${summary.status}`}>
      {summary.status}
    </span>
  );
}
