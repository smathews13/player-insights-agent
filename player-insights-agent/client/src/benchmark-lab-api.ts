import { parseGenieAccuracyRun, type GenieAccuracyRunView } from '../../shared/eval-genie-run';
import type { EvalRowLike, ImportFilter, LabWorkspace, SuiteKind } from '../../shared/benchmark-lab-v3';

/**
 * Fetch helpers for Benchmark Lab v3. UI surfaces import these rather than
 * talking to /api/benchmarks/lab with ad hoc JSON.
 */

type FailureBody = {
  detail?: unknown;
  message?: unknown;
  decision?: { note?: unknown };
  apply?: { note?: unknown };
};

function nestedNote(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const note = (value as { note?: unknown }).note;
  return typeof note === 'string' && note.trim() ? note.trim() : '';
}

function serverDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const failure = body as FailureBody;
  const fromApply = nestedNote(failure.decision) || nestedNote(failure.apply);
  if (fromApply) return fromApply;
  if (typeof failure.detail === 'string' && failure.detail.trim()) return failure.detail.trim();
  if (typeof failure.message === 'string' && failure.message.trim()) return failure.message.trim();
  return '';
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? `The lab ${operation} returned an unreadable response.`
        : `The lab ${operation} answered ${response.status} without an error message.`
    );
  }
  if (!response.ok) {
    throw new Error(serverDetail(body) || `The lab ${operation} answered ${response.status}.`);
  }
  return body;
}

export function labFromPayload(body: unknown): LabWorkspace {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const lab = record.lab;
  if (!lab || typeof lab !== 'object' || !Array.isArray((lab as { cases?: unknown }).cases)) {
    throw new Error('The lab payload was missing cases.');
  }
  return lab as LabWorkspace;
}

export async function fetchLabWorkspace(): Promise<LabWorkspace> {
  const response = await fetch('/api/benchmarks/lab');
  return labFromPayload(await readJson(response, 'workspace'));
}

export async function commitLabDatasetVersion(): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/version', { method: 'POST' });
  return labFromPayload(await readJson(response, 'version'));
}

export async function assignLabSplit(caseIds: string[], split: 'tuning' | 'held_out'): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseIds, split }),
  });
  return labFromPayload(await readJson(response, 'split'));
}

export async function duplicateLabEdgeCase(caseId: string): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/duplicate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId }),
  });
  return labFromPayload(await readJson(response, 'duplicate'));
}

export async function previewLabGuidelines(): Promise<{ preview: string; labeled: number; saved: false }> {
  const response = await fetch('/api/admin/benchmarks/lab/align-preview', { method: 'POST' });
  const body = (await readJson(response, 'align preview')) as { preview?: { preview?: string; labeled?: number } };
  return {
    preview: body.preview?.preview ?? '',
    labeled: body.preview?.labeled ?? 0,
    saved: false,
  };
}

export async function commitLabGuidelines(preview: string): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/align-commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview }),
  });
  return labFromPayload(await readJson(response, 'align commit'));
}

export async function applyLabCandidate(input: {
  approver: string;
  candidateRunId?: string;
  agentEndpoint?: string;
  target?: LabWorkspace['contract']['target'];
  gates?: { passed: number; total: number; checks: { id: string; label: string; passed: boolean; detail: string }[] };
}): Promise<{
  lab: LabWorkspace;
  wroteGenieInstructions: false;
  connectionsChanged: false;
  status?: string;
  note?: string;
}> {
  const response = await fetch('/api/admin/benchmarks/lab/apply-candidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await readJson(response, 'apply')) as {
    lab?: unknown;
    decision?: { wroteGenieInstructions?: boolean; connectionsChanged?: boolean; status?: string; note?: string };
    apply?: { wroteGenieInstructions?: boolean; connectionsChanged?: boolean; note?: string };
  };
  return {
    lab: labFromPayload(body),
    wroteGenieInstructions: false,
    connectionsChanged: false,
    status: body.decision?.status,
    note: body.decision?.note || body.apply?.note,
  };
}

export async function requestLabRunCancel(runId?: string): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/cancel-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
  return labFromPayload(await readJson(response, 'cancel'));
}

export async function fetchLabBundle(): Promise<{ lab: LabWorkspace; lastGenieRun: GenieAccuracyRunView | null }> {
  const response = await fetch('/api/benchmarks/lab');
  const body = (await readJson(response, 'workspace')) as { lastGenieRun?: unknown };
  return { lab: labFromPayload(body), lastGenieRun: parseGenieAccuracyRun(body.lastGenieRun) };
}

export async function saveLabDataset(rows: readonly EvalRowLike[]): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/dataset', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  await readJson(response, 'dataset save');
  return (await fetchLabBundle()).lab;
}

export async function importLabTraces(questions: readonly string[], filters: readonly ImportFilter[]): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/import-traces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions, filters }),
  });
  return labFromPayload(await readJson(response, 'import'));
}

export async function reviewLabCase(caseId: string, review: LabWorkspace['cases'][number]['review']): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId, review }),
  });
  return labFromPayload(await readJson(response, 'review'));
}

export async function runGenieAccuracySuite(input: {
  spaceId: string;
  spaceLabel?: string;
  suiteKind: SuiteKind;
  caseIds?: readonly string[];
}): Promise<GenieAccuracyRunView> {
  const response = await fetch('/api/benchmarks/genie-accuracy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await readJson(response, 'Genie accuracy')) as { run?: unknown };
  const run = parseGenieAccuracyRun(body.run);
  if (!run) throw new Error('Genie accuracy returned no result. No score was invented.');
  return run;
}

export async function markLabKnownFailure(caseId: string, note = ''): Promise<LabWorkspace> {
  const response = await fetch('/api/admin/benchmarks/lab/known-failure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId, note }),
  });
  return labFromPayload(await readJson(response, 'known failure'));
}

export async function cancelJudgeRun(runId: string): Promise<void> {
  const response = await fetch('/api/admin/benchmarks/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
  await readJson(response, 'cancel');
  try {
    await requestLabRunCancel(runId);
  } catch {
    // Lab contract flag is secondary. The runner cancel is what stops the suite.
  }
}

export async function scoreAskSession(): Promise<{ conversationId: string; turnCount: number }> {
  const response = await fetch('/api/admin/benchmarks/score-thread', { method: 'POST' });
  const body = (await readJson(response, 'Ask session score')) as {
    conversationId?: unknown;
    turnCount?: unknown;
  };
  return {
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : '',
    turnCount: typeof body.turnCount === 'number' ? body.turnCount : 0,
  };
}

export async function rollbackPromotedAsk(): Promise<{ endpoint: string }> {
  const response = await fetch('/api/admin/benchmarks/rollback', { method: 'POST' });
  const body = (await readJson(response, 'rollback')) as {
    flywheel?: { promoted?: { endpoint?: string } };
  };
  return { endpoint: body.flywheel?.promoted?.endpoint?.trim() || '' };
}

export async function rememberBakeOffHistory(entry: Record<string, unknown>): Promise<void> {
  const response = await fetch('/api/admin/benchmarks/compare-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  await readJson(response, 'bake-off history');
}

