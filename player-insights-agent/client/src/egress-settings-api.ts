import {
  EGRESS_PATHS,
  egressControlsFrom,
  type EgressControls,
  type EgressControlsPayload,
  type EgressEvent,
  type EgressEventsPayload,
  type EgressStorageMetadata,
} from '../../shared/egress-contract';

type FailureBody = {
  detail?: unknown;
  message?: unknown;
};

export interface LoadedEgressControls {
  controls: EgressControls;
  stored: boolean;
  storage: EgressStorageMetadata;
}

function serverDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const failure = body as FailureBody;
  if (typeof failure.detail === 'string' && failure.detail.trim()) return failure.detail.trim();
  if (typeof failure.message === 'string' && failure.message.trim()) return failure.message.trim();
  return '';
}

function storageMetadata(raw: unknown): EgressStorageMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<EgressStorageMetadata>;
  if (
    value.store !== 'Lakebase (Postgres)' ||
    !value.eventsTable ||
    !value.controlsTable ||
    !value.retained ||
    !value.retention ||
    !value.identityScope
  ) {
    return null;
  }
  return value as EgressStorageMetadata;
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
  const storage = storageMetadata(record.storage);
  if (
    !rawControls ||
    !EGRESS_PATHS.every((path) => typeof rawControls[path.channel] === 'boolean') ||
    typeof record.stored !== 'boolean' ||
    !storage
  ) {
    throw new Error(`Egress controls were not ${operation}: the server returned an incomplete controls payload.`);
  }

  return {
    controls: egressControlsFrom(
      EGRESS_PATHS.map((path) => ({ channel: path.channel, allowed: rawControls[path.channel] as boolean }))
    ),
    stored: record.stored,
    storage,
  };
}

export class EgressRecordsError extends Error {
  readonly kind: 'authorization' | 'response';

  constructor(message: string, kind: 'authorization' | 'response') {
    super(message);
    this.kind = kind;
  }
}

function eventFrom(raw: unknown): EgressEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw as Partial<EgressEvent>;
  if (
    typeof event.id !== 'string' ||
    typeof event.occurredAt !== 'string' ||
    typeof event.actor !== 'string' ||
    !EGRESS_PATHS.some((path) => path.channel === event.channel) ||
    (event.outcome !== 'left' && event.outcome !== 'refused') ||
    typeof event.surface !== 'string' ||
    (event.runId !== null && typeof event.runId !== 'string') ||
    (event.conversationId !== null && typeof event.conversationId !== 'string') ||
    (event.itemCount !== null && typeof event.itemCount !== 'number')
  ) {
    return null;
  }
  return event as EgressEvent;
}

/** Load one server-owned, fixed-query page. The client never sends SQL. */
export async function fetchEgressRecordsPage(
  cursor: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<EgressEventsPayload> {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const response = await fetchImpl(`/api/egress/admin/events?${query}`, {
    headers: { Accept: 'application/json' },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EgressRecordsError('The egress records endpoint returned an unreadable response.', 'response');
  }
  if (!response.ok) {
    throw new EgressRecordsError(
      serverDetail(body) || `The egress records endpoint answered ${response.status}.`,
      response.status === 401 || response.status === 403 ? 'authorization' : 'response'
    );
  }
  const payload = body && typeof body === 'object' ? (body as Partial<EgressEventsPayload>) : {};
  const events = Array.isArray(payload.events) ? payload.events.map(eventFrom) : [];
  const storage = storageMetadata(payload.storage);
  if (
    !Array.isArray(payload.events) ||
    events.some((event) => event === null) ||
    (payload.readState !== 'read' && payload.readState !== 'unavailable' && payload.readState !== 'not-migrated') ||
    typeof payload.pageSize !== 'number' ||
    (payload.nextCursor !== null && typeof payload.nextCursor !== 'string') ||
    typeof payload.readAt !== 'string' ||
    !storage
  ) {
    throw new EgressRecordsError('The server returned an incomplete egress records page.', 'response');
  }
  return {
    events: events as EgressEvent[],
    readState: payload.readState,
    pageSize: payload.pageSize,
    nextCursor: payload.nextCursor,
    readAt: payload.readAt,
    storage,
  };
}
