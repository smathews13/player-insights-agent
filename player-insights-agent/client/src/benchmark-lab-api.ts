import type { LabWorkspace } from '../../shared/benchmark-lab-v3';

/**
 * Fetch helpers for Benchmark Lab v3. UI surfaces import these rather than
 * talking to /api/benchmarks/lab with ad hoc JSON.
 */

type FailureBody = {
  detail?: unknown;
  message?: unknown;
};

function serverDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const failure = body as FailureBody;
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
  target?: LabWorkspace['contract']['target'];
}): Promise<{ lab: LabWorkspace; wroteGenieInstructions: false; connectionsChanged: false }> {
  const response = await fetch('/api/admin/benchmarks/lab/apply-candidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await readJson(response, 'apply')) as {
    lab?: unknown;
    decision?: { wroteGenieInstructions?: boolean; connectionsChanged?: boolean };
    apply?: { wroteGenieInstructions?: boolean; connectionsChanged?: boolean };
  };
  return {
    lab: labFromPayload(body),
    wroteGenieInstructions: false,
    connectionsChanged: false,
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
