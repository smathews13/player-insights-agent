import { useCallback, useEffect, useState } from 'react';
import {
  datasetCounts,
  datasetSizeLabel,
  emptyEvalRow,
  labeledRowCount,
  newEvalRowId,
  OPERATOR_EVAL_SUITE_ID,
  starterEvalDataset,
  type EvalDataset,
  type EvalRow,
} from '../../shared/eval-dataset';
import { compareSides, DEFAULT_BENCHMARK_SETTINGS } from '../../shared/benchmark-settings';
import {
  compareSidesSummary,
  EMPTY_FLYWHEEL_STATE,
  genieMissLabel,
  historyLine,
  pickWinner,
  type FlywheelState,
  type SideScore,
} from '../../shared/eval-flywheel';
import { benchmarkSettingsFromResponse } from './benchmark-settings-api';
import type { ResourceRow } from './connection-model';
import type { Run, RunTrace } from './app-types';
import type { MonitoringQuestionsPayload } from '../../shared/monitoring-contract';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
} from './ui';
import { CircleAlert, Loader2, Play, Plus, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react';

export interface ConnectedGenieSpace {
  id: string;
  label: string;
}

export function connectedGenieSpaces(resources: readonly ResourceRow[]): ConnectedGenieSpace[] {
  return resources
    .filter((row) => row.resource.kind === 'genie-space')
    .map((row) => ({
      id: (row.actual || row.configured || row.intended || '').trim(),
      label: row.resource.label,
    }))
    .filter((space) => space.id);
}

export interface GenieAccuracyCaseView {
  id: string;
  question: string;
  outcome: 'pass' | 'fail' | 'error';
  predictedSql: string;
  groundTruthSql: string;
  note: string;
  durationMs?: number;
  missKind?: 'warehouse' | 'timeout' | 'error' | null;
  excluded?: boolean;
  checks?: { id: string; label: string; passed: boolean | null; note: string }[];
}

export interface GenieAccuracyView {
  spaceId: string;
  spaceLabel: string;
  score: { passed: number; total: number; percent: number | null; label: string; excluded?: number };
  cases: GenieAccuracyCaseView[];
}

function sideFromTrace(side: string, trace: RunTrace | null): SideScore {
  return {
    side,
    runId: trace?.runId ?? null,
    passed: trace?.benchmark?.passed ?? null,
    total: trace?.benchmark?.total ?? null,
    groundedness: trace?.benchmark?.groundedness ?? null,
    relevance: trace?.benchmark?.relevance ?? null,
    guidelines: null,
  };
}

function checkLabel(passed: boolean | null): string {
  if (passed === true) return 'Passed';
  if (passed === false) return 'Failed';
  return 'Not checked';
}

export function EvalFlywheel({
  onAgentRun,
  agentRunning,
  agentError,
}: {
  onAgentRun: () => void | Promise<string[]>;
  agentRunning: boolean;
  agentError: string | null;
}) {
  const [dataset, setDataset] = useState<EvalDataset>({ rows: [emptyEvalRow('q-new')] });
  const [datasetState, setDatasetState] = useState<'loading' | 'ready' | 'saving' | 'failed'>('loading');
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<ConnectedGenieSpace[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [genieRunning, setGenieRunning] = useState(false);
  const [genieError, setGenieError] = useState<string | null>(null);
  const [genieRun, setGenieRun] = useState<GenieAccuracyView | null>(null);
  const [judgeNote, setJudgeNote] = useState('');
  const [sides, setSides] = useState<string[]>(['current']);
  const [currentAgentEndpoint, setCurrentAgentEndpoint] = useState('');
  const [flywheel, setFlywheel] = useState<FlywheelState>(EMPTY_FLYWHEEL_STATE);
  const [compare, setCompare] = useState<{ baseline: SideScore; candidate: SideScore } | null>(null);
  const [promoteNote, setPromoteNote] = useState<string | null>(null);
  const [alignNote, setAlignNote] = useState<string | null>(null);
  const [curateCandidates, setCurateCandidates] = useState<string[]>([]);
  const [curatePicked, setCuratePicked] = useState<string[]>([]);
  const [curateNote, setCurateNote] = useState<string | null>(null);
  const [curateLoading, setCurateLoading] = useState(false);

  const loadFlywheel = useCallback(async () => {
    const response = await fetch('/api/benchmarks/flywheel');
    if (!response.ok) return EMPTY_FLYWHEEL_STATE;
    const body = (await response.json()) as { flywheel?: FlywheelState };
    return body.flywheel ?? EMPTY_FLYWHEEL_STATE;
  }, []);

  const loadCompare = useCallback(async (state: FlywheelState, namedSides: string[]) => {
    if (state.lastAgentRunIds.length === 0) {
      setCompare(null);
      return;
    }
    const traces = await Promise.all(
      state.lastAgentRunIds.map(async (id) => {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}/trace`);
        if (!response.ok) return null;
        return (await response.json()) as RunTrace;
      })
    );
    const baselineSide = namedSides[0] || state.lastAgentSides[0] || 'current';
    const candidateSide = namedSides[1] || state.lastAgentSides[1] || '';
    setCompare({
      baseline: sideFromTrace(baselineSide, traces[0] ?? null),
      candidate: sideFromTrace(candidateSide || baselineSide, traces[1] ?? traces[0] ?? null),
    });
  }, []);

  const load = useCallback(async () => {
    setDatasetState('loading');
    setDatasetError(null);
    try {
      const [datasetResponse, settingsResponse, connections, flywheelState] = await Promise.all([
        fetch('/api/benchmarks/dataset'),
        fetch('/api/benchmark-settings'),
        fetch('/api/settings'),
        loadFlywheel(),
      ]);
      if (!datasetResponse.ok) throw new Error('The evaluation dataset could not be read.');
      const body = (await datasetResponse.json()) as { dataset?: EvalDataset };
      const rows = Array.isArray(body.dataset?.rows) ? body.dataset.rows : [];
      setDataset({ rows: rows.length > 0 ? rows : [emptyEvalRow('q-new')] });
      setFlywheel(flywheelState);
      if (settingsResponse.ok) {
        const loaded = await benchmarkSettingsFromResponse(settingsResponse, 'loaded');
        const named = compareSides(loaded.settings);
        setSides(named);
        setCurrentAgentEndpoint(loaded.currentAgentEndpoint);
        const judges = loaded.settings.enabledJudges.join(', ');
        setJudgeNote(
          `Phase B uses ${loaded.settings.judgeEndpoint} in experiment ${loaded.settings.experimentId || '(the one already configured)'} · ${judges}. ${
            named.length > 1
              ? `Will compare ${named.join(' and ')} on the same questions.`
              : 'Add a candidate endpoint in Settings → Experimental to compare two versions.'
          }`
        );
        await loadCompare(flywheelState, named);
      } else {
        setJudgeNote(
          `Phase B uses ${DEFAULT_BENCHMARK_SETTINGS.judgeEndpoint}. Change that in Settings → Experimental.`
        );
      }
      if (connections.ok) {
        const payload = (await connections.json()) as { resources?: ResourceRow[] };
        const found = connectedGenieSpaces(payload.resources ?? []);
        setSpaces(found);
        setSpaceId((current) => current || flywheelState.lastSuite?.spaceId || found[0]?.id || '');
      }
      setDatasetState('ready');
    } catch (caught) {
      setDatasetState('failed');
      setDatasetError((caught as Error).message);
    }
  }, [loadCompare, loadFlywheel]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDataset = async (next: EvalDataset) => {
    setDataset(next);
    setDatasetState('saving');
    setDatasetError(null);
    try {
      const response = await fetch('/api/admin/benchmarks/dataset', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!response.ok) {
        const refusal = (await response.json().catch(() => null)) as { detail?: unknown } | null;
        throw new Error(typeof refusal?.detail === 'string' ? refusal.detail : 'The dataset could not be saved.');
      }
      const body = (await response.json()) as { dataset?: EvalDataset };
      if (body.dataset) setDataset(body.dataset.rows.length > 0 ? body.dataset : { rows: [emptyEvalRow('q-new')] });
      setDatasetState('ready');
    } catch (caught) {
      setDatasetState('failed');
      setDatasetError((caught as Error).message);
    }
  };

  const updateRow = (id: string, patch: Partial<EvalRow>) => {
    void saveDataset({
      rows: dataset.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });
  };

  const addRow = () => {
    void saveDataset({ rows: [...dataset.rows, emptyEvalRow(newEvalRowId())] });
  };

  const loadStarter = () => {
    void saveDataset(starterEvalDataset());
  };

  const runGenie = async (overrideSpaceId?: string) => {
    const chosen = overrideSpaceId || spaceId;
    if (!chosen) {
      setGenieError('Pick a connected Genie space first.');
      return;
    }
    setGenieRunning(true);
    setGenieError(null);
    try {
      const space = spaces.find((entry) => entry.id === chosen);
      const response = await fetch('/api/benchmarks/genie-accuracy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spaceId: chosen, spaceLabel: space?.label }),
      });
      const body = (await response.json().catch(() => null)) as
        | { run?: GenieAccuracyView; message?: unknown }
        | null;
      if (!response.ok) {
        throw new Error(typeof body?.message === 'string' ? body.message : 'Genie accuracy could not be started.');
      }
      if (!body?.run) throw new Error('Genie accuracy returned no result. No score was invented.');
      setGenieRun(body.run);
      const next = await loadFlywheel();
      setFlywheel(next);
    } catch (caught) {
      setGenieError((caught as Error).message);
    } finally {
      setGenieRunning(false);
    }
  };

  const rememberAgentSuite = async (runIds: string[]) => {
    await fetch('/api/admin/benchmarks/last-suite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'agent',
        spaceId: spaceId,
        spaceLabel: spaces.find((entry) => entry.id === spaceId)?.label ?? '',
        at: new Date().toISOString(),
        runIds,
        sides,
      }),
    });
    const next = await loadFlywheel();
    setFlywheel(next);
    await loadCompare(next, sides);
  };

  const runAgent = async () => {
    const runIds = await onAgentRun();
    if (Array.isArray(runIds) && runIds.length > 0) {
      await rememberAgentSuite(runIds);
    }
  };

  const rerunLastSuite = async () => {
    if (!flywheel.lastSuite) {
      setGenieError('Run a suite once first. This button repeats that run on the same questions.');
      return;
    }
    if (flywheel.lastSuite.kind === 'genie') {
      if (flywheel.lastSuite.spaceId) setSpaceId(flywheel.lastSuite.spaceId);
      await runGenie(flywheel.lastSuite.spaceId || spaceId);
      return;
    }
    await runAgent();
  };

  const promote = async (which: 'baseline' | 'candidate') => {
    const sideName = which === 'baseline' ? sides[0] || 'current' : sides[1] || '';
    const endpoint = sideName === 'current' || !sideName ? currentAgentEndpoint : sideName;
    if (!endpoint) {
      setPromoteNote('There is no named endpoint to promote yet. Add a candidate in Settings → Experimental.');
      return;
    }
    setPromoteNote(null);
    const response = await fetch('/api/admin/benchmarks/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint,
        side: which,
        at: new Date().toISOString(),
        note: which === 'candidate' ? 'Promoted the candidate for the next Ask.' : 'Promoted the baseline for the next Ask.',
      }),
    });
    const body = (await response.json().catch(() => null)) as { flywheel?: FlywheelState; message?: unknown } | null;
    if (!response.ok) {
      setPromoteNote(typeof body?.message === 'string' ? body.message : 'The winner was not saved.');
      return;
    }
    if (body?.flywheel) setFlywheel(body.flywheel);
    setPromoteNote(`Next Ask will use ${endpoint}. Genie space instructions cannot be written from this app.`);
  };

  const alignGuidelines = async () => {
    setAlignNote(null);
    const response = await fetch('/api/admin/benchmarks/align-guidelines', { method: 'POST' });
    const body = (await response.json().catch(() => null)) as { labeled?: number; message?: unknown } | null;
    if (!response.ok) {
      setAlignNote(typeof body?.message === 'string' ? body.message : 'Guidelines were not updated.');
      return;
    }
    setAlignNote(
      `Guidelines now include ${body?.labeled ?? labeledRowCount(dataset.rows)} labelled row(s). The next Phase B run uses them.`
    );
  };

  const loadCurateCandidates = async () => {
    setCurateLoading(true);
    setCurateNote(null);
    try {
      const [runsResponse, monitoringResponse] = await Promise.all([
        fetch('/api/runs'),
        fetch('/api/monitoring/questions'),
      ]);
      const questions: string[] = [];
      if (runsResponse.ok) {
        const runs = (await runsResponse.json()) as Run[];
        for (const run of runs) {
          if (run.kind === 'conversation' && run.prompt?.trim()) questions.push(run.prompt.trim());
        }
      }
      if (monitoringResponse.ok) {
        const payload = (await monitoringResponse.json()) as MonitoringQuestionsPayload;
        for (const row of payload.questions ?? []) {
          if (row.question?.trim()) questions.push(row.question.trim());
        }
      } else if (monitoringResponse.status === 403) {
        setCurateNote('Monitoring questions are admin-only. Ask questions from this page still appear.');
      }
      const existing = new Set(dataset.rows.map((row) => row.question.trim().toLowerCase()).filter(Boolean));
      const unique = [...new Set(questions)].filter((question) => !existing.has(question.toLowerCase()));
      setCurateCandidates(unique);
      setCuratePicked(unique.slice(0, 10));
      if (unique.length === 0) {
        setCurateNote((current) => current ?? 'No new questions in Ask or Monitoring. Ask something first, then come back.');
      }
    } catch (caught) {
      setCurateNote((caught as Error).message);
    } finally {
      setCurateLoading(false);
    }
  };

  const addCurated = async () => {
    if (curatePicked.length === 0) return;
    const response = await fetch('/api/admin/benchmarks/dataset/curate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questions: curatePicked }),
    });
    const body = (await response.json().catch(() => null)) as { dataset?: EvalDataset; added?: number; detail?: unknown } | null;
    if (!response.ok) {
      setCurateNote(typeof body?.detail === 'string' ? body.detail : 'Those questions were not added.');
      return;
    }
    if (body?.dataset) setDataset(body.dataset.rows.length > 0 ? body.dataset : { rows: [emptyEvalRow('q-new')] });
    setCurateCandidates([]);
    setCuratePicked([]);
    setCurateNote(`Added ${body?.added ?? 0} question(s) from traces. Add ground-truth SQL when you have it.`);
  };

  const counts = datasetCounts(dataset.rows);
  const sqlReady = counts.sqlBacked > 0;
  const agentReady = counts.questions > 0;
  const labeled = labeledRowCount(dataset.rows);
  const winner = compare ? pickWinner(compare.baseline, compare.candidate) : null;
  const lastSuiteLabel = flywheel.lastSuite
    ? flywheel.lastSuite.kind === 'genie'
      ? `Genie accuracy on ${flywheel.lastSuite.spaceLabel || 'the last space'}`
      : 'Agent judges on the same dataset'
    : null;

  return (
    <div className="eval-flywheel">
      <ol className="eval-steps">
        <li>
          <strong>1. Dataset</strong> Add questions, or pull them from real Ask / Monitoring turns.
        </li>
        <li>
          <strong>2. Genie accuracy</strong> Run SQL-backed rows. A warehouse still starting is not scored as Genie wrong.
        </li>
        <li>
          <strong>3. Agent judges</strong> Same questions, two versions if you set a candidate, then promote the winner.
        </li>
      </ol>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evaluation dataset</CardTitle>
          <CardDescription>
            {datasetSizeLabel(counts)}. {counts.sqlBacked} with ground-truth SQL · {counts.expectedAnswer} with an
            expected answer · {labeled} labelled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {datasetError ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{datasetError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="eval-dataset-rows">
            {dataset.rows.map((row, index) => (
              <div className="eval-dataset-row" key={row.id}>
                <p className="eval-dataset-row-label">Question {index + 1}</p>
                <Input
                  aria-label={`Question ${index + 1}`}
                  placeholder="The question to ask"
                  value={row.question}
                  onChange={(event) =>
                    setDataset((current) => ({
                      rows: current.rows.map((entry) =>
                        entry.id === row.id ? { ...entry, question: event.target.value } : entry
                      ),
                    }))
                  }
                  onBlur={(event) => updateRow(row.id, { question: event.target.value })}
                />
                <Textarea
                  aria-label={`Ground-truth SQL ${index + 1}`}
                  placeholder="Ground-truth SQL (Genie accuracy)"
                  rows={2}
                  value={row.groundTruthSql}
                  onChange={(event) =>
                    setDataset((current) => ({
                      rows: current.rows.map((entry) =>
                        entry.id === row.id ? { ...entry, groundTruthSql: event.target.value } : entry
                      ),
                    }))
                  }
                  onBlur={(event) => updateRow(row.id, { groundTruthSql: event.target.value })}
                />
                <Textarea
                  aria-label={`Expected answer ${index + 1}`}
                  placeholder="Expected answer (agent judges)"
                  rows={2}
                  value={row.expectedAnswer}
                  onChange={(event) =>
                    setDataset((current) => ({
                      rows: current.rows.map((entry) =>
                        entry.id === row.id ? { ...entry, expectedAnswer: event.target.value } : entry
                      ),
                    }))
                  }
                  onBlur={(event) => updateRow(row.id, { expectedAnswer: event.target.value })}
                />
                <div className="eval-row-labels">
                  <span className="eval-row-labels-title">SQL correct?</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={row.sqlCorrect === 'yes' ? 'default' : 'outline'}
                    aria-pressed={row.sqlCorrect === 'yes'}
                    onClick={() => updateRow(row.id, { sqlCorrect: row.sqlCorrect === 'yes' ? '' : 'yes' })}
                  >
                    Yes
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={row.sqlCorrect === 'no' ? 'default' : 'outline'}
                    aria-pressed={row.sqlCorrect === 'no'}
                    onClick={() => updateRow(row.id, { sqlCorrect: row.sqlCorrect === 'no' ? '' : 'no' })}
                  >
                    No
                  </Button>
                  <span className="eval-row-labels-title">Answer</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={row.thumbs === 'up' ? 'default' : 'outline'}
                    aria-label={`Thumbs up question ${index + 1}`}
                    aria-pressed={row.thumbs === 'up'}
                    onClick={() => updateRow(row.id, { thumbs: row.thumbs === 'up' ? '' : 'up' })}
                  >
                    <ThumbsUp />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={row.thumbs === 'down' ? 'default' : 'outline'}
                    aria-label={`Thumbs down question ${index + 1}`}
                    aria-pressed={row.thumbs === 'down'}
                    onClick={() => updateRow(row.id, { thumbs: row.thumbs === 'down' ? '' : 'down' })}
                  >
                    <ThumbsDown />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="eval-dataset-actions">
            <Button type="button" variant="outline" onClick={addRow} disabled={datasetState === 'saving'}>
              <Plus />
              Add a question
            </Button>
            <Button type="button" variant="outline" onClick={loadStarter} disabled={datasetState === 'saving'}>
              Load the six demo questions
            </Button>
            <Button type="button" variant="outline" onClick={() => void loadCurateCandidates()} disabled={curateLoading}>
              {curateLoading ? <Loader2 className="animate-spin" /> : null}
              Pull questions from Ask and Monitoring
            </Button>
            <Button type="button" variant="outline" onClick={() => void alignGuidelines()} disabled={labeled === 0}>
              Align guidelines from labels
            </Button>
            {datasetState === 'saving' ? <span className="settings-row-note">Saving…</span> : null}
          </div>
          {alignNote ? <p className="settings-row-note">{alignNote}</p> : null}
          {curateNote ? <p className="settings-row-note">{curateNote}</p> : null}
          {curateCandidates.length > 0 ? (
            <div className="eval-curate">
              <p className="settings-row-note">Pick the real questions to add. Ground-truth SQL stays blank until you write it.</p>
              <ul className="eval-curate-list">
                {curateCandidates.map((question) => (
                  <li key={question}>
                    <label>
                      <input
                        type="checkbox"
                        checked={curatePicked.includes(question)}
                        onChange={(event) =>
                          setCuratePicked((current) =>
                            event.target.checked ? [...current, question] : current.filter((entry) => entry !== question)
                          )
                        }
                      />
                      {question}
                    </label>
                  </li>
                ))}
              </ul>
              <Button type="button" onClick={() => void addCurated()} disabled={curatePicked.length === 0}>
                Add {curatePicked.length} to the dataset
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Phase A · Genie accuracy</CardTitle>
          <CardDescription>
            Ask one connected Genie space each question that has ground-truth SQL. Re-run after you change
            that space&apos;s instructions or tables — the questions stay put.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {spaces.length === 0 ? (
            <p className="settings-row-note">
              No Genie space is connected yet. Connect one on Connections, then come back.
            </p>
          ) : (
            <label className="runtime-field runtime-field-wide">
              <span className="runtime-field-label">Genie space</span>
              <select
                aria-label="Genie space"
                className="eval-space-select"
                value={spaceId}
                onChange={(event) => setSpaceId(event.target.value)}
              >
                {spaces.map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="eval-dataset-actions">
            <Button type="button" onClick={() => void runGenie()} disabled={genieRunning || !sqlReady || !spaceId}>
              {genieRunning ? <Loader2 className="animate-spin" /> : <Play />}
              {genieRunning ? 'Asking Genie…' : 'Run Genie accuracy'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void rerunLastSuite()}
              disabled={genieRunning || agentRunning || !flywheel.lastSuite}
            >
              <RefreshCw />
              Re-run last suite
            </Button>
          </div>
          {lastSuiteLabel ? <p className="settings-row-note">Last suite: {lastSuiteLabel}.</p> : null}
          {!sqlReady ? (
            <p className="settings-row-note">Add ground-truth SQL to at least one question to run this.</p>
          ) : null}
          {genieError ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{genieError}</AlertDescription>
            </Alert>
          ) : null}
          {genieRun ? (
            <div className="eval-accuracy">
              <p className="eval-accuracy-score">
                <strong className="ast-num">{genieRun.score.label}</strong>
                <span>
                  {genieRun.spaceLabel} · {genieRun.score.passed} passed of {genieRun.score.total} scored
                  {genieRun.score.excluded ? ` · ${genieRun.score.excluded} not scored (warehouse or timeout)` : ''}
                </span>
              </p>
              <ul className="eval-accuracy-cases">
                {genieRun.cases.map((entry) => (
                  <li key={entry.id}>
                    <strong>
                      {entry.excluded
                        ? genieMissLabel(entry.missKind ?? 'error')
                        : entry.outcome === 'pass'
                          ? 'Passed'
                          : entry.outcome === 'fail'
                            ? 'Failed'
                            : 'Could not score'}
                    </strong>
                    {' · '}
                    {entry.question} {entry.note ? `— ${entry.note}` : ''}
                    {entry.checks && entry.checks.length > 0 ? (
                      <ul className="eval-checks">
                        {entry.checks.map((check) => (
                          <li key={check.id}>
                            {check.label}: {checkLabel(check.passed)} — {check.note}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {flywheel.history.length > 0 ? (
            <div className="eval-history">
              <p className="eval-history-title">Accuracy history</p>
              <ul>
                {flywheel.history.map((entry) => (
                  <li key={`${entry.at}-${entry.spaceId}`}>{historyLine(entry)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Phase B · Agent judges</CardTitle>
          <CardDescription>
            Same dataset, scored by built-in MLflow judges (groundedness, relevance, guidelines). Multi-turn and
            custom judges are not wired yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="settings-row-note">{judgeNote || 'Judge defaults load from Settings → Experimental.'}</p>
          <p className="settings-row-note">
            This starts a real agent run ({OPERATOR_EVAL_SUITE_ID}), not a placeholder score. It takes several
            minutes. Results land in the recorded runs below.
          </p>
          <Button type="button" onClick={() => void runAgent()} disabled={agentRunning || !agentReady}>
            {agentRunning ? <Loader2 className="animate-spin" /> : <Play />}
            {agentRunning ? 'Starting…' : sides.length > 1 ? 'Run baseline and candidate' : 'Run agent judges'}
          </Button>
          {!agentReady ? (
            <p className="settings-row-note">Add at least one question before running the agent.</p>
          ) : null}
          {agentError ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{agentError}</AlertDescription>
            </Alert>
          ) : null}
          {compare && (compare.baseline.runId || compare.candidate.runId) ? (
            <div className="eval-compare">
              <p className="eval-compare-summary">{compareSidesSummary(compare.baseline, compare.candidate)}</p>
              <div className="eval-compare-grid">
                <div>
                  <p className="eval-compare-side">Baseline · {compare.baseline.side}</p>
                  <p className="ast-num">
                    {compare.baseline.passed ?? '—'}/{compare.baseline.total ?? '—'}
                  </p>
                  <p className="settings-row-note">
                    Groundedness {compare.baseline.groundedness ?? '—'} · Relevance {compare.baseline.relevance ?? '—'}
                  </p>
                  <Button type="button" variant="outline" onClick={() => void promote('baseline')}>
                    Use baseline for the next Ask
                  </Button>
                </div>
                <div>
                  <p className="eval-compare-side">Candidate · {compare.candidate.side || 'same run'}</p>
                  <p className="ast-num">
                    {compare.candidate.passed ?? '—'}/{compare.candidate.total ?? '—'}
                  </p>
                  <p className="settings-row-note">
                    Groundedness {compare.candidate.groundedness ?? '—'} · Relevance {compare.candidate.relevance ?? '—'}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void promote('candidate')}
                    disabled={sides.length < 2}
                  >
                    Use candidate for the next Ask
                  </Button>
                </div>
              </div>
              {winner === 'candidate' ? (
                <p className="settings-row-note">Candidate scored higher on the same questions.</p>
              ) : winner === 'baseline' ? (
                <p className="settings-row-note">Baseline scored higher on the same questions.</p>
              ) : winner === 'tie' ? (
                <p className="settings-row-note">The two runs tied. Pick which one the next Ask should use.</p>
              ) : null}
            </div>
          ) : null}
          {flywheel.promoted?.endpoint ? (
            <p className="settings-row-note">
              Next Ask uses <strong>{flywheel.promoted.endpoint}</strong>
              {flywheel.promoted.side ? ` (${flywheel.promoted.side})` : ''}. This does not change Connections, and it
              cannot write Genie space instructions.
            </p>
          ) : null}
          {promoteNote ? <p className="settings-row-note">{promoteNote}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
