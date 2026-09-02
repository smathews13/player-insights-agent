export type NotebookAgentSyncTarget = 'notebook' | 'apply';

const TARGETS: Readonly<Record<string, NotebookAgentSyncTarget>> = {
  notebook: 'notebook',
  'notebook-path': 'notebook',
  'notebook-agent-sync-notebook': 'notebook',
  apply: 'apply',
  'apply-model-settings': 'apply',
  'notebook-agent-sync-apply': 'apply',
};

/** Recognize old and current links without treating unrelated Connections links as gated. */
export function notebookAgentSyncTarget(input: { search?: string; hash?: string }): NotebookAgentSyncTarget | null {
  const params = new URLSearchParams(input.search ?? '');
  for (const value of [params.get('pane'), params.get('action'), params.get('entity')]) {
    const target = TARGETS[(value ?? '').trim().toLowerCase()];
    if (target) return target;
  }
  return TARGETS[(input.hash ?? '').replace(/^#/, '').trim().toLowerCase()] ?? null;
}
