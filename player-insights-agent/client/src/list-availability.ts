/**
 * What a list response actually is, decided from what the server said rather
 * than from how many rows arrived.
 *
 * THE CONFLATION THIS EXISTS TO PREVENT. Zero rows is the answer to two
 * completely different questions: "what have you got" answered by a healthy
 * store holding nothing, and "what have you got" not answered at all. Every
 * surface that treated the two the same rendered "No runs yet" over an outage,
 * which tells a customer their history is gone.
 *
 * The list routes answer with bare arrays, so the fact travels in headers; see
 * `markResponse` in server/lib/lakebase-store.ts. Reading them in one place
 * means Run Explorer, the Benchmark Lab and the conversation rail cannot come to
 * different conclusions about the same response, which they previously did:
 * two of them inferred the origin from the row ids.
 */

/**
 * A fourth value, `demo`, used to mean seeded rows were on screen because the
 * deployment was a labelled demo. No deployment holds seeded rows, so no
 * response can be that, and nothing renders a badge for it.
 */
export type ListOrigin =
  /** The store answered and returned records. The ordinary case. */
  | 'stored'
  /** The store answered and holds nothing yet. Healthy, and not a failure. */
  | 'empty'
  /** Nobody knows what the store holds. Never rendered as a count. */
  | 'unavailable';

/**
 * Why the server could not answer with records, when it said.
 *
 * There used to be a third, `storage_empty`, which meant "the store answered
 * and holds nothing, so these rows are seeded". Nothing is seeded now, so an
 * empty store is answered with an empty list and no reason at all: it is a
 * correct answer rather than a degradation, and `origin` already says so.
 */
export type ListReason = 'storage_unavailable' | 'storage_grants_missing' | null;

export interface ListAvailability {
  origin: ListOrigin;
  reason: ListReason;
}

const REASONS = new Set(['storage_unavailable', 'storage_grants_missing']);

function reasonOf(headers: ResponseHeaders): ListReason {
  const raw = headers.get('X-PIA-Degraded-Reason');
  return raw && REASONS.has(raw) ? (raw as Exclude<ListReason, null>) : null;
}

/** The slice of `Headers` this reads, so a test needs no `fetch`. */
export interface ResponseHeaders {
  get(name: string): string | null;
}

/**
 * Classify one list response.
 *
 * `rowCount` is consulted last and only to tell `stored` from `empty`. It can
 * never produce `unavailable`, which is the ordering that matters: an outage is
 * something the server states, not something a client infers from a short list.
 */
export function listAvailability(input: { headers: ResponseHeaders; rowCount: number }): ListAvailability {
  const { headers, rowCount } = input;
  const reason = reasonOf(headers);
  // Before the row count, because an unreadable store answers with an empty
  // array too and only the header tells the two apart.
  if (headers.get('X-PIA-Data-Origin') === 'none') return { origin: 'unavailable', reason };
  if (headers.get('X-PIA-Storage') === 'unavailable') return { origin: 'unavailable', reason };
  return { origin: rowCount === 0 ? 'empty' : 'stored', reason };
}

/**
 * The classification for a request that never produced a response at all.
 *
 * A thrown fetch is the one case with no headers to read, and it is also the
 * case a client is most tempted to paper over, because there is nothing to
 * render. It is an outage of the app itself and is reported as unavailable.
 */
export function listUnreachable(): ListAvailability {
  return { origin: 'unavailable', reason: 'storage_unavailable' };
}

/**
 * Whether a surface may render row-derived numbers from this response.
 *
 * The one question every count, average and chart on these pages should be
 * asking. `unavailable` is the one that answers false: nobody knows what the
 * store holds, so a count derived from an empty response is not a measurement
 * of anything.
 */
export function countsAreMeasured(availability: ListAvailability): boolean {
  return availability.origin === 'stored' || availability.origin === 'empty';
}
