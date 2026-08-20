import type { NotebookPanel } from './connection-model';

export function notebookPathView(panel: NotebookPanel): {
  configured: string;
  observed: string;
  shown: string;
} {
  const configured = panel.configuredPath?.trim() ?? '';
  const observed = panel.observedPath?.trim() || panel.read.declaration?.source?.trim() || '';
  return { configured, observed, shown: configured || observed };
}

export async function persistNotebookPath(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; path: string } | { ok: false; detail: string }> {
  try {
    const response = await fetchImpl('/api/settings/notebook-path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const body = (await response.json().catch(() => ({}))) as { path?: string; detail?: string };
    return response.ok
      ? { ok: true, path: body.path?.trim() || path.trim() }
      : { ok: false, detail: body.detail ?? 'The notebook path was not saved.' };
  } catch {
    return { ok: false, detail: 'The notebook path could not be saved just now.' };
  }
}
