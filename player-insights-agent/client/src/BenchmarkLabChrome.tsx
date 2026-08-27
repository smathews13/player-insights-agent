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
  HELD_OUT_LOCK_FACT,
  IMPORT_FILTER_LABELS,
  MATCHING_POLICY_FACT,
  MATCHING_POLICY_REFERENCE,
  PARTIAL_RESULTS_FACT,
  SPAN_KINDS,
  STAGE_04_CAPTIONS,
  THIS_RUN_NEEDS,
  applyPreviewLine,
  type ApplyTargetKind,
  type LabWorkspace,
  type PocContractView,
} from '../../shared/benchmark-lab-v3';

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
      detail: 'two lanes, one dataset',
    },
    {
      eyebrow: 'Dataset',
      value: input.datasetValue?.trim() || 'No dataset version yet',
      detail: input.datasetDetail?.trim() || 'case count lands when the set is saved',
      extra: input.heldOutLocked ? <Lock className="bench-lock" aria-hidden="true" /> : null,
    },
    {
      eyebrow: 'Baseline / candidate',
      value: `${baseline} / ${candidate}`,
      detail: 'same cases, same scorers',
    },
    {
      eyebrow: 'Pass gates',
      value: 'No numeric thresholds set. Regressions are always shown.',
    },
    {
      eyebrow: 'Scorer set',
      value:
        typeof input.scorerActive === 'number'
          ? `${input.scorerActive} active`
          : 'No scorer set yet',
      detail: input.scorerDetail?.trim() || 'non-applicable count lands with the run',
    },
    {
      eyebrow: 'Target',
      value: input.targetValue?.trim() || 'No target selected',
      detail: input.targetDetail?.trim() || 'kind and identifier land with apply',
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
    { eyebrow: 'Goal', value: view.goal, detail: 'two lanes, one dataset' },
    {
      eyebrow: 'Dataset',
      value: view.dataset,
      extra: view.heldOutLocked ? <Lock className="bench-lock" aria-hidden="true" /> : null,
    },
    {
      eyebrow: 'Baseline / candidate',
      value: `${view.baseline} / ${view.candidate}`,
      detail: 'same cases, same scorers',
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
    <button
      type="button"
      className={`bench-btn bench-btn-${variant}${className ? ` ${className}` : ''}`}
      {...props}
    />
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
  fact: ReactNode;
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
          <p className="bench-region-fact">{fact}</p>
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

function PipelineStage({
  n,
  title,
  fact,
  children,
}: {
  n: string;
  title: string;
  fact: string;
  children: ReactNode;
}) {
  return (
    <article className="bench-stage">
      <span className="bench-stage-node ast-num" aria-hidden="true">
        {n}
      </span>
      <div className="bench-stage-body">
        <header className="bench-stage-head">
          <h4 className="bench-stage-title">{title}</h4>
          <p className="bench-stage-fact">{fact}</p>
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
      <p className="bench-caption">{UNWIRED_TITLE}</p>
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
        <span className={astPill('neutral-outline', 'bench-chip')}>matching · executed-result equivalence</span>
      </div>
      <p className="bench-gate">
        {workspace?.geniePlan.gateCopy ||
          'No SQL-complete cases yet. Fix them in 01 or run partial: the excluded cases and the denominator are shown on the result.'}
      </p>
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
      <p className="bench-gate">{PARTIAL_RESULTS_FACT}</p>
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
      <p className="bench-gate">{STAGE_04_CAPTIONS[target]}</p>
      <p className="bench-gate">Connections unchanged.</p>
      <p className="bench-gate ast-num">
        {applyPreviewLine({
          candidateRunId: '',
          datasetVersionId: '',
          target: { kind: target, identifier: '', snapshotId: '' },
        })}
      </p>
      <div className="bench-btn-row">
        <input className="bench-approver ast-num" aria-label="Named approver" placeholder="Named approver" />
        <UnwiredButton variant="primary">Apply candidate</UnwiredButton>
        <UnwiredButton>View rollback path</UnwiredButton>
      </div>
      <p className="bench-gate">Apply is available once a candidate has passed its gates and a named approver is set.</p>
      <p className="bench-caption">{UNWIRED_TITLE}</p>
    </>
  );
}

function DefaultEvaluationSet() {
  return (
    <LabSurface
      id="lab-evaluation-set"
      title="Evaluation set"
      fact="versioned and immutable. New edits create the next version. Held-out edits create an audit entry."
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
      <p className="bench-caption">Lane readiness lands with the set.</p>
      <p className="bench-caption">
        Import filters: {Object.values(IMPORT_FILTER_LABELS).join(', ')}.
      </p>
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
              No cases yet. Import from Ask and Monitoring traces.
            </td>
          </tr>
        </tbody>
      </table>
      <p className="bench-footnote">
        Guideline alignment shows a preview and saves only after review. Retired cases keep their
        run history. A case can carry facts, a full response, or per-case guidelines.
      </p>
    </LabSurface>
  );
}

function DefaultGenieDiagnostics() {
  return (
    <LabSurface
      id="lab-genie-accuracy"
      title="Genie accuracy diagnostics"
      fact={MATCHING_POLICY_FACT}
      actions={
        <a className="bench-text-link" href={MATCHING_POLICY_REFERENCE}>
          Matching policy reference
        </a>
      }
    >
      <p className="bench-caption" id="lab-matching-policy">
        No run id yet · no dataset version · suite kind lands with the result.
      </p>
      <div className="bench-stat-strip">
        <div>
          <span className="ast-eyebrow">Accuracy</span>
          <strong className="ast-num tile-absent">not set</strong>
          <small>n of m + gate</small>
        </div>
        <div>
          <span className="ast-eyebrow">Execution errors</span>
          <strong className="ast-num tile-absent">not set</strong>
          <small>warehouse startup is not Genie-wrong</small>
        </div>
        <div>
          <span className="ast-eyebrow">Suite duration</span>
          <strong className="ast-num tile-absent">not set</strong>
          <small>whole suite, not per case</small>
        </div>
        <div>
          <span className="ast-eyebrow">Excluded</span>
          <strong className="ast-num tile-absent">not set</strong>
          <small>missing SQL, out of denominator</small>
        </div>
      </div>
      <table className="bench-sheet">
        <thead>
          <tr>
            <th>Case</th>
            <th>Question</th>
            <th>Result</th>
            <th>Reason</th>
            <th>Trace</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="bench-empty-row" colSpan={5}>
              Per-case pass, fail, and excluded rows land after a suite run.
            </td>
          </tr>
        </tbody>
      </table>
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
      fact="baseline vs candidate on the same dataset version and scorer set. No composite score."
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
                  <strong className="ast-num tile-absent">not set → not set</strong>
                  <small>No comparison yet</small>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="bench-footnote">
        Newly fixed and newly broken case chips land after a baseline and a candidate share a
        dataset version. Open the changed cases before applying.
      </p>
    </LabSurface>
  );
}

function DefaultFailureInvestigation({
  cases,
}: {
  cases: { id: string; question: string; outcome: string }[];
}) {
  return (
    <LabSurface
      id="lab-failure"
      title="Failure investigation"
      fact="every failed, provisional, skipped, or slow case opens its trace. Traces are governed evidence, not a debug dump."
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
          <header className="bench-failure-head">
            <p className="bench-caption">Pick a failed, provisional, skipped, or slow case.</p>
          </header>
          <div className="bench-span-legend">
            {SPAN_KINDS.map((kind) => (
              <span className="bench-type-tag" key={kind}>
                {kind}
              </span>
            ))}
          </div>
          <p className="bench-empty-row">Span tree, tokens, and cost land with the trace.</p>
          <p className="bench-caption">Judge rationale ends in the concrete fix.</p>
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
    <LabSurface
      id="lab-held-out"
      title="Held-out evaluation"
      fact={
        <>
          {HELD_OUT_LOCK_FACT}{' '}
          <Lock className="bench-lock" aria-hidden="true" />
        </>
      }
      actions={
        <span className="bench-caption">
          Values open the cases behind them.
        </span>
      }
    >
      <p className="bench-caption">No dataset version yet · split counts land with the set.</p>
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
        <tbody>
          <tr>
            <td className="bench-empty-row" colSpan={5}>
              Scorer rows land with a published evaluation. Non-applicable scorers stay hidden until
              Show them.
            </td>
          </tr>
        </tbody>
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
          <p className="bench-heading-fact">
            guided evaluation workspace
            <span className="ast-sep" />
            judges and scorers picked in Settings → Experimental
          </p>
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
        <p className="bench-caption bench-snapshot ast-num" id="lab-snapshot">
          {workspace?.contractView.snapshotDetail ||
            'No configuration snapshot is saved until a judge run starts. This link stays on the Lab.'}
        </p>
        <div className="bench-pipeline">
          <PipelineStage
            n="01"
            title="Curate the evaluation set"
            fact="versioned and immutable per version. Cases carry provenance, split, and review status."
          >
            {slots.stageCurate ?? <DefaultCurateStage workspace={workspace} />}
          </PipelineStage>
          <PipelineStage
            n="02"
            title="Genie accuracy"
            fact="uses the SQL-complete cases from 01. Matching tolerates reordering and extra columns, rejects under-selection."
          >
            {slots.stageGenie ?? <DefaultGenieStage workspace={workspace} />}
          </PipelineStage>
          <PipelineStage
            n="03"
            title="Agent judges"
            fact="scores the same cases from 01. Each run records dataset version, scorer set, configuration snapshot, and trace coverage."
          >
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
          <PipelineStage
            n="04"
            title="Apply the candidate"
            fact="target-specific. Nothing moves without a passing gate, a named approver, and a rollback path."
          >
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
