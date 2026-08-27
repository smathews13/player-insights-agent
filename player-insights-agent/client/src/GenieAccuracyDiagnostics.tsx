import { astPill } from './astrolabe-pill';
import { BenchButton, LabSurface } from './BenchmarkLabChrome';
import { MATCHING_POLICY_FACT, mlflowTraceHref } from '../../shared/benchmark-lab-v3';
import type { GenieAccuracyCaseView, GenieAccuracyRunView } from '../../shared/eval-genie-run';
import type { EvaluationLabModel } from './use-evaluation-lab';

function formatSuiteDuration(startedAt: string, finishedAt: string): string {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return 'not set';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function outcomeChip(entry: GenieAccuracyCaseView): { label: string; family: 'pos' | 'neg' | 'neutral-outline' } {
  if (entry.excluded) return { label: 'Excluded', family: 'neutral-outline' };
  if (entry.outcome === 'pass') return { label: 'Pass', family: 'pos' };
  return { label: 'Fail', family: 'neg' };
}

function executionErrorCount(run: GenieAccuracyRunView): number {
  return run.cases.filter((entry) => !entry.excluded && (entry.outcome === 'error' || entry.missKind === 'error')).length;
}

function excludedCount(run: GenieAccuracyRunView): number {
  return run.cases.filter((entry) => entry.excluded).length;
}

function accuracyGate(run: GenieAccuracyRunView, minimum: number | null | undefined): string {
  if (typeof minimum !== 'number') return `${run.score.passed} of ${run.score.total}`;
  const rate = run.score.total > 0 ? run.score.passed / run.score.total : null;
  if (rate == null) return `${run.score.passed} of ${run.score.total}`;
  return rate >= minimum
    ? `${run.score.passed} of ${run.score.total} · gate met`
    : `${run.score.passed} of ${run.score.total} · below gate`;
}

export function GenieAccuracyResult({
  run,
  accuracyGateMinimum,
}: {
  run: GenieAccuracyRunView;
  accuracyGateMinimum?: number | null;
}) {
  return (
    <>
      <p className="bench-caption ast-num" id="lab-matching-policy">
        {run.id} · {run.datasetVersion} · {run.suiteKind} suite · {run.matchingPolicyFact}{' '}
        <a className="bench-text-link" href={run.matchingPolicyHref}>
          Matching policy reference
        </a>
      </p>
      <div className="bench-stat-strip">
        <div>
          <span className="ast-eyebrow">Accuracy</span>
          <strong className="ast-num">{accuracyGate(run, accuracyGateMinimum)}</strong>
          <small>n of m + gate</small>
        </div>
        <div>
          <span className="ast-eyebrow">Execution errors</span>
          <strong className="ast-num">{executionErrorCount(run)}</strong>
          <small>warehouse startup is not Genie-wrong</small>
        </div>
        <div>
          <span className="ast-eyebrow">Suite duration</span>
          <strong className="ast-num">{formatSuiteDuration(run.startedAt, run.finishedAt)}</strong>
          <small>whole suite, not per case</small>
        </div>
        <div>
          <span className="ast-eyebrow">Excluded</span>
          <strong className="ast-num">{excludedCount(run)}</strong>
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
          {run.cases.map((entry) => (
            <GenieCaseRows key={entry.id} entry={entry} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function GenieCaseRows({ entry }: { entry: GenieAccuracyCaseView }) {
  const chip = outcomeChip(entry);
  const href = entry.conversationId ? mlflowTraceHref(entry.conversationId) : '';
  const failed = !entry.excluded && entry.outcome !== 'pass';
  return (
    <>
      <tr>
        <td className="ast-num">{entry.id}</td>
        <td>{entry.question}</td>
        <td>
          <span className={astPill(chip.family, 'bench-chip')}>{chip.label}</span>
        </td>
        <td>{entry.note}</td>
        <td>
          {href ? (
            <a className="bench-text-link ast-num" href={href}>
              {entry.conversationId}
            </a>
          ) : (
            'not recorded'
          )}
        </td>
      </tr>
      {failed ? (
        <tr>
          <td className="bench-sql-compare" colSpan={5}>
            <div className="bench-sql-triple">
              <div>
                <span className="ast-eyebrow">Generated SQL</span>
                <pre className="ast-num">{entry.predictedSql || 'None returned'}</pre>
              </div>
              <div>
                <span className="ast-eyebrow">Ground truth</span>
                <pre className="ast-num">{entry.groundTruthSql || 'None recorded'}</pre>
              </div>
              <div>
                <span className="ast-eyebrow">Result comparison</span>
                <p className="bench-sql-reason">{entry.comparisonReason || entry.note}</p>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function GenieAccuracyDiagnostics({ lab }: { lab: EvaluationLabModel }) {
  const run = lab.lastGenieRun;
  return (
    <LabSurface
      id="lab-genie-accuracy"
      title="Genie accuracy diagnostics"
      fact={MATCHING_POLICY_FACT}
      actions={
        <a className="bench-text-link" href="#lab-matching-policy">
          Matching policy reference
        </a>
      }
    >
      {run ? (
        <GenieAccuracyResult run={run} accuracyGateMinimum={lab.lab.contract.gates.genieAccuracy.minimum} />
      ) : (
        <>
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
        </>
      )}
      {lab.notice && lab.busy !== 'import' && lab.busy !== 'align' ? (
        <p className="bench-caption bench-pad">{lab.notice}</p>
      ) : null}
      {lab.error ? <p className="bench-caption bench-pad">{lab.error}</p> : null}
    </LabSurface>
  );
}

export function GenieStageControls({ lab }: { lab: EvaluationLabModel }) {
  const gate = lab.lab.geniePlan.gateCopy;
  return (
    <>
      <div className="bench-btn-row">
        {lab.spaces.length === 0 ? (
          <p className="bench-caption">No Genie space is connected yet. Connect one on Connections, then come back.</p>
        ) : (
          <select
            className="eval-space-select bench-space-select"
            aria-label="Genie space"
            value={lab.spaceId}
            onChange={(event) => lab.setSpaceId(event.target.value)}
          >
            {lab.spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.label}
              </option>
            ))}
          </select>
        )}
        <BenchButton
          variant="primary"
          onClick={() => void lab.runSuite('complete')}
          disabled={lab.busy === 'genie' || !lab.spaceId}
        >
          {lab.busy === 'genie' ? 'Asking Genie' : 'Run complete suite'}
        </BenchButton>
        <BenchButton onClick={() => void lab.runSuite('partial')} disabled={lab.busy === 'genie' || !lab.spaceId}>
          Run partial suite
        </BenchButton>
        <span className={astPill('neutral-outline', 'bench-chip')}>matching · executed-result equivalence</span>
      </div>
      <p className="bench-gate">
        {gate ||
          (lab.lab.counts.genieLaneReady === 0
            ? 'No SQL-complete cases yet. Fix them in 01 or run partial: excluded cases and the denominator are shown on the result.'
            : 'Complete suite is the customer-facing default. Partial keeps missing SQL out of the denominator.')}
      </p>
    </>
  );
}
