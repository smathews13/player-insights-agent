/**
 * The immutable contract shared by Connections, the app API, and the notebook
 * release helper.
 *
 * `settings` is deliberately the same declaration shape consumed by
 * `agent/apply_from_declaration.py`; the release request does not invent a
 * second translation layer.
 */
export interface ModelReleaseDeclaration {
  source: 'connections-apply';
  /** sha256 of the canonical source + settings document. */
  revision: string;
  settings: Record<string, string>;
}

export type ModelReleaseStatus = 'approved' | 'running' | 'succeeded' | 'failed';

export interface ReleasePreflight {
  status: string;
  checkedAt: string;
  ok: number;
  failed: number;
  unverified: number;
  detail?: string;
}

export interface ModelReleaseRequest {
  id: string;
  status: ModelReleaseStatus;
  requestedBy: string;
  requestedAt: string;
  declaration: ModelReleaseDeclaration;
  declarationRevision: string;
  target: string;
  endpointName: string;
  modelName: string;
  vFrom: string | null;
  vTo: string | null;
  preflightAtRequest: ReleasePreflight | null;
  preflightResult: ReleasePreflight | null;
  startedAt: string | null;
  completedAt: string | null;
  claimedBy: string | null;
  completedBy: string | null;
  errorSummary: string | null;
}

export interface ModelReleaseClaim {
  executionId: string;
}

export interface ModelReleaseCompletion {
  executionId: string;
  status: 'succeeded' | 'failed';
  vTo?: string | null;
  preflight?: ReleasePreflight | null;
  errorSummary?: string | null;
}
