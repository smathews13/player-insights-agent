import { Link } from 'react-router';
import type { ReactNode } from 'react';

import type { TraceStage } from './answer-shape';
import { agentToolCallSubtitle } from './run-overview-kpis';
import { RunRatingBadge } from './RunRatingBadge';
import { runRatingDirection } from './run-rating';
import { formatMs } from './trace-timeline';
import { Card, CardContent } from './ui';
import type { TokenReconciliation } from '../../shared/llm-token-usage';

const ABSENT = 'Not recorded';

function measured(value: number | null | undefined, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

function tileValue(absent: boolean): string {
  return absent ? 'run-kpi-value ast-num tile-absent' : 'run-kpi-value ast-num';
}

function KpiCard({
  label,
  value,
  subtitle,
  absent = false,
  subtitleClassName = '',
}: {
  label: string;
  value: string;
  subtitle: ReactNode;
  absent?: boolean;
  subtitleClassName?: string;
}) {
  return (
    <Card className="run-kpi-card">
      <CardContent>
        <span className="run-kpi-label">{label}</span>
        <strong className={tileValue(absent)}>{value}</strong>
        <small className={`run-kpi-subtitle ${subtitleClassName}`.trim()}>{subtitle}</small>
      </CardContent>
    </Card>
  );
}

export function RunOverviewKpis({
  durationMs,
  toolStageMs,
  agentToolCalls,
  stages,
  totalTokens,
  promptTokens,
  completionTokens,
  rating,
  ratePath,
  tokenReconciliation,
}: {
  durationMs: number | null | undefined;
  toolStageMs: number | null;
  agentToolCalls: number | null;
  stages: readonly TraceStage[];
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  rating: number | null | undefined;
  ratePath: string | null;
  tokenReconciliation?: TokenReconciliation;
}) {
  const hasDuration = measured(durationMs);
  const hasToolStageTime = measured(toolStageMs);
  const hasToolCalls = measured(agentToolCalls);
  const hasTokens = measured(totalTokens);
  const hasTokenSplit = measured(promptTokens) && measured(completionTokens);
  const stageCache = stages.reduce(
    (summary, stage) => {
      const usage = stage.token_usage;
      if (!usage || usage.cachedReadTokens === undefined) return summary;
      summary.cachedReadTokens += usage.cachedReadTokens;
      if (usage.inputTokens !== undefined) summary.coveredInputTokens += usage.inputTokens;
      summary.reported = true;
      return summary;
    },
    { cachedReadTokens: 0, coveredInputTokens: 0, reported: false }
  );
  const cachedReadTokens =
    tokenReconciliation?.cachedReadTokens ?? (stageCache.reported ? stageCache.cachedReadTokens : undefined);
  const cacheHitPercent =
    tokenReconciliation?.cacheHitPercent ??
    (stageCache.reported && stageCache.coveredInputTokens > 0
      ? (stageCache.cachedReadTokens / stageCache.coveredInputTokens) * 100
      : undefined);
  const cacheSummary =
    cachedReadTokens !== undefined
      ? `${cachedReadTokens.toLocaleString()} cached${
          cacheHitPercent !== undefined ? ` (${cacheHitPercent.toFixed(1)}% of covered input)` : ''
        }`
      : '';
  const feedbackDirection = runRatingDirection(rating);
  const hasFeedback = feedbackDirection !== 'none';

  return (
    <div className="summary-grid run-kpi-grid">
      <KpiCard
        label="Wall time"
        value={hasDuration ? formatMs(durationMs) : ABSENT}
        subtitle="Question to final answer"
        absent={!hasDuration}
      />
      <KpiCard
        label="Tool-stage time"
        value={hasToolStageTime ? `${(toolStageMs / 1000).toFixed(1)}s` : ABSENT}
        subtitle="Time spent in agent and tool stages"
        absent={!hasToolStageTime}
      />
      <KpiCard
        label="Agent tool calls"
        value={hasToolCalls ? agentToolCalls.toLocaleString() : ABSENT}
        subtitle={agentToolCallSubtitle(agentToolCalls, stages)}
        absent={!hasToolCalls}
      />
      <KpiCard
        label="LLM tokens"
        value={hasTokens ? totalTokens.toLocaleString() : ABSENT}
        subtitle={
          hasTokens && hasTokenSplit
            ? `${promptTokens.toLocaleString()} in / ${completionTokens.toLocaleString()} out${
                cacheSummary ? ` · ${cacheSummary}` : ''
              }`
            : hasTokens && cacheSummary
              ? cacheSummary
              : 'Token usage not recorded'
        }
        subtitleClassName={hasTokens && hasTokenSplit ? 'tile-mono ast-num' : ''}
        absent={!hasTokens}
      />
      <Card className="run-kpi-card run-feedback-card">
        <CardContent>
          <span className="run-kpi-label">User feedback</span>
          <div className="run-kpi-feedback">
            <RunRatingBadge rating={rating} showUnrated display="kpi" />
          </div>
          <small className="run-kpi-subtitle">
            {hasFeedback ? 'Submitted by the asker' : 'No rating submitted'}
            {ratePath && !hasFeedback ? (
              <>
                {' · '}
                <Link className="tile-link" to={ratePath}>
                  Rate this run
                </Link>
              </>
            ) : null}
          </small>
        </CardContent>
      </Card>
    </div>
  );
}
