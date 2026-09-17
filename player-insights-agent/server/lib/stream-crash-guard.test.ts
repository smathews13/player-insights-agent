import { describe, expect, it } from 'vitest';

import {
  guardCancelledStreamCrashes,
  isCancelledStreamEnqueueRace,
  resetStreamCrashGuardForTest,
} from './stream-crash-guard';

/**
 * The production crash was a cancelled serving stream throwing
 * `ERR_INVALID_STATE: Controller is already closed` from inside the SDK's
 * `IncomingMessage` `data` handler -- an uncaught exception that killed the
 * whole process. These pin both halves of the guard: it recognizes exactly that
 * race, and it leaves every other exception to Node's fail-fast default.
 */
function closedControllerError(): Error {
  const error = new TypeError('Invalid state: Controller is already closed');
  (error as NodeJS.ErrnoException).code = 'ERR_INVALID_STATE';
  error.stack = [
    'TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed',
    '    at ReadableStreamDefaultController.enqueue (node:internal/webstreams/readablestream:1077:13)',
    '    at IncomingMessage.<anonymous> (file:///app/vendor-databricks-sdk-experimental.mjs:2052:24)',
  ].join('\n');
  return error;
}

describe('recognising the cancelled-stream enqueue race', () => {
  it('matches the exact closed-controller enqueue throw', () => {
    expect(isCancelledStreamEnqueueRace(closedControllerError())).toBe(true);
  });

  it('does not match an unrelated invalid-state error', () => {
    const other = new TypeError('Invalid state: something else entirely');
    (other as NodeJS.ErrnoException).code = 'ERR_INVALID_STATE';
    other.stack = 'TypeError\n    at somethingElse (foo.mjs:1:1)';
    expect(isCancelledStreamEnqueueRace(other)).toBe(false);
  });

  it('does not match a closed message that came from a different call site', () => {
    // Right words, wrong frame: without the enqueue frame this is not the SDK
    // stream race and must not be swallowed.
    const error = new Error('Controller is already closed');
    (error as NodeJS.ErrnoException).code = 'ERR_INVALID_STATE';
    error.stack = 'Error\n    at someOtherThing (bar.mjs:2:2)';
    expect(isCancelledStreamEnqueueRace(error)).toBe(false);
  });

  it('ignores non-errors and errors without the code', () => {
    expect(isCancelledStreamEnqueueRace(undefined)).toBe(false);
    expect(isCancelledStreamEnqueueRace('Controller is already closed')).toBe(false);
    expect(isCancelledStreamEnqueueRace(new Error('Controller is already closed'))).toBe(false);
  });
});

describe('the installed process guard', () => {
  it('swallows the race and keeps the process alive, but exits on anything else', () => {
    resetStreamCrashGuardForTest();
    const swallowed: Error[] = [];
    const exits: number[] = [];
    guardCancelledStreamCrashes(
      (error) => swallowed.push(error),
      (code) => exits.push(code)
    );

    const listeners = process.listeners('uncaughtException');
    const handler = listeners[listeners.length - 1] as (error: Error) => void;
    try {
      handler(closedControllerError());
      expect(swallowed).toHaveLength(1);
      expect(exits).toHaveLength(0);

      handler(new Error('a genuine programming defect'));
      expect(exits).toEqual([1]);
    } finally {
      process.off('uncaughtException', handler);
      resetStreamCrashGuardForTest();
    }
  });
});
