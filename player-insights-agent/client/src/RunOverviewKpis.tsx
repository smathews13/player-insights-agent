import { Link } from 'react-router';
import type { ReactNode } from 'react';

import type { TraceStage, TraceSummary } from './answer-shape';
import { agentToolCallSubtitle } from './run-overview-kpis';
import { RunRatingBadge } from './RunRatingBadge';
import { runFeedbackDirection } from './run-rating';
import { formatMs } from './trace-timeline';
import { Card, CardContent } from './ui';
import type { TokenReconciliation } from '../../shared/llm-token-usage';
import { runTokenUsageView } from './token-usage-view';

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
  feedback,
  legacyUsefulness,
  ratePath,
  tokenReconciliation,
  compact = false,
}: {
  durationMs: number | null | undefined;
  toolStageMs: number | null;
  agentToolCalls: number | null;
  stages: readonly TraceStage[];
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  feedback: 'up' | 'down' | null | undefined;
  legacyUsefulness?: number | null;
  ratePath: string | null;
  tokenReconciliation?: TokenReconciliation;
  /** Uses the same measurements in the denser AnswerCard process disclosure. */
  compact?: boolean;
}) {
  const hasDuration = measured(durationMs);
  const hasToolStageTime = measured(toolStageMs);
  const hasToolCalls = measured(agentToolCalls);
  const tokenView = runTokenUsageView({
    id: '',
    totalMs: 0,
    toolCalls: 0,
    stages: [...stages],
    total_tokens: totalTokens ?? undefined,
    prompt_tokens: promptTokens ?? undefined,
    completion_tokens: completionTokens ?? undefined,
    token_reconciliation: tokenReconciliation,
  } satisfies TraceSummary);
  const hasTokens = measured(tokenView.totalTokens);
  const hasTokenSplit = measured(tokenView.inputTokens) && measured(tokenView.outputTokens);
  const cacheSummary =
    tokenView.cachedReadTokens !== undefined
      ? `${tokenView.cachedReadTokens.toLocaleString()} cached${
          tokenView.cacheHitPercent !== undefined ? ` (${tokenView.cacheHitPercent.toFixed(1)}% of covered input)` : ''
        }`
      : '';
  const direction = runFeedbackDirection(feedback, legacyUsefulness);
  const hasFeedback = direction !== 'none';

  return (
    <div className={`summary-grid run-kpi-grid${compact ? ' run-kpi-grid--compact' : ''}`}>
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
        value={hasTokens ? tokenView.totalTokens!.toLocaleString() : ABSENT}
        subtitle={
          hasTokens && hasTokenSplit
            ? `${tokenView.inputTokens!.toLocaleString()} in / ${tokenView.outputTokens!.toLocaleString()} out${
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
            <RunRatingBadge feedback={feedback} legacyUsefulness={legacyUsefulness} showNoFeedback display="kpi" />
          </div>
          <small className="run-kpi-subtitle">
            {hasFeedback ? 'Submitted by the asker' : 'No feedback'}
            {ratePath && !hasFeedback ? (
              <>
                {' · '}
                <Link className="tile-link" to={ratePath}>
                  Give feedback
                </Link>
              </>
            ) : null}
          </small>
        </CardContent>
      </Card>
    </div>
  );
}
