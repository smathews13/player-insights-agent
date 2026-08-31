/**
 * Benchmark Lab v3 chrome: the six surfaces a screenshot of this tab must match.
 *
 * Layout, type, glass, the numbered spine, and in-tab jumps live here. Dataset
 * rows, Genie scores, judge runs, and apply/promote are sibling slots. Empty
 * regions keep the spec's section names and column headers, and they do not
 * invent counts or scores.
 */
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { astPill } from './astrolabe-pill';
import { Lock } from 'lucide-react';
import {
  GOVERNANCE_FACT,
  MATCHING_POLICY_REFERENCE,
  SPAN_KINDS,
  THIS_RUN_NEEDS,
  type ApplyTargetKind,
  type LabWorkspace,
  type PocContractView,
} from '../../shared/benchmark-lab-v3';

export function GenieStatTiles({
  accuracy,
  executionErrors,
  suiteDuration,
  excluded,
  policyAnchor = false,
}: {
  accuracy: string;
  executionErrors: string;
  suiteDuration: string;
  excluded: string;
  policyAnchor?: boolean;
}) {
  const tiles = [
    { label: 'Accuracy', value: accuracy },
    { label: 'Execution errors', value: executionErrors },
    { label: 'Suite duration', value: suiteDuration },
    { label: 'Excluded', value: excluded },
  ];
  return (
    <div className="bench-stat-strip" id={policyAnchor ? 'lab-matching-policy' : undefined}>
      {tiles.map((tile) => (
        <div key={tile.label}>
          <span className="ast-eyebrow">{tile.label}</span>
          <strong className={`ast-num${tile.value === 'Not recorded' ? ' tile-absent' : ''}`}>{tile.value}</strong>
        </div>
      ))}
    </div>
  );
}

export type LabContractCell = {
  eyebrow: string;
  value: string;
  detail?: string;
  extra?: ReactNode;
};

export type LabChromeSlots = {
  evaluationSet?: ReactNode;
  genieDiagnostics?: ReactNode;
  runComparison?: ReactNode;
  failureInvestigation?: ReactNode;
  heldOut?: ReactNode;
  stageCurate?: ReactNode;
  stageGenie?: ReactNode;
  stageJudges?: ReactNode;
  stageApply?: ReactNode;
};

export function labContractCells(input: {
  datasetValue?: string;
  datasetDetail?: string;
  baselineId?: string | null;
  candidateId?: string | null;
  scorerActive?: number;
  scorerDetail?: string;
  targetValue?: string;
  targetDetail?: string;
  snapshotHref?: string;
  heldOutLocked?: boolean;
}): LabContractCell[] {
  const baseline = input.baselineId?.trim() || '-';
  const candidate = input.candidateId?.trim() || '-';
  return [
    {
      eyebrow: 'Goal',
      value: 'Genie accuracy + agent judges',
    },
    {
      eyebrow: 'Dataset',
      value: input.datasetValue?.trim() || 'No dataset version yet',
      extra: input.heldOutLocked ? <Lock className="bench-lock" aria-hidden="true" /> : null,
    },
    {
      eyebrow: 'Baseline / candidate',
      value: `${baseline} / ${candidate}`,
    },
    {
      eyebrow: 'Pass gates',
      value: 'No numeric thresholds set. Regressions are always shown.',
    },
    {
      eyebrow: 'Scorer set',
      value: typeof input.scorerActive === 'number' ? `${input.scorerActive} active` : 'No scorer set yet',
    },
    {
      eyebrow: 'Target',
      value: input.targetValue?.trim() || 'No target selected',
      extra: (
        <a className="bench-text-link" href={input.snapshotHref || '#lab-snapshot'}>
          Configuration snapshot
        </a>
      ),
    },
  ];
}

/** Map the types sibling's contract view onto the six strip cells. */
export function cellsFromPocContract(view: PocContractView): LabContractCell[] {
  return [
    { eyebrow: 'Goal', value: view.goal },
    {
      eyebrow: 'Dataset',
      value: view.dataset,
      extra: view.heldOutLocked ? <Lock className="bench-lock" aria-hidden="true" /> : null,
    },
    {
      eyebrow: 'Baseline / candidate',
      value: `${view.baseline} / ${view.candidate}`,
    },
    { eyebrow: 'Pass gates', value: view.passGates },
    { eyebrow: 'Scorer set', value: view.scorerSet },
    {
      eyebrow: 'Target',
      value: view.target,
      extra: (
        <a className="bench-text-link" href={view.snapshotHref || '#lab-snapshot'}>
          Configuration snapshot
        </a>
      ),
    },
  ];
}

export function BenchButton({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  return (
    <button type="button" className={`bench-btn bench-btn-${variant}${className ? ` ${className}` : ''}`} {...props} />
  );
}

const UNWIRED_TITLE = 'This control runs once the Lab workspace is connected.';

function UnwiredButton({
  children,
  variant = 'secondary',
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <BenchButton variant={variant} disabled title={UNWIRED_TITLE}>
      {children}
    </BenchButton>
  );
}

export function LabSurface({
  id,
  title,
  fact,
  actions,
  children,
}: {
  id: string;
  title: string;
  fact?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bench-surface" id={id} aria-labelledby={`${id}-title`}>
      <header className="bench-region-head">
        <div className="bench-region-titles">
          <h3 className="bench-region-title" id={`${id}-title`}>
            {title}
          </h3>
          {fact ? <p className="bench-region-fact">{fact}</p> : null}
        </div>
        {actions ? <div className="bench-region-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

function PocContractStrip({ cells }: { cells: LabContractCell[] }) {
  return (
    <div className="bench-contract" aria-label="POC contract">
      {cells.map((cell) => (
        <div className="bench-contract-cell" key={cell.eyebrow}>
          <span className="ast-eyebrow">{cell.eyebrow}</span>
          <strong className="ast-num bench-contract-value">{cell.value}</strong>
          {cell.detail ? <small>{cell.detail}</small> : null}
          {cell.extra}
        </div>
      ))}
    </div>
  );
}

function PipelineStage({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <article className="bench-stage">
      <span className="bench-stage-node ast-num" aria-hidden="true">
        {n}
      </span>
      <div className="bench-stage-body">
        <header className="bench-stage-head">
          <h4 className="bench-stage-title">{title}</h4>
        </header>
        {children}
      </div>
    </article>
  );
}

function DefaultCurateStage({ workspace }: { workspace?: LabWorkspace | null }) {
  return (
    <>
      <p className="bench-stage-counts ast-num">{workspace ? workspace.stage01Fact : 'No cases yet'}</p>
      {workspace ? (
        <span className={astPill('neutral-outline', 'bench-chip ast-num')}>{workspace.reviewerQueue}</span>
      ) : null}
      <div className="bench-btn-row">
        <UnwiredButton variant="primary">Import from Ask and Monitoring traces</UnwiredButton>
        <UnwiredButton>New dataset version</UnwiredButton>
        <UnwiredButton>Assign tuning / held-out split</UnwiredButton>
        <UnwiredButton>Open reviewer queue</UnwiredButton>
        <UnwiredButton>Duplicate as edge case</UnwiredButton>
      </div>
    </>
  );
}

function DefaultGenieStage({ workspace }: { workspace?: LabWorkspace | null }) {
  return (
    <>
      <div className="bench-btn-row">
        <select className="eval-space-select bench-space-select" aria-label="Genie space" defaultValue="">
          <option value="" disabled>
            Pick a Genie space
          </option>
        </select>
        <UnwiredButton variant="primary">Run complete suite</UnwiredButton>
        <UnwiredButton>Run partial suite</UnwiredButton>
      </div>
      {workspace?.geniePlan.gateCopy ? <p className="bench-gate">{workspace.geniePlan.gateCopy}</p> : null}
    </>
  );
}

function DefaultJudgesStage({
  judges,
  runProgress,
  running,
  onRunBaseline,
  onRunCandidate,
  onCancel,
}: {
  judges: readonly string[];
  runProgress: string | null;
  running: boolean;
  onRunBaseline?: () => void;
  onRunCandidate?: () => void;
  onCancel?: () => void;
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
          disabled={running || !onRunBaseline}
          title={!onRunBaseline ? UNWIRED_TITLE : undefined}
        >
          {running ? 'Run in progress' : 'Run baseline'}
        </BenchButton>
        <BenchButton
          onClick={onRunCandidate}
          disabled={running || !onRunCandidate}
          title={!onRunCandidate ? UNWIRED_TITLE : undefined}
        >
          {running ? 'Run in progress' : 'Run candidate'}
        </BenchButton>
        <UnwiredButton>Score one Ask session</UnwiredButton>
      </div>
      <div className="bench-btn-row">
        {runProgress ? <p className="bench-run-progress ast-num">{runProgress}</p> : null}
        <BenchButton
          disabled={!running || !onCancel}
          onClick={onCancel}
          title={!running ? 'Nothing is running to cancel.' : undefined}
        >
          Cancel
        </BenchButton>
        <UnwiredButton>Retry failed cases</UnwiredButton>
      </div>
    </>
  );
}

function DefaultApplyStage() {
  const [target, setTarget] = useState<ApplyTargetKind>('prompt_registry');
  return (
    <>
      <div className="bench-btn-row">
        <span className="bench-inline-label">Target</span>
        <div className="bench-target-seg" role="group" aria-label="Apply target">
          <button
            type="button"
            className={target === 'prompt_registry' ? 'is-pressed' : undefined}
            aria-pressed={target === 'prompt_registry'}
            onClick={() => setTarget('prompt_registry')}
          >
            Prompt Registry
          </button>
          <button
            type="button"
            className={target === 'genie_space' ? 'is-pressed' : undefined}
            aria-pressed={target === 'genie_space'}
            onClick={() => setTarget('genie_space')}
          >
            Genie space
          </button>
          <button
            type="button"
            className={target === 'rag_config' ? 'is-pressed' : undefined}
            aria-pressed={target === 'rag_config'}
            onClick={() => setTarget('rag_config')}
          >
            RAG config
          </button>
        </div>
        <span className={astPill('neutral-outline', 'bench-chip ast-num')}>No gate status yet</span>
      </div>
      <div className="bench-btn-row">
        <input className="bench-approver ast-num" aria-label="Named approver" placeholder="Named approver" />
        <UnwiredButton variant="primary">Apply candidate</UnwiredButton>
        <UnwiredButton>View rollback path</UnwiredButton>
      </div>
    </>
  );
}

function DefaultEvaluationSet() {
  return (
    <LabSurface
      id="lab-evaluation-set"
      title="Evaluation set"
      actions={
        <div className="bench-btn-row">
          <UnwiredButton variant="primary">Import from traces</UnwiredButton>
          <UnwiredButton>New dataset version</UnwiredButton>
          <UnwiredButton>Reviewer queue</UnwiredButton>
          <UnwiredButton>Align guidelines from labels</UnwiredButton>
        </div>
      }
    >
      <p className="bench-count-line ast-num">No cases yet</p>
      <table className="bench-sheet">
        <thead>
          <tr>
            <th>Case</th>
            <th>Question or conversation</th>
            <th>Tag</th>
            <th>SQL</th>
            <th>Facts</th>
            <th>Split</th>
            <th>Review</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="bench-empty-row" colSpan={8}>
              No cases yet
            </td>
          </tr>
        </tbody>
      </table>
    </LabSurface>
  );
}

function DefaultGenieDiagnostics() {
  return (
    <LabSurface
      id="lab-genie-accuracy"
      title="Genie accuracy diagnostics"
      actions={
        <a className="bench-text-link" href={MATCHING_POLICY_REFERENCE}>
          Matching policy reference
        </a>
      }
    >
      <GenieStatTiles
        accuracy="Not recorded"
        executionErrors="Not recorded"
        suiteDuration="Not recorded"
        excluded="Not recorded"
        policyAnchor
      />
    </LabSurface>
  );
}

function DefaultRunComparison({ extras }: { extras?: ReactNode }) {
  const lanes: { id: string; label: string; metrics: string[] }[] = [
    {
      id: 'genie',
      label: 'Genie lane',
      metrics: ['Accuracy', 'Cases passed', 'Execution errors', 'Suite duration'],
    },
    {
      id: 'agent',
      label: 'Agent lane',
      metrics: ['Groundedness', 'Relevance', 'Guidelines', 'Judge coverage'],
    },
    {
      id: 'trace',
      label: 'Trace lane',
      metrics: ['p50 latency', 'Tokens', 'Est. cost', 'Tool-error rate'],
    },
  ];
  return (
    <LabSurface
      id="lab-run-comparison"
      title="Run comparison"
      actions={
        <div className="bench-btn-row">
          <UnwiredButton>Export evidence pack</UnwiredButton>
          <UnwiredButton>Copy run permalink</UnwiredButton>
        </div>
      }
    >
      {extras}
      <div className="bench-lanes">
        {lanes.map((lane) => (
          <div className="bench-lane" key={lane.id}>
            <span className="ast-eyebrow">{lane.label}</span>
            <div className="bench-lane-metrics">
              {lane.metrics.map((metric) => (
                <div className="bench-metric" key={metric}>
                  <span>{metric}</span>
                  <strong className="ast-num tile-absent">Not recorded</strong>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </LabSurface>
  );
}

function DefaultFailureInvestigation({ cases }: { cases: { id: string; question: string; outcome: string }[] }) {
  return (
    <LabSurface
      id="lab-failure"
      title="Failure investigation"
      actions={<span className="bench-governance">{GOVERNANCE_FACT}</span>}
    >
      <div className="bench-failure">
        <aside className="bench-failure-list" aria-label="Cases">
          {cases.length === 0 ? (
            <p className="bench-empty-row">No failed cases in this run.</p>
          ) : (
            <ul>
              {cases.map((row) => (
                <li key={row.id}>
                  <span className="ast-num">{row.id}</span>
                  <span>{row.question}</span>
                  <span className={astPill('neutral-outline', 'bench-chip')}>{row.outcome}</span>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div className="bench-failure-pane">
          <div className="bench-span-legend">
            {SPAN_KINDS.map((kind) => (
              <span className="bench-type-tag" key={kind}>
                {kind}
              </span>
            ))}
          </div>
          <div className="bench-btn-row">
            <UnwiredButton variant="primary">Add to dataset as edge case</UnwiredButton>
            <UnwiredButton>Mark as known failure</UnwiredButton>
          </div>
        </div>
      </div>
    </LabSurface>
  );
}

function DefaultHeldOut() {
  return (
    <LabSurface id="lab-held-out" title="Held-out evaluation">
      <table className="bench-sheet">
        <thead>
          <tr>
            <th>Scorer</th>
            <th>Tuning</th>
            <th>Held-out</th>
            <th>Status</th>
            <th> </th>
          </tr>
        </thead>
        <tbody />
      </table>
    </LabSurface>
  );
}

export function BenchmarkLabChrome({
  contract,
  judges,
  runProgress = null,
  running = false,
  onRunBaseline,
  onRunCandidate,
  onCancel,
  notices,
  comparisonExtras,
  failureCases = [],
  workspace = null,
  slots = {},
}: {
  contract: LabContractCell[];
  judges: readonly string[];
  runProgress?: string | null;
  running?: boolean;
  onRunBaseline?: () => void;
  onRunCandidate?: () => void;
  onCancel?: () => void;
  notices?: ReactNode;
  comparisonExtras?: ReactNode;
  failureCases?: { id: string; question: string; outcome: string }[];
  workspace?: LabWorkspace | null;
  slots?: LabChromeSlots;
}) {
  return (
    <>
      <div className="page-heading bench-heading">
        <div>
          <h2>Benchmark Lab</h2>
        </div>
        <nav className="bench-jump" aria-label="On this tab">
          <a href="#lab-evaluation-set">Dataset, diagnostics, comparison, and traces below ↓</a>
        </nav>
      </div>

      {notices}

      <section className="bench-surface" id="lab-pipeline" aria-labelledby="lab-pipeline-title">
        <h3 className="sr-only" id="lab-pipeline-title">
          Pipeline
        </h3>
        <PocContractStrip cells={contract} />
        {workspace?.contractView.snapshotDetail ? (
          <p className="bench-caption bench-snapshot ast-num" id="lab-snapshot">
            {workspace.contractView.snapshotDetail}
          </p>
        ) : (
          <span id="lab-snapshot" hidden />
        )}
        <div className="bench-pipeline">
          <PipelineStage n="01" title="Curate the evaluation set">
            {slots.stageCurate ?? <DefaultCurateStage workspace={workspace} />}
          </PipelineStage>
          <PipelineStage n="02" title="Genie accuracy">
            {slots.stageGenie ?? <DefaultGenieStage workspace={workspace} />}
          </PipelineStage>
          <PipelineStage n="03" title="Agent judges">
            {slots.stageJudges ?? (
              <DefaultJudgesStage
                judges={judges}
                runProgress={runProgress}
                running={running}
                onRunBaseline={onRunBaseline}
                onRunCandidate={onRunCandidate}
                onCancel={onCancel}
              />
            )}
          </PipelineStage>
          <PipelineStage n="04" title="Apply the candidate">
            {slots.stageApply ?? <DefaultApplyStage />}
          </PipelineStage>
        </div>
      </section>

      {slots.evaluationSet ?? <DefaultEvaluationSet />}
      {slots.genieDiagnostics ?? <DefaultGenieDiagnostics />}
      {slots.runComparison ?? <DefaultRunComparison extras={comparisonExtras} />}
      {slots.failureInvestigation ?? <DefaultFailureInvestigation cases={failureCases} />}
      {slots.heldOut ?? <DefaultHeldOut />}
    </>
  );
}
