import { RuntimeSettingsSchema, type RuntimeSettings } from '../../shared/runtime-settings';
import { changedSettingKeys, changedSettingsPatch } from './settings-save-state';

export interface RuntimeSettingsDocument {
  settings: RuntimeSettings;
  revision: number;
  source: 'default' | 'override';
  canReset: boolean;
}

export class RuntimeSettingsDraftConflict extends Error {
  readonly latest: RuntimeSettingsDocument;

  constructor(latest: RuntimeSettingsDocument) {
    super('These settings changed while you were editing. Your changes were kept; review them and press Save again.');
    this.name = 'RuntimeSettingsDraftConflict';
    this.latest = latest;
  }
}

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

/**
 * Read the one response shape used by both runtime-settings routes.
 *
 * The panel used to cast any successful JSON and replace every failed response
 * with one generic sentence. That made a 403, a missing route returning HTML,
 * a malformed payload, and a Lakebase 503 indistinguishable on the only screen
 * where an operator could act on them.
 */
export async function runtimeSettingsFromResponse(
  response: Response,
  operation: 'loaded' | 'saved'
): Promise<RuntimeSettings> {
  return (await runtimeSettingsDocumentFromResponse(response, operation)).settings;
}

export async function runtimeSettingsDocumentFromResponse(
  response: Response,
  operation: 'loaded' | 'saved'
): Promise<RuntimeSettingsDocument> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? 'The runtime settings endpoint returned an unreadable response.'
        : `The runtime settings endpoint answered ${response.status} without an error message.`
    );
  }

  if (!response.ok) {
    throw new Error(serverDetail(body) || `The runtime settings endpoint answered ${response.status}.`);
  }

  const settings = body && typeof body === 'object' ? (body as { settings?: unknown }).settings : undefined;
  const revision = body && typeof body === 'object' ? (body as { revision?: unknown }).revision : undefined;
  const source = body && typeof body === 'object' ? (body as { source?: unknown }).source : undefined;
  const canReset = body && typeof body === 'object' ? (body as { canReset?: unknown }).canReset : undefined;
  const parsed = RuntimeSettingsSchema.safeParse(settings);
  if (!parsed.success || !Number.isInteger(revision) || Number(revision) < 0) {
    throw new Error(`Runtime settings were not ${operation}: the server returned an incomplete settings payload.`);
  }
  return {
    settings: parsed.data,
    revision: Number(revision),
    source: source === 'override' ? 'override' : 'default',
    canReset: canReset === true,
  };
}

type RuntimeSettingsFetch = (input: string, init?: RequestInit) => Promise<Response>;

function saveBody(revision: number, patch: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, patch }),
  };
}

/**
 * Save one draft, rebasing automatically only when a stale revision changed
 * different settings.
 *
 * A same-field conflict keeps the draft in the form and advances its baseline
 * to the latest durable row. The next explicit Save is therefore the user's
 * confirmation that their value should replace the concurrently saved value.
 */
export async function saveRuntimeSettingsDraft(
  url: string,
  baseline: RuntimeSettings,
  draft: RuntimeSettings,
  revision: number,
  fetcher: RuntimeSettingsFetch = fetch
): Promise<RuntimeSettingsDocument> {
  const patch = changedSettingsPatch(baseline, draft) ?? {};
  const first = await fetcher(url, saveBody(revision, patch));
  if (first.status !== 409) return runtimeSettingsDocumentFromResponse(first, 'saved');

  const latest = await runtimeSettingsDocumentFromResponse(await fetcher(url), 'loaded');
  const draftKeys = new Set(changedSettingKeys(baseline, draft));
  const concurrentKeys = new Set(changedSettingKeys(baseline, latest.settings));
  const stillDifferent = new Set(changedSettingKeys(latest.settings, draft));
  const overlapping = [...draftKeys].filter((key) => concurrentKeys.has(key) && stillDifferent.has(key));
  if (overlapping.length > 0) throw new RuntimeSettingsDraftConflict(latest);
  if (stillDifferent.size === 0) return latest;

  return runtimeSettingsDocumentFromResponse(await fetcher(url, saveBody(latest.revision, patch)), 'saved');
}
