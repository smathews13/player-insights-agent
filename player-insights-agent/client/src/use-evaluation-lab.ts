import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_LAB_STATE,
  evalRowPatchFromLabCase,
  labWorkspacePayload,
  type ImportFilter,
  type LabWorkspace,
  type SuiteKind,
} from '../../shared/benchmark-lab-v3';
import { parseGenieAccuracyRun, type GenieAccuracyRunView } from '../../shared/eval-genie-run';
import { EMPTY_FLYWHEEL_STATE, type FlywheelState } from '../../shared/eval-flywheel';
import { importReasonsFromTrace, matchesImportFilters } from '../../shared/eval-import';
import { starterEvalDataset } from '../../shared/eval-dataset';
import type { Run } from './app-types';
import type { MonitoringQuestionsPayload } from '../../shared/monitoring-contract';
import type { LiveTraceScore } from '../../shared/eval-live-scoring';
import type { ResourceRow } from './connection-model';
import { connectedGenieSpaces, type ConnectedGenieSpace } from './eval-spaces';
import {
  assignLabSplit,
  commitLabDatasetVersion,
  commitLabGuidelines,
  duplicateLabEdgeCase,
  fetchLabBundle,
  importLabTraces,
  previewLabGuidelines,
  reviewLabCase,
  runGenieAccuracySuite,
  saveLabDataset,
} from './benchmark-lab-api';

export type EvaluationLabModel = {
  lab: LabWorkspace;
  lastGenieRun: GenieAccuracyRunView | null;
  lastSuiteKind: SuiteKind;
  spaces: ConnectedGenieSpace[];
  spaceId: string;
  setSpaceId: (id: string) => void;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  reviewerOnly: boolean;
  setReviewerOnly: (value: boolean) => void;
  expandedId: string;
  setExpandedId: (id: string) => void;
  importFilters: ImportFilter[];
  setImportFilters: (filters: ImportFilter[]) => void;
  candidates: { question: string; sourceTraceId: string; reasons: ImportFilter[] }[];
  picked: string[];
  setPicked: (questions: string[]) => void;
  alignDraft: string;
  setAlignDraft: (value: string) => void;
  notice: string | null;
  error: string | null;
  busy: string | null;
  reload: () => Promise<void>;
  commitVersion: () => Promise<void>;
  loadImportCandidates: () => Promise<void>;
  importPicked: () => Promise<void>;
  addSamples: () => Promise<void>;
  assignSplit: (split: 'tuning' | 'held_out') => Promise<void>;
  duplicateSelected: () => Promise<void>;
  saveCase: (caseId: string, patch: Record<string, string | boolean>) => Promise<void>;
  setReview: (caseId: string, review: LabWorkspace['cases'][number]['review']) => Promise<void>;
  previewAlign: () => Promise<void>;
  commitAlign: () => Promise<void>;
  runSuite: (kind: SuiteKind) => Promise<void>;
  rerunLast: () => Promise<void>;
  setLab: (lab: LabWorkspace) => void;
};

const EMPTY_LAB = labWorkspacePayload({ rows: [], state: EMPTY_LAB_STATE, enabledJudges: [] });

export function useEvaluationLab(): EvaluationLabModel {
  const [lab, setLab] = useState<LabWorkspace>(EMPTY_LAB);
  const [lastGenieRun, setLastGenieRun] = useState<GenieAccuracyRunView | null>(null);
  const [flywheel, setFlywheel] = useState<FlywheelState>(EMPTY_FLYWHEEL_STATE);
  const [spaces, setSpaces] = useState<ConnectedGenieSpace[]>([]);
  const [spaceId, setSpaceId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reviewerOnly, setReviewerOnly] = useState(false);
  const [expandedId, setExpandedId] = useState('');
  const [importFilters, setImportFilters] = useState<ImportFilter[]>(['low_judge_score', 'tool_failure', 'latency', 'customer_feedback']);
  const [candidates, setCandidates] = useState<EvaluationLabModel['candidates']>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [alignDraft, setAlignDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [bundle, connections, flywheelResponse] = await Promise.all([
        fetchLabBundle(),
        fetch('/api/settings'),
        fetch('/api/benchmarks/flywheel'),
      ]);
      setLab(bundle.lab);
      setLastGenieRun(bundle.lastGenieRun);
      if (flywheelResponse.ok) {
        const body = (await flywheelResponse.json()) as { flywheel?: FlywheelState };
        const next = body.flywheel ?? EMPTY_FLYWHEEL_STATE;
        setFlywheel(next);
        setSpaceId((current) => current || next.lastSuite?.spaceId || '');
      }
      if (connections.ok) {
        const payload = (await connections.json()) as { resources?: ResourceRow[] };
        const found = connectedGenieSpaces(payload.resources ?? []);
        setSpaces(found);
        setSpaceId((current) => current || found[0]?.id || '');
      }
      setAlignDraft(bundle.lab.alignPreview?.preview ?? '');
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(
    async (label: string, work: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        await work();
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setBusy(null);
      }
    },
    []
  );

  const lastSuiteKind: SuiteKind = lastGenieRun?.suiteKind === 'partial' ? 'partial' : 'complete';

  return {
    lab,
    lastGenieRun,
    lastSuiteKind,
    spaces,
    spaceId,
    setSpaceId,
    selectedIds,
    setSelectedIds,
    reviewerOnly,
    setReviewerOnly,
    expandedId,
    setExpandedId,
    importFilters,
    setImportFilters,
    candidates,
    picked,
    setPicked,
    alignDraft,
    setAlignDraft,
    notice,
    error,
    busy,
    reload,
    setLab,
    commitVersion: () =>
      run('version', async () => {
        setLab(await commitLabDatasetVersion());
        setNotice('A new dataset version was saved. Earlier versions stay immutable.');
      }),
    loadImportCandidates: () =>
      run('import', async () => {
        const [runsResponse, monitoringResponse, liveResponse] = await Promise.all([
          fetch('/api/runs'),
          fetch('/api/monitoring/questions'),
          fetch('/api/benchmarks/live-scores'),
        ]);
        const found: EvaluationLabModel['candidates'] = [];
        const seen = new Set(lab.cases.map((row) => row.question.trim().toLowerCase()).filter(Boolean));
        const push = (question: string, sourceTraceId: string, reasons: ImportFilter[]) => {
          const key = question.trim().toLowerCase();
          if (!key || seen.has(key) || !matchesImportFilters(reasons, importFilters)) return;
          seen.add(key);
          found.push({ question: question.trim(), sourceTraceId, reasons });
        };
        if (runsResponse.ok) {
          const runs = (await runsResponse.json()) as Run[];
          for (const entry of runs) {
            if (entry.kind !== 'conversation' || !entry.prompt?.trim()) continue;
            push(
              entry.prompt,
              entry.id,
              importReasonsFromTrace({
                question: entry.prompt,
                sourceTraceId: entry.id,
                durationMs: entry.duration_ms,
                outcome: entry.status,
              })
            );
          }
        }
        if (monitoringResponse.ok) {
          const payload = (await monitoringResponse.json()) as MonitoringQuestionsPayload;
          for (const row of payload.questions ?? []) {
            push(
              row.question,
              row.id,
              importReasonsFromTrace({
                question: row.question,
                sourceTraceId: row.id,
                durationMs: row.durationMs,
                outcome: row.outcome,
                rating: row.rating,
                toolCalls: row.toolCalls,
              })
            );
          }
        }
        if (liveResponse.ok) {
          const live = (await liveResponse.json()) as { scores?: LiveTraceScore[] };
          for (const score of live.scores ?? []) {
            push(
              score.question,
              score.traceId || score.id,
              importReasonsFromTrace({
                question: score.question,
                sourceTraceId: score.traceId || score.id,
                judges: score.judges,
              })
            );
          }
        }
        setCandidates(found);
        setPicked(found.map((entry) => entry.question));
        setNotice(
          found.length === 0
            ? 'No matching Ask or Monitoring turns. The filters only keep low judge score, tool failure, latency, or customer feedback.'
            : `${found.length} matching turn(s). Ground-truth SQL stays blank until you write it.`
        );
      }),
    importPicked: () =>
      run('import', async () => {
        setLab(await importLabTraces(picked, importFilters));
        setCandidates([]);
        setPicked([]);
        setNotice(`Imported ${picked.length} question(s) from traces.`);
      }),
    addSamples: () =>
      run('samples', async () => {
        setLab(await saveLabDataset(starterEvalDataset().rows));
        setNotice('Sample questions added. They have no ground-truth SQL yet.');
      }),
    assignSplit: (split) =>
      run('split', async () => {
        const ids = selectedIds.length > 0 ? selectedIds : lab.cases.filter((row) => !row.retired).map((row) => row.id);
        setLab(await assignLabSplit(ids, split));
        setNotice(`Assigned ${ids.length} case(s) to ${split === 'held_out' ? 'held-out' : 'tuning'}.`);
      }),
    duplicateSelected: () =>
      run('duplicate', async () => {
        const caseId = selectedIds[0] || expandedId;
        if (!caseId) {
          setError('Select a case to duplicate as an edge case.');
          return;
        }
        setLab(await duplicateLabEdgeCase(caseId));
        setNotice('Duplicated as an edge case on the tuning split.');
      }),
    saveCase: (caseId, patch) =>
      run('save', async () => {
        const rows = lab.cases.map((row) => {
          const next = row.id === caseId ? { ...row, ...patch } : row;
          return evalRowPatchFromLabCase(next);
        });
        setLab(await saveLabDataset(rows));
      }),
    setReview: (caseId, review) =>
      run('review', async () => {
        setLab(await reviewLabCase(caseId, review));
      }),
    previewAlign: () =>
      run('align', async () => {
        const preview = await previewLabGuidelines();
        setAlignDraft(preview.preview);
        setNotice(`Preview from ${preview.labeled} labelled row(s). Nothing is saved until you confirm.`);
        await reload();
      }),
    commitAlign: () =>
      run('align', async () => {
        if (!alignDraft.trim()) {
          setError('Preview the aligned guidelines first. They save only after review.');
          return;
        }
        setLab(await commitLabGuidelines(alignDraft));
        setNotice('Guidelines saved after review. The next judge run uses them.');
      }),
    runSuite: (kind) =>
      run('genie', async () => {
        const space = spaces.find((entry) => entry.id === spaceId);
        if (!spaceId) {
          setError('Pick a connected Genie space first.');
          return;
        }
        const runResult = await runGenieAccuracySuite({
          spaceId,
          spaceLabel: space?.label,
          suiteKind: kind,
          caseIds: selectedIds.length > 0 ? selectedIds : undefined,
        });
        setLastGenieRun(runResult);
        setNotice(
          kind === 'complete' ? 'Complete suite finished. Matching is executed-result equivalence.' : 'Partial suite finished. Excluded cases stay out of the denominator.'
        );
        await reload();
      }),
    rerunLast: () =>
      run('genie', async () => {
        const chosen = lastGenieRun?.spaceId || flywheel.lastSuite?.spaceId || spaceId;
        if (!chosen) {
          setError('Run a suite once first. This button repeats that run on the same questions.');
          return;
        }
        setSpaceId(chosen);
        const space = spaces.find((entry) => entry.id === chosen);
        const runResult = await runGenieAccuracySuite({
          spaceId: chosen,
          spaceLabel: space?.label || lastGenieRun?.spaceLabel || flywheel.lastSuite?.spaceLabel,
          suiteKind: lastSuiteKind,
          caseIds: selectedIds.length > 0 ? selectedIds : undefined,
        });
        setLastGenieRun(parseGenieAccuracyRun(runResult) ?? runResult);
        setNotice('Re-ran the last suite on the same questions.');
        await reload();
      }),
  };
}
