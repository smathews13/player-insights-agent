import { RuntimeSettingsSchema, type RuntimeSettings } from '../../shared/runtime-settings';

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
  const parsed = RuntimeSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    throw new Error(`Runtime settings were not ${operation}: the server returned an incomplete settings payload.`);
  }
  return parsed.data;
}
