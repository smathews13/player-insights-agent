import {
  EGRESS_PATHS,
  egressControlsFrom,
  type EgressChannel,
  type EgressControls,
  type EgressControlsPayload,
} from '../../shared/egress-contract';

type FailureBody = {
  detail?: unknown;
  message?: unknown;
};

export interface LoadedEgressControls {
  controls: EgressControls;
  stored: boolean;
}

/** Adopt the server snapshot while preserving only writes that have not landed. */
export function retainPendingEgressDrafts(
  draft: EgressControls,
  persisted: EgressControls,
  pending: ReadonlySet<EgressChannel>
): EgressControls {
  const next = { ...persisted };
  for (const channel of pending) next[channel] = draft[channel];
  return next;
}

function serverDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const failure = body as FailureBody;
  if (typeof failure.detail === 'string' && failure.detail.trim()) return failure.detail.trim();
  if (typeof failure.message === 'string' && failure.message.trim()) return failure.message.trim();
  return '';
}

/**
 * Parse the shared read/write response without trusting a cast from arbitrary JSON.
 * The server returns a complete snapshot after every write; accepting a partial
 * snapshot here would silently reset omitted controls to build defaults.
 */
export async function egressControlsFromResponse(
  response: Response,
  operation: 'loaded' | 'saved'
): Promise<LoadedEgressControls> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      response.ok
        ? 'The egress controls endpoint returned an unreadable response.'
        : `The egress controls endpoint answered ${response.status} without an error message.`
    );
  }

  if (!response.ok) {
    throw new Error(serverDetail(body) || `The egress controls endpoint answered ${response.status}.`);
  }

  const record = body && typeof body === 'object' ? (body as Partial<EgressControlsPayload>) : {};
  const rawControls =
    record.controls && typeof record.controls === 'object'
      ? (record.controls as unknown as Record<string, unknown>)
      : null;
  if (
    !rawControls ||
    !EGRESS_PATHS.every((path) => typeof rawControls[path.channel] === 'boolean') ||
    typeof record.stored !== 'boolean'
  ) {
    throw new Error(`Egress controls were not ${operation}: the server returned an incomplete controls payload.`);
  }

  return {
    controls: egressControlsFrom(
      EGRESS_PATHS.map((path) => ({ channel: path.channel, allowed: rawControls[path.channel] as boolean }))
    ),
    stored: record.stored,
  };
}
