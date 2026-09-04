/**
 * The Benchmark Lab: the suite runner and the stored results it produced.
 *
 * Split out of App.tsx when the pages became modules. `metricOrDash` and the
 * poll interval come with it because it is the only caller of either -- the
 * dash rule is about a benchmark metric specifically, and the interval exists
 * because a suite run takes minutes.
 */
import { Link } from 'react-router';
import { useState, useEffect, useCallback } from 'react';
import './styles/routes/benchmark.css';
import { astPill, type AstPillFamily } from './pia-pill';
import { listAvailability, listUnreachable, type ListAvailability } from './list-availability';
import { UnavailablePanel } from './UnavailablePanel';
import { unavailableNotice } from './unavailable-copy';
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardDescription,
  CardContent,
  CardHeader,
  CardTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui';
import { Check, Info, TriangleAlert, User } from 'lucide-react';
import {
  benchmarkCaseRows,
  benchmarkQualifications,
  benchmarkStatus,
  benchmarkStatusLabel,
  benchmarkSummary,
  formatDuration,
  isTerminal,
  type BenchmarkCaseRow,
  type BenchmarkQualification,
  type BenchmarkStatus,
  type BenchmarkSummary,
} from './benchmark-summary';
import { useRunTrace } from './app-state';
import { conversationAge } from './conversation-age';
import { runLabel } from './run-label';
import { RunRatingBadge } from './RunRatingBadge';
import { PiaEmptyStateMark } from './PiaMark';
import { PiaFlicker } from './PiaFlicker';
import { UserDrilldownLink } from './UserDrilldownLink';
import type { Run } from './app-types';
import { evalScorecard } from './eval-scorecard';
import { SCORER_CATALOG } from '../../shared/scorer-catalog';
import type { Scorecard, ScorecardState } from '../../shared/scorecard-contract';
import { benchmarkSettingsFromResponse } from './benchmark-settings-api';
import { onBenchmarkSettingsSaved } from './benchmark-settings-events';
import { compareSides, DEFAULT_BENCHMARK_SETTINGS } from '../../shared/benchmark-settings';
import { OPERATOR_EVAL_SUITE_ID } from '../../shared/eval-dataset';
import {
  heldOutScorerRows,
  liveRunProgressLine,
  type HeldOutAuditEntry,
  type HeldOutStatus,
} from '../../shared/benchmark-lab-v3';
import { BenchmarkLabChrome, LabSurface, cellsFromPocContract } from './BenchmarkLabChrome';
import { EvaluationSet, CurateStageControls } from './EvaluationSet';
import { GenieAccuracyDiagnostics, GenieStageControls } from './GenieAccuracyDiagnostics';
import { suiteIsLive } from './benchmark-lab-ops';
import {
  BenchmarkApplyStage,
  BenchmarkBakeOffSurface,
  BenchmarkFailurePane,
  BenchmarkJudgesStage,
  useBenchmarkOps,
  type SuiteSide,
} from './BenchmarkLabOps';
import { useEvaluationLab } from './use-evaluation-lab';
import { browserPollHost, pollWhileVisible } from './visibility-polling';

/**
 * Formats a stored benchmark metric, or says it is absent.
 *
 * Never substitutes a plausible number for a missing one. A dash is a fact about
 * the run; a made-up percentage is a claim about the agent's quality.
 */
function metricOrDash(value: number | null | undefined, render: (value: number) => string) {
  return typeof value === 'number' && Number.isFinite(value) ? render(value) : '—';
}

/**
 * The icon a ledger row wears, which is the tone said a second way.
 *
 * Status is never carried by colour alone here: the danger rows have a warning
 * glyph as well as a red lead, and the identity row has a person rather than the
 * same circle as the measurement notes.
 */
function QualificationIcon({ tone }: { tone: BenchmarkQualification['tone'] }) {
  if (tone === 'danger') return <TriangleAlert />;
  if (tone === 'identity') return <User />;
  return <Info />;
}

/** A recorded run's status as one of the three tones the pill has. */
function statusTone(status: BenchmarkStatus) {
  if (status === 'complete') return 'tone-ok' as const;
  if (status === 'failed') return 'tone-bad' as const;
  if (status === 'partial') return 'tone-degraded' as const;
  return 'tone-neutral' as const;
}

/**
 * The four tones this lab and the conversation rail both speak, in the palette's
 * own families.
 *
 * `tone-degraded` is the one worth stating: a mixed result is a QUALIFICATION of
 * a run that finished, not a failure of it, so it takes the warning family. Red
 * here is reserved for a run where nothing passed.
 *
 * `tone-neutral` takes the outlined form, for the same reason the Monitoring
 * table's refusals do: it sits in a column beside filled green and filled red,
 * and a third fill reads as a third verdict rather than as the absence of one.
 */
const BENCH_FAMILY: Record<'tone-ok' | 'tone-bad' | 'tone-degraded' | 'tone-neutral', AstPillFamily> = {
  'tone-ok': 'pos',
  'tone-bad': 'neg',
  'tone-degraded': 'warn',
  'tone-neutral': 'neutral-outline',
};

/** How often a still-running suite is re-read. Runs take four to five minutes. */
const BENCHMARK_POLL_MS = 5_000;

/**
 * The qualification ledger: one row per qualification the run carries.
 *
 * Rendered from the derived rows and nothing else, so a qualification cannot be
 * reachable only through markup written for it. Every row is a factual claim about
 * this run — which judge model, which prompt version, whose permissions, which
 * model version, whether it stopped early — and each is either driven by what the
 * run recorded or absent.
 *
 * A component of its own for the same reason the tiles are: the page's run arrives
 * through an effect, so a test that mounts the page statically is looking at a
 * skeleton and can prove nothing about these rows.
 */
export function BenchmarkLedger({ qualifications }: { qualifications: BenchmarkQualification[] }) {
  if (qualifications.length === 0) return null;
  return (
    <section className="bench-ledger" aria-labelledby="benchmark-ledger-head">
      <h3 className="bench-ledger-head" id="benchmark-ledger-head">
        Read before comparing these scores
      </h3>
      <ul className="bench-ledger-rows">
        {qualifications.map((row) => (
          <li key={row.field} className={`bench-ledger-row tone-${row.tone}`}>
            <QualificationIcon tone={row.tone} />
            <p>
              <strong>
                {row.lead}
                {row.identity ? (
                  <>
                    {' '}
                    <UserDrilldownLink identity={row.identity} compact />
                  </>
                ) : null}
                .
              </strong>{' '}
              {row.sentence}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The five figures, with the population each one is over under it.
 *
 * The caption is not decoration on this row. Every value here is a rate or a
 * fraction, and the design's own point is that the denominator is stated: "9 / 12
 * of cases that ran" and "87% of 11 judged cases" are results, where "9 / 12" and
 * "87%" beside each other invite the reader to assume both are over the suite,
 * which for the judged rates is never true. So the caption comes from the
 * derivation rather than being written here, and there is no branch in which a
 * figure renders without one.
 *
 * A separate component so the row can be rendered against a run in a test. The
 * page's own data arrives through an effect, which a static render never runs, so
 * every assertion about these tiles made against the page was an assertion about
 * a skeleton.
 */
export function BenchmarkTiles({ summary, hasRun }: { summary: BenchmarkSummary; hasRun: boolean }) {
  // What is true of the whole row before any figure is read. A page with no run
  // selected, and a run that has not finished, are both states where a caption
  // about populations would be answering a question nobody has asked yet.
  const pending = !hasRun ? 'No run selected' : summary.inProgress ? 'Run still in progress' : null;
  return (
    <>
      <div className="summary-grid">
        <Card>
          <CardContent>
            <span>Cases passed</span>
            {/* A fraction, never a bare rate: a suite where three of ten cases error
                must read "5 / 10" so it can never be reported as a score out of the
                seven that happened to produce an answer. */}
            <strong className="ast-num">{summary.passedLabel}</strong>
            <small>{pending ?? summary.passedCoverage ?? 'Population not reported'}</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <span>Suite duration</span>
            <strong className="ast-num">{summary.durationLabel}</strong>
            {/* The case count, so a four-minute suite is never read as a per-case
                latency. Taken from the run, so it moves when the suite does. */}
            <small>{summary.durationCoverage ?? 'Whole suite, not per case'}</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <span>Groundedness</span>
            {/* Counted over the cases this judge reached a verdict on, which is not
                the case total. A rubric that did not apply to a case was never
                measured on it, and a rate that borrows the case count says
                otherwise. */}
            <strong className="ast-num">{summary.groundednessLabel}</strong>
            <small>{summary.groundednessCoverage}</small>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <span>Relevance</span>
            <strong className="ast-num">{summary.relevanceLabel}</strong>
            <small>{summary.relevanceCoverage}</small>
          </CardContent>
        </Card>
        <Card className="benchmark-score">
          <CardContent>
            <span>Guidelines</span>
            {/* Present because the governance refusal is scored by this rubric
                alone: a scheme where a correct refusal fails by construction is
                worse than no scoring. Cases with no guideline do not apply here,
                and not-applicable is not a failure. */}
            <strong className="ast-num">{summary.guidelinesLabel}</strong>
            <small>{summary.guidelinesCoverage}</small>
          </CardContent>
        </Card>
      </div>
      {/* Under the row rather than in a tile's caption, where it used to sit and
          where it competed with the denominator for the same line. It is the
          shape behind the pass count: "2 / 6" reads as a broken agent when
          relevance was 5 of 5 and both cases the demo turns on passed, true and
          misleading, and an errored case must never read as a failed one. */}
      {!pending && summary.outcomeLabel && <p className="bench-outcomes">Cases by outcome: {summary.outcomeLabel}.</p>}
    </>
  );
}

const HELD_OUT_STATUS_LABEL: Record<HeldOutStatus, string> = {
  evaluated: 'Evaluated',
  provisional: 'Provisional',
  not_evaluated: 'Not evaluated',
  skipped: 'Skipped',
  errored: 'Errored',
};

const HELD_OUT_STATUS_FAMILY: Record<HeldOutStatus, 'pos' | 'warn' | 'neg' | 'neutral-outline'> = {
  evaluated: 'pos',
  provisional: 'warn',
  not_evaluated: 'neutral-outline',
  skipped: 'neutral-outline',
  errored: 'neg',
};

/**
 * Held-out evaluation: a control table over the frozen split, not a live suite.
 *
 * Non-applicable scorers stay hidden until Show them. Unimplementable rows
 * never take a numeric value even if a scorecard supplies one.
 */
export function HeldOutEvaluation({
  state,
  versionLabel,
  tuningCount,
  heldOutCount,
  revealNonApplicable = false,
  heldOutAudit = [],
  tuningById,
}: {
  state: ScorecardState;
  versionLabel?: string;
  tuningCount?: number | null;
  heldOutCount?: number | null;
  revealNonApplicable?: boolean;
  heldOutAudit?: HeldOutAuditEntry[];
  tuningById?: Record<string, string>;
}) {
  const [showNonApplicable, setShowNonApplicable] = useState(revealNonApplicable);
  const scorecard: Scorecard | null = state.published ? state.scorecard : null;
  const view = heldOutScorerRows({
    scorecard,
    labelsReviewed: Boolean(scorecard?.provenance.labelsReviewed),
    hideNonApplicable: !showNonApplicable,
    tuningById,
  });
  const byId = new Map(SCORER_CATALOG.map((definition) => [definition.id, definition]));
  const splitLine = [
    versionLabel?.trim() || 'No dataset version yet',
    typeof tuningCount === 'number' ? `${tuningCount} tuning` : null,
    typeof heldOutCount === 'number' ? `${heldOutCount} held out` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <LabSurface id="lab-held-out" title="Held-out evaluation">
      <p className="bench-caption ast-num">{splitLine}</p>
      {heldOutAudit.length > 0 ? (
        <p className="bench-audit-banner" role="status">
          {heldOutAudit.length} held-out {heldOutAudit.length === 1 ? 'case was' : 'cases were'} edited after the split.{' '}
          {heldOutAudit[0]?.note}
        </p>
      ) : null}
      {!scorecard ? (
        <Alert>
          <TriangleAlert />
          <AlertDescription>{state.published ? '' : state.reason}</AlertDescription>
        </Alert>
      ) : null}
      {view.hiddenNonApplicable > 0 ? (
        <p className="bench-caption">
          {view.hiddenNonApplicable} not applicable.{' '}
          <button type="button" className="bench-text-link" onClick={() => setShowNonApplicable(true)}>
            Show them
          </button>
        </p>
      ) : null}
      <div className="bench-scorers">
        <table className="bench-sheet">
          <thead>
            <tr>
              <th>Scorer</th>
              <th>{typeof tuningCount === 'number' ? `Tuning · ${tuningCount}` : 'Tuning'}</th>
              <th>{typeof heldOutCount === 'number' ? `Held-out · ${heldOutCount}` : 'Held-out'}</th>
              <th>Status</th>
              <th> </th>
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0
              ? null
              : view.rows.map((row) => {
                  const definition = byId.get(row.id);
                  return (
                    <tr key={row.id} className={row.applicable ? undefined : 'bench-scorer-blocked'}>
                      <td>
                        <span className="bench-scorer-name">{row.label}</span>
                        <span className="bench-case-id ast-num">{row.id}</span>
                        {!row.applicable && definition?.blockedReason ? (
                          <span className="bench-case-note">{definition.blockedReason}</span>
                        ) : null}
                      </td>
                      <td className="ast-num">{row.tuning}</td>
                      <td className="ast-num">{row.heldOut}</td>
                      <td>
                        <span className={astPill(HELD_OUT_STATUS_FAMILY[row.status], 'bench-chip')}>
                          {HELD_OUT_STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td>
                        <a className="bench-text-link" href={row.casesAndTracesHref}>
                          cases and traces
                        </a>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
    </LabSurface>
  );
}

/**
 * The Benchmark Lab, showing only what the store actually holds.
 *
 * Every figure comes from the store. This is the screen that most looks like
 * evidence, so a hardcoded headline here is read as a measurement.
 *
 * Reads `/api/runs` for stored benchmark runs and `/api/runs/:id/trace` for one
 * run's metrics: both existing endpoints, so the runner needs no new contract.
 */
export function BenchmarkLab() {
  const evalLab = useEvaluationLab();
  const reloadEvaluationLab = evalLab.reload;
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [availability, setAvailability] = useState<ListAvailability | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [bakeOff, setBakeOff] = useState(DEFAULT_BENCHMARK_SETTINGS);
  const [currentAgentEndpoint, setCurrentAgentEndpoint] = useState('');

  useEffect(() => {
    let cancelled = false;
    const loadBenchmarkSettings = () => {
      void fetch('/api/benchmark-settings')
        .then((response) => benchmarkSettingsFromResponse(response, 'loaded'))
        .then((payload) => {
          if (!cancelled) {
            setBakeOff(payload.settings);
            setCurrentAgentEndpoint(payload.currentAgentEndpoint);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setBakeOff(DEFAULT_BENCHMARK_SETTINGS);
            setRunError((error as Error).message || 'Benchmark settings could not be read.');
          }
        });
    };
    loadBenchmarkSettings();
    const unsubscribe = onBenchmarkSettingsSaved(loadBenchmarkSettings);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (reloadToken === 0) return;
    void reloadEvaluationLab();
  }, [reloadToken, reloadEvaluationLab]);

  useEffect(() => {
    let active = true;
    fetch('/api/runs')
      .then(async (response) => {
        if (!response.ok) throw new Error('Stored benchmark runs could not be read.');
        const rows = (await response.json()) as Run[];
        // Classified on the whole response, not on the benchmark subset. A store
        // holding a hundred conversation runs and no benchmark ones is empty as
        // far as this page is concerned but is not an outage, and filtering
        // first would lose the difference.
        if (active) setAvailability(listAvailability({ headers: response.headers, rowCount: rows.length }));
        return rows;
      })
      .then((rows) => {
        if (active) setRuns(rows.filter((run) => run.kind === 'benchmark'));
      })
      .catch(() => {
        if (!active) return;
        // No fixture stand-in. An unreadable list is reported as unreadable; the
        // previous page could not express this state at all. The error's own
        // text is dropped rather than shown: it says "could not be read", which
        // is what the panel says anyway, and a second sentence saying it again
        // reads as a second fault.
        setRuns([]);
        setAvailability(listUnreachable());
      });
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const selected = runs?.find((run) => run.id === selectedId) ?? runs?.[0] ?? null;
  const traceState = useRunTrace(selected?.id, reloadToken);
  const metrics = traceState.status === 'ready' ? traceState.data.benchmark : null;
  // Every figure below is derived here, once, from this run. Nothing on the page
  // holds a count of its own, which is what makes the old three-way disagreement
  // between a six-row table, a "8 / 10" tile and an "8 of 10" alert impossible.
  const summary = benchmarkSummary(selected?.status, metrics);
  // The run's own per-case record, which it has carried since the runner was
  // rewritten. Read from the same metrics the tiles are, so the case list and the
  // totals above it cannot come from different places.
  const caseRows = benchmarkCaseRows(metrics);

  // A suite takes four to five minutes, so a run is not finished when the POST
  // returns. Poll the run's own trace until it reports a terminal outcome.
  //
  // Only while the tab is visible. Four to five minutes is long enough that
  // starting a suite and going to do something else is the normal way to use
  // this page, and an unconditional interval would spend that whole run reading
  // a trace into a tab nobody is watching. Coming back re-reads immediately, so
  // the wait is not paid twice.
  useEffect(() => {
    if (!selected || !summary.inProgress) return;
    return pollWhileVisible(() => setReloadToken((token) => token + 1), BENCHMARK_POLL_MS, browserPollHost());
  }, [selected, summary.inProgress]);

  const runSuite = useCallback(
    async (which: SuiteSide = 'baseline', caseIds?: string[]): Promise<string[]> => {
      setRunning(true);
      setRunError(null);
      const started: string[] = [];
      try {
        const sides = compareSides(bakeOff);
        const side = which === 'candidate' ? sides[1] : sides[0];
        if (which === 'candidate' && !side) {
          throw new Error('Add a candidate endpoint in Settings → Experimental.');
        }
        const suiteId = OPERATOR_EVAL_SUITE_ID;
        const response = await fetch('/api/benchmarks/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suiteId,
            agentEndpoint: !side || side === 'current' ? undefined : side,
            bakeOffSide: which,
            ...(caseIds?.length ? { caseIds } : {}),
          }),
        });
        if (!response.ok) {
          const refusal = (await response.json().catch(() => null)) as { message?: unknown } | null;
          const message = typeof refusal?.message === 'string' ? refusal.message.trim() : '';
          throw new Error(message || `The suite could not be started (HTTP ${response.status}).`);
        }
        const created = (await response.json()) as { id?: unknown };
        const id = typeof created.id === 'string' ? created.id : null;
        if (id) started.push(id);
        setLastRunId(id);
        if (id) setSelectedId(id);
        setReloadToken((token) => token + 1);
        const flywheelResponse = await fetch('/api/benchmarks/flywheel');
        const flywheelBody = flywheelResponse.ok
          ? ((await flywheelResponse.json()) as {
              flywheel?: { lastAgentRunIds?: string[]; lastAgentSides?: string[] };
            })
          : null;
        const prevIds = flywheelBody?.flywheel?.lastAgentRunIds ?? [];
        const prevSides = flywheelBody?.flywheel?.lastAgentSides ?? [];
        const runIds = which === 'baseline' ? [id, prevIds[1]].filter(Boolean) : [prevIds[0] || id, id].filter(Boolean);
        const named =
          which === 'baseline'
            ? [side || 'current', prevSides[1]].filter(Boolean)
            : [prevSides[0] || side || 'current', side || 'candidate'];
        await fetch('/api/admin/benchmarks/last-suite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'agent',
            at: new Date().toISOString(),
            runIds,
            sides: named,
          }),
        }).then(async (response) => {
          if (!response.ok) {
            const refusal = (await response.json().catch(() => null)) as { message?: unknown } | null;
            const message = typeof refusal?.message === 'string' ? refusal.message.trim() : '';
            throw new Error(message || 'Suite started, but the bake-off pairing was not saved.');
          }
        });
        return started;
      } catch (error) {
        const message = (error as Error).message || 'The suite could not be started.';
        setRunError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        setRunning(false);
      }
    },
    [bakeOff]
  );

  // A leftover cancel flag, or an old stored run auto-selected on first
  // visit, must not freeze Run baseline. Only a suite this page started.
  const started = lastRunId ? runs?.find((run) => run.id === lastRunId) : null;
  const suiteInProgress = suiteIsLive({
    running,
    lastRunId,
    lastRunFound: Boolean(started),
    lastRunInProgress: Boolean(started && !isTerminal(benchmarkStatus(started.status))),
    liveRun: evalLab.lab.contract.liveRun,
  });

  const publishedHeldOut = evalScorecard();
  const ops = useBenchmarkOps({
    settings: bakeOff,
    currentAgentEndpoint,
    running: running || suiteInProgress,
    lastRunId,
    reloadToken,
    lastGenieRun: evalLab.lastGenieRun,
    labelsReviewed: Boolean(publishedHeldOut.published && publishedHeldOut.scorecard.provenance.labelsReviewed),
    inProgress: suiteInProgress,
    attempted: evalLab.lab.contract.liveRun?.caseIndex ?? null,
    total: evalLab.lab.contract.liveRun?.caseTotal ?? null,
    selectedId: selected?.id || selectedId || null,
    runSuite,
    lab: evalLab.lab,
    setLab: evalLab.setLab,
  });

  // Every qualification this run carries, as the rows of one ledger. The page
  // used to stack them as up to six separate alerts, which put a wall of them
  // between the reader and the first number on a bad run. Each row still says
  // exactly what its alert said: the derivation is the single place they come
  // from, and none of them is conditional on anything but the run.
  const qualifications = benchmarkQualifications(summary);
  const runProgress =
    evalLab.lab.contract.liveRun && !evalLab.lab.contract.liveRun.cancelRequested
      ? liveRunProgressLine(evalLab.lab.contract.liveRun)
      : selected && summary.inProgress && selected.id === lastRunId
        ? `${selected.id} in progress`
        : null;

  return (
    <div className="page-shell benchmark-lab">
      <BenchmarkLabChrome
        notices={
          <>
            {/* One panel rather than this page's own sentence, so an outage reads the
          same here as it does in Run Explorer and the rail. The detail carries
          the line about the blank space not being a zero, which is the claim
          this page was closest to making: every tile above it is a score. */}
            {availability?.origin === 'unavailable' && (
              <UnavailablePanel
                notice={unavailableNotice({ surface: 'benchmarks', code: 'DEPENDENCY_UNAVAILABLE' })}
                onRetry={() => setReloadToken((token) => token + 1)}
              />
            )}

            {runError && (
              <Alert>
                <TriangleAlert />
                <AlertDescription>{runError}</AlertDescription>
              </Alert>
            )}

            {evalLab.error && evalLab.error !== runError && (
              <Alert>
                <TriangleAlert />
                <AlertDescription>{evalLab.error}</AlertDescription>
              </Alert>
            )}

            {lastRunId && !runError && (
              <Alert>
                {summary.inProgress ? <PiaFlicker seat="status" /> : <Check />}
                <AlertDescription>
                  {summary.inProgress
                    ? 'Run started. A suite takes several minutes; this page is polling it and will report what it records.'
                    : 'Run finished. Its recorded metrics are shown below.'}{' '}
                  <Link to={`/runs?run=${encodeURIComponent(lastRunId)}`} className="underline font-medium">
                    Open it in the Run Explorer
                  </Link>
                  .
                </AlertDescription>
              </Alert>
            )}
          </>
        }
        contract={cellsFromPocContract(evalLab.lab.contractView)}
        judges={bakeOff.enabledJudges}
        runProgress={runProgress}
        running={running || suiteInProgress}
        workspace={evalLab.lab}
        onRunBaseline={() => {
          void ops.runBaseline();
        }}
        onRunCandidate={() => {
          void ops.runCandidate();
        }}
        onCancel={() => {
          void ops.cancelRun();
        }}
        comparisonExtras={<BenchmarkLedger qualifications={qualifications} />}
        slots={{
          evaluationSet: <EvaluationSet lab={evalLab} />,
          genieDiagnostics: <GenieAccuracyDiagnostics lab={evalLab} />,
          stageCurate: <CurateStageControls lab={evalLab} />,
          stageGenie: <GenieStageControls lab={evalLab} />,
          stageJudges: (
            <BenchmarkJudgesStage
              judges={ops.judges}
              needTags={ops.needTags}
              running={running || suiteInProgress}
              progress={ops.progress}
              hasCandidate={ops.hasCandidate}
              threadNote={ops.threadNote}
              onRunBaseline={() => {
                void ops.runBaseline();
              }}
              onRunCandidate={() => {
                void ops.runCandidate();
              }}
              onScoreSession={() => {
                void ops.scoreSession();
              }}
              onCancel={() => {
                void ops.cancelRun();
              }}
              onRetryFailed={() => {
                void ops.retryFailed();
              }}
            />
          ),
          stageApply: (
            <BenchmarkApplyStage
              target={ops.target}
              onTarget={ops.setTarget}
              approver={ops.approver}
              onApprover={ops.setApprover}
              promptName={ops.promptName}
              onPromptName={ops.setPromptName}
              gateLabel={ops.gateLabel}
              rollback={ops.rollback}
              applying={ops.applying}
              applyNote={ops.applyNote}
              applyPreview={ops.applyPreview}
              canApply={ops.canApply}
              applyBlockedReason={ops.applyBlockedReason}
              onApply={() => {
                void ops.applyCandidate();
              }}
              onViewRollback={() => {
                ops.viewRollback();
              }}
              canRollback={ops.canRollback}
              rollbackDisabledReason={ops.rollbackDisabledReason}
              onRollback={() => {
                void ops.rollbackAsk();
              }}
            />
          ),
          runComparison: (
            <BenchmarkBakeOffSurface
              comparison={ops.comparison}
              extras={<BenchmarkLedger qualifications={qualifications} />}
              history={ops.history}
              genieNote={ops.genieNote}
              coverageNote={ops.coverageNote}
              actionNote={ops.actionNote}
              onExport={ops.exportPack}
              onCopyPermalink={() => {
                void ops.copyPermalink();
              }}
              onInspect={(caseId) => ops.setSelectedFailure(caseId)}
            />
          ),
          failureInvestigation: (
            <BenchmarkFailurePane
              cases={ops.inspectCases}
              selectedId={ops.selectedFailure}
              onSelect={ops.setSelectedFailure}
              note={ops.failureNote}
              onAddEdge={() => {
                void ops.addEdge();
              }}
              onMarkKnown={() => {
                void ops.markKnown();
              }}
            />
          ),
          heldOut: (
            <HeldOutEvaluation
              state={evalScorecard()}
              versionLabel={evalLab.lab.currentVersionId}
              tuningCount={Math.max(0, evalLab.lab.counts.active - evalLab.lab.counts.heldOut)}
              heldOutCount={evalLab.lab.counts.heldOut}
              heldOutAudit={evalLab.lab.heldOutAudit}
              tuningById={ops.tuningById}
            />
          ),
        }}
        failureCases={caseRows.map((row) => ({
          id: row.caseId || row.key,
          question: row.question ?? 'The question was not recorded',
          outcome: row.outcomeLabel,
        }))}
      />
    </div>
  );
}

/**
 * The stored runs, one row each, and the one the page is reading from.
 *
 * The selected row is the control for the whole screen, so it is marked twice: the
 * blue left edge a reader sees, and `aria-pressed` on the run's own button for a
 * reader who cannot. Status is a scoring verdict rather than a report on whether
 * the run executed, which is why the labels say what scored rather than "Complete"
 * — see `benchmarkStatusLabel`.
 */
export function RecordedRuns({
  runs,
  selectedId,
  onSelect,
}: {
  runs: Run[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recorded runs</CardTitle>
        {/* What selecting a row does, because it drives every figure on the page
            above it and nothing else on screen says so. The stored count comes
            with it: a reader who has run the suite twice and sees three rows is
            looking at somebody else's run as well as their own. */}
        <CardDescription>
          {runs === null
            ? 'Reading stored benchmark runs…'
            : runs.length === 0
              ? 'No benchmark run has been recorded yet.'
              : `Selecting a run drives every figure above. ${runs.length} stored ${runs.length === 1 ? 'run' : 'runs'}.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {runs === null ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : runs.length === 0 /* The state a customer's first visit is in. It used to be unreachable,
             because the page never asked the store anything. */ ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PiaEmptyStateMark size={32} />
              </EmptyMedia>
              <EmptyTitle>Nothing has been benchmarked yet</EmptyTitle>
              {/* Only ever reached when the store answered, because the
                  unavailable panel above renders instead when it did not. The
                  outage wording that used to live here said the same thing
                  twice on one screen, in different words, which reads as two
                  problems. */}
              <EmptyDescription>Start a run and it will appear here with the metrics it recorded.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="bench-num">Duration</TableHead>
                  <TableHead>Feedback</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const status = benchmarkStatus(run.status);
                  const isSelected = selectedId === run.id;
                  return (
                    <TableRow
                      key={run.id}
                      className={`bench-run-row ${isSelected ? 'active' : ''}`}
                      onClick={() => onSelect(run.id)}
                    >
                      <TableCell>
                        {/* A real button, so the control that drives every figure
                            above this table is reachable and operable from the
                            keyboard. The row keeps its click for the rest of its
                            width; this is what puts it in the tab order. */}
                        <button
                          type="button"
                          className="bench-run-open"
                          aria-pressed={isSelected}
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect(run.id);
                          }}
                        >
                          {runLabel(run)}
                        </button>
                      </TableCell>
                      <TableCell className="bench-when">{conversationAge(run.created_at)}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={astPill(BENCH_FAMILY[statusTone(status)], `bench-pill ${statusTone(status)}`)}
                        >
                          {benchmarkStatusLabel(status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="bench-num">
                        {isTerminal(status) ? metricOrDash(run.duration_ms, formatDuration) : 'In progress'}
                      </TableCell>
                      <TableCell>
                        <RunRatingBadge feedback={run.feedback} legacyUsefulness={run.rating} showNoFeedback />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What each case did, from the run's own record of it.
 *
 * This panel held a permanent empty state saying a run records suite-level totals
 * only. That stopped being true when the runner was rewritten: it writes a `cases`
 * array into `metrics_json`, and the trace projection spreads the whole of it, so
 * the record was in the payload this panel was already reading while the panel
 * said no such record existed. On a screen whose whole subject is honest
 * reporting, that was the worst possible thing to be wrong about.
 *
 * It still holds no case list of its own. Every column here comes from the run:
 * the questions used to live in a hardcoded array in this file, which is exactly
 * why the timings printed beside them were invented, and two lists to keep in step
 * is how a six-row table came to disagree with the tile above it.
 */
export function PerCaseResults({ rows, inProgress }: { rows: BenchmarkCaseRow[]; inProgress: boolean }) {
  return (
    <Card className="bench-percase">
      <CardHeader>
        <CardTitle className="text-base">Per-case results</CardTitle>
        <CardDescription>
          {rows.length === 0
            ? 'What each case in the suite did'
            : `What each of the ${rows.length} recorded ${rows.length === 1 ? 'case' : 'cases'} did, as the run recorded it`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PiaEmptyStateMark size={32} />
              </EmptyMedia>
              <EmptyTitle>Not reported per case yet</EmptyTitle>
              {/* Which of the two reasons it is, because they are different facts:
                  a suite that has not got to its first case yet, and a run stored
                  before the runner recorded cases at all. Neither is an error, and
                  neither is a promise about what a later release will do. */}
              <EmptyDescription>
                {inProgress
                  ? 'No case in this run has finished yet. Cases appear here as the suite records them.'
                  : 'This run recorded suite-level totals only. Per-case results appear here for runs that report them.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="table-scroll bench-cases">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Case</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="bench-num">Took</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>
                      <span className="bench-case-question">{row.question ?? 'The question was not recorded'}</span>
                      {row.caseId && <span className="bench-case-id">{row.caseId}</span>}
                      {/* The runner's own sentence about the case, which is where
                          it says a refusal was not counted as a failure and an
                          unscored case was not claimed as a pass. Dropping it
                          would leave the pill to carry a distinction a pill
                          cannot carry. */}
                      {row.note && <span className="bench-case-note">{row.note}</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={astPill(BENCH_FAMILY[row.tone], `bench-pill ${row.tone}`)}>
                        {row.outcomeLabel}
                      </Badge>
                    </TableCell>
                    <TableCell className="bench-num">{row.durationLabel}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
