import type { ModelReleaseRequest } from '../../shared/model-release';
import type { NotebookPanel } from './connection-model';
import { notebookPathView } from './notebook-card-state';

export function modelReleaseNotebookSnippet(release: ModelReleaseRequest, appUrl: string): string {
  return `from apply_model_version import apply_model_version\n\napply_model_version(\n    request_id="${release.id}",\n    app_url="${appUrl}",\n    repo_root="/path/to/player-insights-agent",\n)`;
}

export function releaseVersionLine(release: ModelReleaseRequest): string {
  if (!release.vFrom && !release.vTo) return '';
  return `version ${release.vFrom ?? 'unknown'} → ${release.vTo ?? 'pending'}`;
}

export const NOTEBOOK_REQUIRED_REASON =
  'Select a notebook first. The model version is logged from the connected notebook.';
export const NOTEBOOK_REQUIRED_ACTION = 'Use Browse workspace notebooks on the Notebook card.';

export function applyActionState(input: {
  notebook?: NotebookPanel;
  busy?: boolean;
  knobCount: number;
  releaseStatus?: ModelReleaseRequest['status'];
}): { disabled: boolean; reason: string } {
  const noNotebook = input.notebook ? notebookPathView(input.notebook).shown === '' : false;
  const releasing = input.releaseStatus === 'approved' || input.releaseStatus === 'running';
  return {
    disabled: noNotebook || Boolean(input.busy) || input.knobCount === 0 || releasing,
    reason: noNotebook ? NOTEBOOK_REQUIRED_REASON : '',
  };
}
