import { BenchmarkSettingsSchema, type BenchmarkSettings } from '../../shared/benchmark-settings';

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

export interface BenchmarkSettingsPayload {
  settings: BenchmarkSettings;
  experimentUrl: string | null;
  currentAgentEndpoint: string;
  tracesAlwaysOnInAgent: boolean;
}

export async function benchmarkSettingsFromResponse(
  response: Response,
  operation: 'loaded' | 'saved'
): Promise<BenchmarkSettingsPayload> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? 'The benchmark settings endpoint returned an unreadable response.'
        : `The benchmark settings endpoint answered ${response.status} without an error message.`
    );
  }

  if (!response.ok) {
    throw new Error(serverDetail(body) || `The benchmark settings endpoint answered ${response.status}.`);
  }

  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const parsed = BenchmarkSettingsSchema.safeParse(record.settings);
  if (!parsed.success) {
    throw new Error(`Benchmark settings were not ${operation}: the server returned an incomplete settings payload.`);
  }
  return {
    settings: parsed.data,
    experimentUrl: typeof record.experimentUrl === 'string' ? record.experimentUrl : null,
    currentAgentEndpoint: typeof record.currentAgentEndpoint === 'string' ? record.currentAgentEndpoint : '',
    tracesAlwaysOnInAgent: record.tracesAlwaysOnInAgent === true,
  };
}
