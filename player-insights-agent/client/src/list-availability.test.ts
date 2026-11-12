import { describe, expect, it } from 'vitest';
import { countsAreMeasured, listAvailability, listUnreachable, type ResponseHeaders } from './list-availability';

/**
 * Telling an empty store from an unreadable one, which look identical.
 *
 * Zero rows answers two different questions, and rendering both as "No runs
 * yet" tells a customer during an outage that their history is gone. Every
 * assertion here is one of the two directions of that mistake.
 */

function headers(values: Record<string, string> = {}): ResponseHeaders {
  return { get: (name) => values[name] ?? null };
}

describe('a store that answered', () => {
  it('with records is stored', () => {
    const availability = listAvailability({
      headers: headers({ 'X-PIA-Storage': 'ok', 'X-PIA-Data-Origin': 'lakebase' }),
      rowCount: 3,
    });
    expect(availability.origin).toBe('stored');
  });

  it('with nothing is empty, which is a healthy state and not a failure', () => {
    const availability = listAvailability({
      headers: headers({ 'X-PIA-Storage': 'ok', 'X-PIA-Data-Origin': 'lakebase' }),
      rowCount: 0,
    });
    expect(availability.origin).toBe('empty');
  });
});

describe('a store that did not answer', () => {
  it('is unavailable even though it also returned no rows', () => {
    // The whole point. The row count is identical to the empty case above and
    // the conclusion is the opposite one.
    const availability = listAvailability({
      headers: headers({ 'X-PIA-Storage': 'unavailable', 'X-PIA-Degraded-Reason': 'storage_unavailable' }),
      rowCount: 0,
    });
    expect(availability.origin).toBe('unavailable');
    expect(availability.reason).toBe('storage_unavailable');
  });

  it('cannot be talked into empty by a short list', () => {
    // An outage is something the server states. A client must never reach
    // `unavailable` or leave it by counting rows.
    const availability = listAvailability({
      headers: headers({ 'X-PIA-Storage': 'unavailable' }),
      rowCount: 12,
    });
    expect(availability.origin).toBe('unavailable');
  });

  it('is unavailable when the request never produced a response at all', () => {
    // The case with no headers to read, and the one a client is most tempted to
    // paper over because there is nothing to render.
    expect(listUnreachable().origin).toBe('unavailable');
  });

  it('keeps a missing grant apart from an outage, because they are fixed by different people', () => {
    const availability = listAvailability({
      headers: headers({ 'X-PIA-Storage': 'unavailable', 'X-PIA-Degraded-Reason': 'storage_grants_missing' }),
      rowCount: 0,
    });
    expect(availability.reason).toBe('storage_grants_missing');
  });
});

/**
 * There is no `demo` origin any more, because no deployment holds seeded rows to
 * put on screen. What is left is the distinction that used to be obscured by
 * them: an empty array from a store that answered against one from a store that
 * did not.
 */
describe('an empty response', () => {
  it('is unavailable when the server says nobody could fill it', () => {
    const availability = listAvailability({
      headers: headers({ 'X-PIA-Data-Origin': 'none', 'X-PIA-Degraded-Reason': 'storage_unavailable' }),
      rowCount: 0,
    });
    expect(availability.origin).toBe('unavailable');
    expect(availability.reason).toBe('storage_unavailable');
  });

  it('is empty when the store answered and had nothing', () => {
    const availability = listAvailability({
      headers: headers({ 'X-PIA-Storage': 'ok', 'X-PIA-Data-Origin': 'lakebase' }),
      rowCount: 0,
    });
    expect(availability.origin).toBe('empty');
    expect(availability.reason).toBeNull();
  });
});

describe('whether a page may compute a number from these rows', () => {
  it('may, for a store that answered', () => {
    expect(countsAreMeasured({ origin: 'stored', reason: null })).toBe(true);
    expect(countsAreMeasured({ origin: 'empty', reason: null })).toBe(true);
  });

  it('may not, for an outage', () => {
    expect(countsAreMeasured({ origin: 'unavailable', reason: 'storage_unavailable' })).toBe(false);
  });

  it('may not, for a store that refused the read', () => {
    expect(countsAreMeasured({ origin: 'unavailable', reason: 'storage_grants_missing' })).toBe(false);
  });
});
