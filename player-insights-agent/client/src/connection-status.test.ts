import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATUS_LABEL,
  CONNECTION_STATUS_NOTE,
  connectionCounts,
  connectionStatus,
  connectionStatusVariant,
  driftCount,
  driftMarker,
  inUseSummary,
  primaryConnectionState,
  visibleCounts,
  type ConnectionStatus,
} from './connection-status';
import { PREFLIGHT_STATUS_LABEL } from './preflight';

describe('the row badge', () => {
  it('maps precise probe outcomes to binary primary states without a false failure while loading', () => {
    expect(primaryConnectionState('reachable', true)).toBe('connected');
    expect(primaryConnectionState('blocked', true)).toBe('disconnected');
    expect(primaryConnectionState('refused', true)).toBe('disconnected');
    expect(primaryConnectionState('unreachable', true)).toBe('disconnected');
    expect(primaryConnectionState('not-checked', true)).toBe('loading');
    expect(primaryConnectionState('nothing-to-reach', false)).toBe('not-applicable');
  });
  it('reads a passing check as reachable', () => {
    expect(connectionStatus({ check: { status: 'ok' }, hasRemoteEnd: true })).toBe('reachable');
  });

  it('reads a failing check as blocked', () => {
    expect(connectionStatus({ check: { status: 'failed' }, hasRemoteEnd: true })).toBe('blocked');
  });

  it('reads a check that could not decide as not checked', () => {
    expect(connectionStatus({ check: { status: 'unverified' }, hasRemoteEnd: true })).toBe('not-checked');
  });

  it('says not checked when no check names a resource that has a remote end', () => {
    expect(connectionStatus({ check: null, hasRemoteEnd: true })).toBe('not-checked');
    expect(connectionStatus({ hasRemoteEnd: true })).toBe('not-checked');
  });

  // The distinction the fourth word exists for. A token cap and two lists of
  // catalog patterns name no object anywhere, and badging them "Not checked"
  // promises a verdict that no check could ever deliver -- which sends a reader
  // looking for a discrepancy between two readings when there is only ever one.
  it('separates "nobody looked" from "there is nothing to look at"', () => {
    expect(connectionStatus({ check: null, hasRemoteEnd: false })).toBe('nothing-to-reach');
    expect(connectionStatus({ check: null, hasRemoteEnd: true })).toBe('not-checked');
  });

  // A check that ran and could not decide is a fact about this deployment.
  // Overwriting it with "nothing to reach" would throw that fact away.
  it('lets a real check outrank a resource with nothing to reach', () => {
    expect(connectionStatus({ check: { status: 'unverified' }, hasRemoteEnd: false })).toBe('not-checked');
    expect(connectionStatus({ check: { status: 'failed' }, hasRemoteEnd: false })).toBe('blocked');
  });

  // The table matrix survives the merge on the same page and is badged straight
  // from check statuses. A second wording for the same fact on one page is the
  // thing this vocabulary was reconciled to prevent.
  it('spells the three probed outcomes exactly as the table matrix does', () => {
    expect(CONNECTION_STATUS_LABEL.reachable).toBe(PREFLIGHT_STATUS_LABEL.ok);
    expect(CONNECTION_STATUS_LABEL.blocked).toBe(PREFLIGHT_STATUS_LABEL.failed);
    expect(CONNECTION_STATUS_LABEL['not-checked']).toBe(PREFLIGHT_STATUS_LABEL.unverified);
  });

  it('gives the fourth outcome a word of its own', () => {
    expect(CONNECTION_STATUS_LABEL['nothing-to-reach']).toBe('Nothing to reach');
    expect(new Set(Object.values(CONNECTION_STATUS_LABEL)).size).toBe(6);
  });

  /**
   * THE HEADLINE THAT CONTRADICTED THE ROWS. Every Unity Catalog row on the live
   * deployment was refused with an HTTP 403, and the count line above them read
   * "9 not checked" -- because a refusal is `unverified` on the wire and this
   * module read all three kinds of `unverified` as "nobody looked". Somebody
   * looked. The workspace answered.
   *
   * THREE WORDS, BECAUSE THERE ARE THREE NEXT MOVES. Refused was split out first,
   * on the argument that it is the one where something happened -- and that
   * argument was the wrong one. A refusal establishes nothing about the object
   * either; what separates these is what a reader does about them. Get a
   * permission, retry or escalate, or run the checks. `unreachable` was the state
   * the rows already named, so leaving it in `not checked` on the line above them
   * was the same contradiction one line up.
   */
  it('gives each of the three unsettled states the word its next move needs', () => {
    const refused = { status: 'unverified' as const, stopped: 'refused' as const };
    const brokeOff = { status: 'unverified' as const, stopped: 'unreachable' as const };
    const neverAsked = { status: 'unverified' as const, stopped: 'unasked' as const };

    expect(connectionStatus({ check: refused, hasRemoteEnd: true })).toBe('refused');
    expect(connectionStatus({ check: brokeOff, hasRemoteEnd: true })).toBe('unreachable');
    expect(connectionStatus({ check: neverAsked, hasRemoteEnd: true })).toBe('not-checked');
    // And the words on the rows, so the section header, the badge and the count
    // line are renderings of one string rather than three guesses at it.
    expect(CONNECTION_STATUS_LABEL.refused).toBe('Refused');
    expect(CONNECTION_STATUS_LABEL.unreachable).toBe('Unreachable');
  });

  /**
   * A report from the serving endpoint predates the `stopped` field and carries
   * none, so the fallback must not GUESS a refusal: it is the one verdict that
   * changes what a reader is told to do. Nothing established, no permission
   * claimed.
   */
  it('never infers a refusal from a check that did not report one', () => {
    expect(connectionStatus({ check: { status: 'unverified' }, hasRemoteEnd: true })).toBe('not-checked');
    // Something answered and it was not usable, which is unreachable. Reading the
    // words "403" out of a bare error string would be inferring the one verdict
    // that changes what a reader is told to do, off prose nobody promised to keep.
    expect(connectionStatus({ check: { status: 'unverified', error: 'HTTP 403' }, hasRemoteEnd: true })).toBe(
      'unreachable'
    );
  });

  it('explains every badge it can show', () => {
    for (const status of Object.keys(CONNECTION_STATUS_LABEL) as ConnectionStatus[]) {
      expect(CONNECTION_STATUS_NOTE[status].length).toBeGreaterThan(0);
    }
  });

  // Only a failed probe earns the red. "Not checked" and "Nothing to reach" are
  // absences of evidence, and painting an absence as a fault is how a page
  // teaches people to ignore its red.
  it('spends the destructive variant only on a check that failed', () => {
    expect(connectionStatusVariant('blocked')).toBe('destructive');
    expect(connectionStatusVariant('reachable')).toBe('secondary');
    expect(connectionStatusVariant('not-checked')).toBe('outline');
    expect(connectionStatusVariant('nothing-to-reach')).toBe('outline');
  });
});

describe('the drift marker', () => {
  it('is absent on a row with nothing wrong', () => {
    expect(driftMarker({ findingIds: [], intended: null })).toBe('none');
  });

  it('reports a mismatch as drift', () => {
    expect(driftMarker({ findingIds: ['mismatch-sql-warehouse'], intended: null })).toBe('drift');
  });

  it('reports a provenance finding as drift too', () => {
    expect(driftMarker({ findingIds: ['provenance-catalog'], intended: null })).toBe('drift');
  });

  // The pending finding says what the row's own Intended banner says. Counting
  // it as drift would report one fact as two problems, which is the reading the
  // settings card already suppressed it to avoid.
  it('does not let a recorded intention masquerade as drift', () => {
    expect(driftMarker({ findingIds: ['pending-llm-endpoint'], intended: 'databricks-claude' })).toBe('pending');
    expect(driftCount(['pending-llm-endpoint'])).toBe(0);
  });

  it('marks an intention with no finding behind it as pending', () => {
    expect(driftMarker({ findingIds: [], intended: 'wh-1234' })).toBe('pending');
  });

  // A deployment can be both wrong and mid-change. Drift is the louder of the
  // two because it describes the running system rather than someone's plan for
  // it, so it is what the one marker says.
  it('prefers drift over pending when a row has both', () => {
    expect(driftMarker({ findingIds: ['mismatch-catalog', 'pending-catalog'], intended: 'other' })).toBe('drift');
  });

  // Two problems with one resource are two problems: showing one hid the other,
  // and a deployer could fix what they were shown and re-check into a second
  // blocking finding they had never been told about.
  it('counts every non-pending finding so the row can say how many', () => {
    expect(driftCount(['provenance-app-warehouse', 'mismatch-app-warehouse', 'pending-app-warehouse'])).toBe(2);
  });
});

describe('the value on the collapsed line', () => {
  it('prefers what the deployment demonstrably used', () => {
    expect(inUseSummary({ actual: 'wh-in-use', actualObserved: true, configured: 'wh-configured' })).toEqual({
      value: 'wh-in-use',
      measured: true,
    });
  });

  // Not measured and matches are different claims. Falling back to the
  // configured value is fine; presenting it as the observed one is not, so the
  // flag travels with it.
  it('falls back to the configured value and says that is what it is', () => {
    expect(inUseSummary({ actual: '', actualObserved: false, configured: 'wh-configured' })).toEqual({
      value: 'wh-configured',
      measured: false,
    });
  });

  it('does not treat an observed empty string as a measurement', () => {
    expect(inUseSummary({ actual: '', actualObserved: true, configured: 'wh-configured' })).toEqual({
      value: 'wh-configured',
      measured: false,
    });
  });
});

describe('the counts on the one status line', () => {
  it('tallies reachability and configuration side by side rather than merging them', () => {
    expect(
      connectionCounts({
        statuses: ['reachable', 'reachable', 'blocked', 'refused', 'unreachable', 'not-checked', 'nothing-to-reach'],
        markers: ['none', 'drift', 'drift', 'none', 'none', 'pending', 'none'],
      })
    ).toEqual({
      reachable: 2,
      blocked: 1,
      // Their own figures, which is the fix. Both were inside `notChecked`, so the
      // line read "9 not checked" over nine rows the workspace had refused, and
      // counted a dependency nothing could reach as one nobody had asked about.
      refused: 1,
      unreachable: 1,
      notChecked: 1,
      nothingToReach: 1,
      drifted: 2,
      pending: 1,
    });
  });

  it('reports zeroes for an empty deployment rather than throwing', () => {
    expect(connectionCounts({ statuses: [], markers: [] })).toEqual({
      reachable: 0,
      blocked: 0,
      refused: 0,
      unreachable: 0,
      notChecked: 0,
      nothingToReach: 0,
      drifted: 0,
      pending: 0,
    });
  });

  it('collapses all resolved failures into one Disconnected summary', () => {
    const counts = connectionCounts({
      statuses: ['reachable', 'blocked', 'refused', 'unreachable'],
      markers: ['none', 'none', 'none', 'none'],
    });
    expect(visibleCounts(counts).slice(0, 2)).toEqual([
      { key: 'connected', word: 'connected', tone: 'reachable', count: 1 },
      { key: 'disconnected', word: 'disconnected', tone: 'blocked', count: 3 },
    ]);
  });
});
