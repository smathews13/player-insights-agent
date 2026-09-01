import {
  decodeExperimentalSettingsDocument,
  type ExperimentalFeatures,
} from '../../shared/experimental-settings-browser';

export interface ExperimentalSettingsDocument {
  settings: ExperimentalFeatures;
  revision: number;
}

function detail(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const value = (body as { detail?: unknown }).detail;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export async function experimentalSettingsFromResponse(response: Response): Promise<ExperimentalSettingsDocument> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(detail(body, `Experimental settings answered ${response.status}.`));
  const document = decodeExperimentalSettingsDocument(body);
  if (!document) {
    throw new Error('Experimental settings returned an incomplete durable snapshot.');
  }
  return document;
}

export async function loadExperimentalSettings(): Promise<ExperimentalSettingsDocument> {
  return experimentalSettingsFromResponse(
    await fetch('/api/experimental-settings', { headers: { accept: 'application/json' } })
  );
}

export async function saveExperimentalSettings(
  revision: number,
  patch: Partial<ExperimentalFeatures>
): Promise<ExperimentalSettingsDocument> {
  return experimentalSettingsFromResponse(
    await fetch('/api/admin/experimental-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision, patch }),
    })
  );
}
