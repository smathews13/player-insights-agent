import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { astPill } from './astrolabe-pill';
import { BenchButton, LabSurface } from './BenchmarkLabChrome';
import { EntityText } from './DataEntityLinks';
import {
  applyLabCandidate,
  cancelJudgeRun,
  duplicateLabEdgeCase,
  markLabKnownFailure,
  rememberBakeOffHistory,
  rollbackPromotedAsk,
  scoreAskSession,
} from './benchmark-lab-api';
import {
  agentSideFromTrace,
  applyDisabledReason,
  bakeOffPermalink,
  casesFromTrace,
  failedCaseIds,
  gateChip,
  genieLanePair,
  humanReviewedCaption,
  investigationCases,
  pairCaseOutcomes,
  resolvePromoteEndpoint,
  traceLaneFromMetrics,
  type BakeOffTrace,
  type FailureCase,
} from './benchmark-lab-ops';
import {
  bakeOffHistoryLine,
  compareBakeOff,
  deltaTone,
  formatDelta,
  formatLaneValue,
  gatesSummary,
  judgeNeedTags,
  liveRunProgress,
  lowerIsBetter,
  pickWinnerFromComparison,
  rollbackCaption,
  serializeEvidencePack,
  type BakeOffComparison,
  type LaneMetric,
} from '../../shared/benchmark-bakeoff';
import {
  GOVERNANCE_FACT,
  RETRY_FAILED_NOTE,
  SPAN_KINDS,
  THIS_RUN_NEEDS,
  applyPreviewLine,
  tuningCellsFromCaseScores,
  type ApplyTargetKind,
  type LabSpan,
  type LabWorkspace,
} from '../../shared/benchmark-lab-v3';
import { extraJudgesFromSettings, OPERATOR_EVAL_SUITE_ID } from '../../shared/eval-dataset';
import { EMPTY_FLYWHEEL_STATE, type FlywheelState } from '../../shared/eval-flywheel';
import type { GenieAccuracyRunView } from '../../shared/eval-genie-run';
import { compareSides, type BenchmarkSettings } from '../../shared/benchmark-settings';

export type SuiteSide = 'baseline' | 'candidate';

function displayValue(value: number | null, unit: LaneMetric['unit']): string {
  const rendered = formatLaneValue(value, unit);
  return rendered === '–' ? 'Not recorded' : rendered;
}

function LaneBlock({ title, metrics, extras }: { title: string; metrics: LaneMetric[]; extras?: ReactNode }) {
  return (
    <div className="bench-lane">
      <span className="ast-eyebrow">{title}</span>
      <div className="bench-lane-metrics">
        {metrics.map((metric) => {
          const tone = deltaTone(metric.baseline, metric.candidate, lowerIsBetter(metric));
          const missing = metric.baseline == null && metric.candidate == null;
          const deltaClass = tone === 'pos' ? 'bench-delta-pos' : tone === 'neg' ? 'bench-delta-neg' : '';
          return (
            <div className="bench-metric" key={metric.key}>
              <span>
                {metric.label}
                {metric.gate ? ' (gate)' : ''}
              </span>
              <strong className={`ast-num${missing ? ' tile-absent' : ''}`}>
                {missing
                  ? 'Not recorded'
                  : `${displayValue(metric.baseline, metric.unit)} → ${displayValue(metric.candidate, metric.unit)}`}
              </strong>
              {!missing && formatDelta(metric.baseline, metric.candidate, metric.unit) !== '–' ? (
                <small className={`ast-num ${deltaClass}`}>
                  {formatDelta(metric.baseline, metric.candidate, metric.unit)}
                </small>
              ) : null}
            </div>
          );
        })}
      </div>
      {extras}
    </div>
  );
}

export function BenchmarkJudgesStage({
  judges,
  running,
  progress,
  hasCandidate,
  threadNote,
  onRunBaseline,
  onRunCandidate,
  onScoreSession,
  onCancel,
  onRetryFailed,
}: {
  judges: readonly string[];
  needTags: { id: string; label: string }[];
  running: boolean;
  progress: string | null;
  hasCandidate: boolean;
  threadNote: string | null;
  onRunBaseline: () => void;
  onRunCandidate: () => void;
  onScoreSession: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
}) {
  const names = judges.length > 0 ? judges : ['groundedness', 'relevance', 'guidelines'];
  return (
    <>
      <div className="bench-judge-line">
        <span className="bench-inline-label">Judges</span>
        {names.map((name) => (
          <span className={astPill('info', 'bench-chip ast-num')} key={name}>
            {name}
          </span>
        ))}
      </div>
      <p className="bench-needs">
        <span className="bench-inline-label">This run needs</span>
        {THIS_RUN_NEEDS.map((need) => (
          <span className="bench-type-tag" key={need}>
            {need}
          </span>
        ))}
      </p>
      <div className="bench-btn-row">
        <BenchButton
          variant="primary"
          onClick={onRunBaseline}
          disabled={running}
          title={running ? 'A suite is already running.' : undefined}
        >
          {running ? 'Run in progress' : 'Run baseline'}
        </BenchButton>
        <BenchButton
          onClick={onRunCandidate}
          disabled={running || !hasCandidate}
          title={
            running
              ? 'A suite is already running.'
              : !hasCandidate
                ? 'Add a candidate endpoint in Settings → Experimental.'
                : undefined
          }
        >
          {running ? 'Run in progress' : 'Run candidate'}
        </BenchButton>
        <BenchButton title="Scores every turn in the last Ask conversation" onClick={onScoreSession} disabled={running}>
          Score one Ask session
        </BenchButton>
      </div>
      {!hasCandidate ? (
        <p className="bench-gate">Add a candidate endpoint in Settings → Experimental to run a bake-off.</p>
      ) : null}
      <div className="bench-btn-row">
        {progress ? <p className="bench-run-progress ast-num">{progress}</p> : null}
        <BenchButton
          onClick={onCancel}
          disabled={!running}
          title={!running ? 'Nothing is running to cancel.' : undefined}
        >
          Cancel
        </BenchButton>
        <BenchButton
          onClick={onRetryFailed}
          disabled={running}
          title={running ? 'A suite is already running.' : undefined}
        >
          Retry failed cases
        </BenchButton>
      </div>
      {threadNote ? <p className="bench-caption">{threadNote}</p> : null}
    </>
  );
}

export function BenchmarkApplyStage({
  target,
  onTarget,
  approver,
  onApprover,
  promptName,
  onPromptName,
  gateLabel,
  rollback,
  applying,
  applyNote,
  applyPreview,
  canApply,
  applyBlockedReason,
  onApply,
  onViewRollback,
  canRollback,
  rollbackDisabledReason,
  onRollback,
}: {
  target: ApplyTargetKind;
  onTarget: (next: ApplyTargetKind) => void;
  approver: string;
  onApprover: (next: string) => void;
  promptName: string;
  onPromptName: (next: string) => void;
  gateLabel: string;
  rollback: string;
  applying: boolean;
  applyNote: string | null;
  applyPreview: string;
  canApply: boolean;
  applyBlockedReason: string;
  onApply: () => void;
  onViewRollback: () => void;
  canRollback: boolean;
  rollbackDisabledReason: string;
  onRollback: () => void;
}) {
  return (
    <>
      <div className="bench-btn-row">
        <span className="bench-inline-label">Target</span>
        <div className="bench-target-seg" role="group" aria-label="Apply target">
          <button
            type="button"
            className={target === 'prompt_registry' ? 'is-pressed' : undefined}
            aria-pressed={target === 'prompt_registry'}
            onClick={() => onTarget('prompt_registry')}
          >
            Prompt Registry
          </button>
          <button
            type="button"
            className={target === 'genie_space' ? 'is-pressed' : undefined}
            aria-pressed={target === 'genie_space'}
            onClick={() => onTarget('genie_space')}
          >
            Genie space
          </button>
          <button
            type="button"
            className={target === 'rag_config' ? 'is-pressed' : undefined}
            aria-pressed={target === 'rag_config'}
            onClick={() => onTarget('rag_config')}
          >
            RAG config
          </button>
        </div>
        <span className={astPill('neutral-outline', 'bench-chip ast-num')}>{gateLabel}</span>
      </div>
      {target === 'prompt_registry' ? (
        <label className="bench-caption">
          Prompt Registry name
          <input
            className="bench-approver ast-num"
            aria-label="Prompt Registry name"
            placeholder="catalog.schema.prompt"
            value={promptName}
            onChange={(event) => onPromptName(event.target.value)}
          />
        </label>
      ) : null}
      <p className="bench-gate ast-num">{applyPreview}</p>
      <div className="bench-btn-row">
        <input
          className="bench-approver ast-num"
          aria-label="Named approver"
          placeholder="Named approver"
          value={approver}
          onChange={(event) => onApprover(event.target.value)}
        />
        <BenchButton
          variant="primary"
          onClick={onApply}
          disabled={!canApply || applying}
          title={!canApply ? applyBlockedReason || undefined : undefined}
        >
          {applying ? 'Applying…' : 'Apply candidate'}
        </BenchButton>
        <BenchButton onClick={onViewRollback} title="Shows the restore path. Does not roll anything back.">
          View rollback path
        </BenchButton>
        <BenchButton
          onClick={onRollback}
          disabled={!canRollback}
          title={!canRollback ? rollbackDisabledReason || undefined : 'Restores the previous Ask endpoint.'}
        >
          Roll back next Ask
        </BenchButton>
      </div>
      {!canApply && applyBlockedReason ? <p className="bench-gate">{applyBlockedReason}</p> : null}
      <p className="bench-gate">{rollback}</p>
      {applyNote ? <p className="bench-caption">{applyNote}</p> : null}
    </>
  );
}

export function BenchmarkBakeOffSurface({
  comparison,
  extras,
  history,
  genieNote,
  coverageNote,
  actionNote,
  onExport,
  onCopyPermalink,
  onInspect,
}: {
  comparison: BakeOffComparison;
  extras?: ReactNode;
  history: string[];
  genieNote: string | null;
  coverageNote: string | null;
  actionNote?: string | null;
  onExport: () => void;
  onCopyPermalink: () => void;
  onInspect: (caseId: string) => void;
}) {
  return (
    <LabSurface
      id="lab-run-comparison"
      title="Run comparison"
      fact={comparison.changed || undefined}
      actions={
        <div className="bench-btn-row">
          <BenchButton onClick={onExport}>Export evidence pack</BenchButton>
          <BenchButton onClick={onCopyPermalink}>Copy run permalink</BenchButton>
        </div>
      }
    >
      {extras}
      {actionNote ? <p className="bench-caption">{actionNote}</p> : null}
      <div className="bench-lanes">
        <LaneBlock
          title="Genie lane"
          metrics={comparison.genie}
          extras={genieNote ? <p className="bench-caption">{genieNote}</p> : null}
        />
        <LaneBlock
          title="Agent lane"
          metrics={comparison.agent}
          extras={coverageNote ? <p className="bench-caption">{coverageNote}</p> : null}
        />
        <LaneBlock title="Trace lane" metrics={comparison.trace} />
      </div>
      <p className="bench-footnote">
        {comparison.newlyFixed.map((entry) => (
          <button
            type="button"
            className="bench-chip-fixed ast-num"
            key={`fix-${entry.caseId}`}
            onClick={() => onInspect(entry.caseId)}
          >
            Newly fixed {entry.caseId}
          </button>
        ))}
        {comparison.newlyBroken.map((entry) => (
          <button
            type="button"
            className="bench-chip-broken ast-num"
            key={`break-${entry.caseId}`}
            onClick={() => onInspect(entry.caseId)}
          >
            Newly broken {entry.caseId}
          </button>
        ))}
        {comparison.regressionCaseId ? ` Inspect ${comparison.regressionCaseId} before applying.` : null}
      </p>
      <div className="bench-compare-history">
        <p className="ast-eyebrow">Bake-off history</p>
        {history.length === 0 ? (
          <p className="bench-caption">No bake-off history yet</p>
        ) : (
          <ul>
            {history.map((line) => (
              <li className="ast-num" key={line}>
                {line}
              </li>
            ))}
          </ul>
        )}
      </div>
    </LabSurface>
  );
}

function spanDotClass(status: LabSpan['status']): string {
  if (status === 'error') return 'bench-span-dot is-error';
  if (status === 'slow') return 'bench-span-dot is-slow';
  return 'bench-span-dot is-ok';
}

export function SpanTree({ spans }: { spans: LabSpan[] }) {
  if (spans.length === 0) {
    return <p className="bench-empty-row">No span durations recorded</p>;
  }
  return (
    <ul className="bench-span-tree">
      {spans.map((span) => (
        <li key={span.id}>
          <span className={spanDotClass(span.status)} aria-hidden="true" />
          <span className="bench-span-name">
            <EntityText text={span.name} sources={[]} />
          </span>
          <span className="bench-type-tag">{span.kind}</span>
          <span className="ast-num">
            {typeof span.durationMs === 'number' ? `${Math.round(span.durationMs)} ms` : 'duration not recorded'}
          </span>
          {span.kind === 'LLM' ? (
            <span className="ast-num">
              {typeof span.tokens === 'number' ? `${Math.round(span.tokens)} tokens` : 'Not recorded'}
              {' · '}
              {typeof span.cost === 'number' ? span.cost.toFixed(2) : 'Not recorded'}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function BenchmarkFailurePane({
  cases,
  selectedId,
  onSelect,
  note,
  onAddEdge,
  onMarkKnown,
}: {
  cases: FailureCase[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  note: string | null;
  onAddEdge: () => void;
  onMarkKnown: () => void;
}) {
  const selected = cases.find((row) => row.id === selectedId) ?? null;
  const detailTitleId = useId();
  return (
    <LabSurface
      id="lab-failure"
      title="Failure investigation"
      actions={<span className="bench-governance">{GOVERNANCE_FACT}</span>}
    >
      <div className={`bench-failure${selected ? ' is-open' : ''}`}>
        <aside className="bench-failure-list" aria-label="Cases">
          {cases.length === 0 ? (
            <p className="bench-empty-row">No failed cases in this run.</p>
          ) : (
            <ul>
              {cases.map((row) => (
                <li key={row.id} className={row.id === selected?.id ? 'is-active' : undefined}>
                  <button type="button" className="bench-failure-pick" onClick={() => onSelect(row.id)}>
                    <span className="ast-num">{row.id}</span>
                    <span>{row.question}</span>
                    <span className={astPill('neutral-outline', 'bench-chip')}>{row.outcome}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        {selected ? (
          <div className="bench-failure-drawer" role="region" aria-labelledby={detailTitleId}>
            <header className="bench-failure-head">
              <p className="bench-caption" id={detailTitleId}>
                <strong className="ast-num">Trace for {selected.id}</strong>
                {' · '}
                {selected.diagnosis}
                {selected.provisional ? (
                  <>
                    {' '}
                    <span className={astPill('warn', 'bench-chip')}>Provisional</span>
                  </>
                ) : null}
              </p>
            </header>
            <p className="bench-caption ast-num">
              Trace {selected.mlflowHref ? selected.mlflowHref.replace('/runs?trace=', '') : 'not recorded'}
              {selected.sessionId ? ` · session ${selected.sessionId}` : ''}
            </p>
            <div className="bench-span-legend">
              {SPAN_KINDS.map((kind) => (
                <span className="bench-type-tag" key={kind}>
                  {kind}
                </span>
              ))}
            </div>
            <SpanTree spans={selected.spans} />
            {selected.mlflowHref ? (
              <p className="bench-caption">
                <a className="bench-text-link" href={selected.mlflowHref}>
                  Open MLflow trace
                </a>
              </p>
            ) : (
              <p className="bench-empty-row">Open MLflow when a trace id is recorded.</p>
            )}
            {selected.rationale ? <p className="bench-caption">{selected.rationale}</p> : null}
            <div className="bench-btn-row">
              <BenchButton variant="primary" onClick={onAddEdge}>
                Add to dataset as edge case
              </BenchButton>
              <BenchButton onClick={onMarkKnown}>Mark as known failure</BenchButton>
            </div>
            {note ? <p className="bench-caption">{note}</p> : null}
          </div>
        ) : (
          <div className="bench-failure-pane">
            <div className="bench-span-legend">
              {SPAN_KINDS.map((kind) => (
                <span className="bench-type-tag" key={kind}>
                  {kind}
                </span>
              ))}
            </div>
            <div className="bench-btn-row">
              <BenchButton variant="primary" disabled>
                Add to dataset as edge case
              </BenchButton>
              <BenchButton disabled>Mark as known failure</BenchButton>
            </div>
          </div>
        )}
      </div>
    </LabSurface>
  );
}

async function fetchTrace(runId: string): Promise<BakeOffTrace | null> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/trace`);
  if (!response.ok) return null;
  const body = (await response.json()) as { runId?: string; benchmark?: BakeOffTrace['benchmark'] };
  return { runId: typeof body.runId === 'string' ? body.runId : runId, benchmark: body.benchmark ?? null };
}

// This hook and the benchmark components are kept together because they share
// the filled-surface contract above; it is not a component Fast Refresh export.
// eslint-disable-next-line react-refresh/only-export-components
export function useBenchmarkOps(input: {
  settings: BenchmarkSettings;
  currentAgentEndpoint: string;
  running: boolean;
  lastRunId: string | null;
  reloadToken: number;
  lastGenieRun?: GenieAccuracyRunView | null;
  labelsReviewed?: boolean;
  inProgress: boolean;
  attempted: number | null;
  total: number | null;
  selectedId: string | null;
  runSuite: (side: SuiteSide, caseIds?: string[]) => Promise<string[]>;
  lab: LabWorkspace | null;
  setLab: (lab: LabWorkspace) => void;
}) {
  const sides = compareSides(input.settings);
  const extras = extraJudgesFromSettings(input.settings);
  const needTags = judgeNeedTags({
    enabledJudges: input.settings.enabledJudges,
    multiTurn: input.settings.enabledMultiTurnJudges,
    customCount: extras.filter((entry) => entry.kind === 'custom').length,
  });
  const [flywheel, setFlywheel] = useState<FlywheelState>(EMPTY_FLYWHEEL_STATE);
  const [baselineTrace, setBaselineTrace] = useState<BakeOffTrace | null>(null);
  const [candidateTrace, setCandidateTrace] = useState<BakeOffTrace | null>(null);
  const [liveSide, setLiveSide] = useState<SuiteSide | null>(null);
  const [threadNote, setThreadNote] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const [failureNote, setFailureNote] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [target, setTarget] = useState<ApplyTargetKind>('prompt_registry');
  const [approver, setApprover] = useState('');
  const [promptName, setPromptName] = useState('');
  const [applying, setApplying] = useState(false);
  const [selectedFailure, setSelectedFailure] = useState<string | null>(null);
  const postedHistory = useRef('');
  const lab = input.lab;

  const loadFlywheel = useCallback(async () => {
    const response = await fetch('/api/benchmarks/flywheel');
    if (!response.ok) return EMPTY_FLYWHEEL_STATE;
    const body = (await response.json()) as { flywheel?: FlywheelState };
    return body.flywheel ?? EMPTY_FLYWHEEL_STATE;
  }, []);

  useEffect(() => {
    let active = true;
    void loadFlywheel().then((state) => {
      if (!active) return;
      setFlywheel(state);
      setPromptName((current) => current || state.promptRegistryName);
    });
    return () => {
      active = false;
    };
  }, [loadFlywheel, input.reloadToken, input.lastGenieRun?.id]);

  useEffect(() => {
    let active = true;
    const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
    const baselineId = params?.get('baseline') || lab?.contract.baselineRunId || flywheel.lastAgentRunIds[0] || '';
    const candidateId = params?.get('candidate') || lab?.contract.candidateRunId || flywheel.lastAgentRunIds[1] || '';
    void (async () => {
      const [left, right] = await Promise.all([
        baselineId ? fetchTrace(baselineId) : Promise.resolve(null),
        candidateId ? fetchTrace(candidateId) : Promise.resolve(null),
      ]);
      if (!active) return;
      setBaselineTrace(left);
      setCandidateTrace(right);
    })();
    return () => {
      active = false;
    };
  }, [flywheel.lastAgentRunIds, lab?.contract.baselineRunId, lab?.contract.candidateRunId, input.reloadToken]);

  const baselineSide = flywheel.lastAgentSides[0] || sides[0] || 'current';
  const candidateSide = flywheel.lastAgentSides[1] || sides[1] || '';
  const baseline = agentSideFromTrace(baselineSide, baselineTrace);
  const candidate = agentSideFromTrace(candidateSide || baselineSide, candidateTrace);
  const genie = genieLanePair({ lastRun: input.lastGenieRun ?? null, history: flywheel.history });
  const comparison = compareBakeOff({
    baseline,
    candidate,
    genie,
    trace: {
      baseline: traceLaneFromMetrics(baselineTrace?.benchmark ?? null),
      candidate: traceLaneFromMetrics(candidateTrace?.benchmark ?? null),
    },
    cases: pairCaseOutcomes(casesFromTrace(baselineTrace), casesFromTrace(candidateTrace)),
  });
  const gates = gatesSummary(comparison);

  useEffect(() => {
    const left = baseline.runId;
    const right = candidate.runId;
    if (!left || !right || left === right) return;
    const key = `${left}|${right}|${gates.passed}|${gates.total}`;
    if (postedHistory.current === key) return;
    postedHistory.current = key;
    const winner = pickWinnerFromComparison(comparison) ?? 'none';
    void rememberBakeOffHistory({
      at: new Date().toISOString(),
      datasetSuiteId: OPERATOR_EVAL_SUITE_ID,
      baselineRunId: left,
      candidateRunId: right,
      changed: comparison.changed,
      winner,
      gatesPassed: gates.passed,
      gatesTotal: gates.total,
      note: comparison.regressionCaseId ? `Inspect ${comparison.regressionCaseId} before applying.` : '',
    }).then(() => loadFlywheel().then(setFlywheel));
  }, [baseline.runId, candidate.runId, comparison, gates.passed, gates.total, loadFlywheel]);

  const progress = liveRunProgress({
    runId: input.lastRunId,
    side: liveSide || 'candidate',
    currentCaseIndex: typeof input.attempted === 'number' && input.attempted > 0 ? input.attempted - 1 : null,
    total: input.total,
    inProgress: input.inProgress || input.running,
  });

  const inspectCases = investigationCases(
    casesFromTrace(candidateTrace) || casesFromTrace(baselineTrace),
    flywheel.labelingSession?.sessionId || ''
  );
  const askEndpoint = resolvePromoteEndpoint(candidateSide || sides[1] || '', input.currentAgentEndpoint);
  const applyPreview = applyPreviewLine({
    candidateRunId: candidate.runId || input.lastRunId || '',
    datasetVersionId: lab?.currentVersionId || '',
    target: {
      kind: target,
      identifier: promptName,
      snapshotId: lab?.contract.target.snapshotId || '',
    },
  });
  const canRollback = Boolean(flywheel.rollback?.endpoint);
  const rollbackDisabledReason = canRollback ? '' : rollbackCaption(flywheel.rollback);
  const applyBlockedReason = applyDisabledReason({
    approver,
    target,
    gatesPassed: gates.passed,
    gatesTotal: gates.total,
    askEndpoint,
    candidateRunId: candidate.runId || input.lastRunId || '',
  });
  const canApply = !applyBlockedReason;

  const runBaseline = async () => {
    setLiveSide('baseline');
    setThreadNote(null);
    try {
      await input.runSuite('baseline');
    } catch (error) {
      setThreadNote((error as Error).message);
    } finally {
      setLiveSide(null);
    }
  };
  const runCandidate = async () => {
    setLiveSide('candidate');
    setThreadNote(null);
    try {
      await input.runSuite('candidate');
    } catch (error) {
      setThreadNote((error as Error).message);
    } finally {
      setLiveSide(null);
    }
  };
  const retryFailed = async () => {
    const ids = failedCaseIds(casesFromTrace(candidateTrace) || casesFromTrace(baselineTrace));
    if (ids.length === 0) {
      setThreadNote('No failed cases to retry on the last candidate run.');
      return;
    }
    setLiveSide(sides[1] ? 'candidate' : 'baseline');
    setThreadNote(RETRY_FAILED_NOTE);
    try {
      await input.runSuite(sides[1] ? 'candidate' : 'baseline', ids);
    } catch (error) {
      setThreadNote((error as Error).message);
    } finally {
      setLiveSide(null);
    }
  };
  const cancelRun = async () => {
    const runId = input.lastRunId || input.selectedId;
    if (!runId) {
      setThreadNote('Name a running suite before cancelling.');
      return;
    }
    try {
      const warning = await cancelJudgeRun(runId);
      setThreadNote(
        warning
          ? `Cancel requested. The current case still finishes. Partial results stay saved. ${warning}`
          : 'Cancel requested. The current case still finishes. Partial results stay saved.'
      );
    } catch (error) {
      setThreadNote((error as Error).message);
    }
  };
  const scoreSession = async () => {
    try {
      const scored = await scoreAskSession();
      setThreadNote(
        scored.conversationId
          ? `Scored ${scored.turnCount} turns in ${scored.conversationId}.`
          : `Scored ${scored.turnCount} turns in the picked session.`
      );
    } catch (error) {
      setThreadNote((error as Error).message);
    }
  };

  const applyCandidate = async () => {
    if (applyBlockedReason) {
      setApplyNote(applyBlockedReason);
      return;
    }
    setApplying(true);
    try {
      const result = await applyLabCandidate({
        approver: approver.trim(),
        candidateRunId: candidate.runId || undefined,
        agentEndpoint: target === 'prompt_registry' ? askEndpoint : undefined,
        target: {
          kind: target,
          identifier: target === 'prompt_registry' ? promptName.trim() : '',
          snapshotId: lab?.contract.target.snapshotId || '',
        },
        gates: {
          passed: gates.passed,
          total: gates.total,
          checks: comparison.gates
            .filter((gate) => gate.applicable)
            .map((gate) => ({
              id: gate.id,
              label: gate.label,
              passed: gate.passed,
              detail: gate.passed ? gate.label : `${gate.label} did not hold.`,
            })),
        },
      });
      input.setLab(result.lab);
      setApplyNote([result.note, 'Connections unchanged.'].filter(Boolean).join(' '));
      setFlywheel(await loadFlywheel());
    } catch (error) {
      setApplyNote((error as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const viewRollback = () => {
    const path = rollbackCaption(flywheel.rollback);
    setApplyNote(canRollback ? `Rollback path (inspection only, nothing was changed): ${path}` : path);
  };

  const rollbackAsk = async () => {
    if (!flywheel.rollback?.endpoint) {
      setApplyNote(rollbackCaption(flywheel.rollback));
      return;
    }
    try {
      const rolled = await rollbackPromotedAsk();
      setFlywheel(await loadFlywheel());
      setApplyNote(
        rolled.endpoint ? `Rolled back the next Ask to ${rolled.endpoint}.` : rollbackCaption(flywheel.rollback)
      );
    } catch (error) {
      setApplyNote((error as Error).message);
    }
  };

  const exportPack = () => {
    const failed = pairCaseOutcomes(casesFromTrace(baselineTrace), casesFromTrace(candidateTrace)).filter(
      (entry) => entry.candidate && entry.candidate !== 'passed'
    );
    const json = serializeEvidencePack({
      datasetSuiteId: OPERATOR_EVAL_SUITE_ID,
      datasetVersionId: lab?.currentVersionId || '',
      configurationSnapshot:
        candidateTrace?.benchmark?.configurationSnapshot ||
        baselineTrace?.benchmark?.configurationSnapshot ||
        lab?.contractView.snapshotDetail ||
        null,
      changed: comparison.changed,
      comparison,
      baseline,
      candidate,
      failedCases: failed,
      traceLinks: inspectCases.filter((row) => row.mlflowHref).map((row) => ({ caseId: row.id, href: row.mlflowHref })),
      reviewerStatus: lab?.reviewerQueue || '',
    });
    const blob = new Blob([json], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `evidence-${baseline.runId || 'baseline'}-${candidate.runId || 'candidate'}.json`;
    link.click();
    URL.revokeObjectURL(href);
    setActionNote('Downloaded the evidence pack.');
  };

  const copyPermalink = async () => {
    const path = bakeOffPermalink(baseline.runId || '', candidate.runId || '');
    const absolute = typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setActionNote(`Copied ${path}`);
    } catch (error) {
      setActionNote((error as Error).message || path);
    }
  };

  const addEdge = async () => {
    const picked = inspectCases.find((row) => row.id === selectedFailure);
    if (!picked) {
      setFailureNote('Pick a failed case first.');
      return;
    }
    try {
      const next = await duplicateLabEdgeCase(picked.id);
      input.setLab(next);
      setFailureNote(`Added ${picked.id} to the dataset as an edge case.`);
    } catch (error) {
      setFailureNote((error as Error).message);
    }
  };

  const markKnown = async () => {
    if (!selectedFailure) {
      setFailureNote('Pick a failed case first.');
      return;
    }
    try {
      const next = await markLabKnownFailure(selectedFailure);
      input.setLab(next);
      setFailureNote(`Marked ${selectedFailure} as a known failure.`);
    } catch (error) {
      setFailureNote((error as Error).message);
    }
  };

  return {
    judges: [...input.settings.enabledJudges, ...extras.map((entry) => entry.name)],
    needTags,
    hasCandidate: sides.length > 1,
    progress,
    threadNote,
    runBaseline,
    runCandidate,
    scoreSession,
    cancelRun,
    retryFailed,
    target,
    setTarget,
    approver,
    setApprover,
    promptName,
    setPromptName,
    gateLabel: gateChip(candidate.runId || input.lastRunId, gates.passed, gates.total),
    rollback: rollbackCaption(flywheel.rollback),
    applying,
    applyNote,
    applyPreview,
    canApply,
    applyBlockedReason,
    applyCandidate,
    viewRollback,
    canRollback,
    rollbackDisabledReason,
    rollbackAsk,
    comparison,
    history: flywheel.compareHistory.map((entry) => bakeOffHistoryLine(entry)),
    genieNote: genie
      ? genie.baseline.accuracy == null || genie.candidate.accuracy == null
        ? genie.candidate.note || genie.baseline.note
        : genie.baseline.note === genie.candidate.note
          ? genie.candidate.note
          : `Baseline ${genie.baseline.note}. Candidate ${genie.candidate.note}.`
      : null,
    coverageNote: humanReviewedCaption(input.labelsReviewed, candidate.coverage ?? null),
    actionNote,
    exportPack,
    copyPermalink,
    inspectCases,
    selectedFailure,
    setSelectedFailure,
    failureNote,
    addEdge,
    markKnown,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    gates,
    lab,
    tuningById: tuningCellsFromCaseScores(
      casesFromTrace(candidateTrace).length ? casesFromTrace(candidateTrace) : casesFromTrace(baselineTrace),
      new Set((lab?.cases ?? []).filter((row) => row.split === 'tuning' && !row.retired).map((row) => row.id))
    ),
  };
}
