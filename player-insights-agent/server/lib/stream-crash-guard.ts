/**
 * A cancelled serving stream must not be able to take the whole app down.
 *
 * When a reader stops a run or navigates away mid-answer, we cancel the
 * ReadableStream the Databricks SDK handed us. The SDK's own adapter keeps a
 * Node `IncomingMessage` `data` listener that calls `controller.enqueue()`
 * without first checking whether that stream has since closed. A chunk already
 * in flight at the instant of cancellation therefore reaches an already-closed
 * controller and throws `ERR_INVALID_STATE: Controller is already closed` --
 * synchronously, inside an EventEmitter callback that runs outside any
 * request/response cycle and outside every `try/catch` this app owns. Node's
 * default for an uncaught exception is to print it and exit, so a single
 * cancelled run killed the entire process and every other reader's session with
 * it.
 *
 * Dropping that late chunk is the correct outcome: the run was cancelled, the
 * consumer is gone, and nothing is waiting for the bytes. So this guard swallows
 * exactly that race and lets the process keep serving. Every other uncaught
 * exception is a real defect and is re-raised by exiting, so this stays a narrow
 * fix for one third-party stream race rather than a blanket "never crash" net
 * that would hide genuine bugs.
 */

/**
 * Whether an error is the SDK's cancelled-stream `enqueue` race and nothing
 * else. Kept pure so the decision can be exercised without spawning a process.
 */
export function isCancelledStreamEnqueueRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ERR_INVALID_STATE') return false;
  // The message Node raises when a closed ReadableStream controller is written
  // to. Guarded so an unrelated invalid-state error is never mistaken for it.
  if (!/is already closed/i.test(error.message)) return false;
  // And only on the stream-controller enqueue path: the frame is the whole
  // reason this is safe to swallow, because it is the exact call the SDK makes
  // against a controller it has not noticed is closed.
  return /ReadableStreamDefaultController\.enqueue/.test(error.stack ?? '');
}

let installed = false;

/**
 * Install the process-level guard once. Idempotent so a re-import or a test
 * cannot stack a second listener that would double-handle the same throw.
 */
export function guardCancelledStreamCrashes(
  onSwallow: (error: Error) => void = (error) =>
    console.warn(`[serving] Ignored a late chunk from a cancelled stream: ${error.message}`),
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', (error) => {
    if (error instanceof Error && isCancelledStreamEnqueueRace(error)) {
      onSwallow(error);
      return;
    }
    // Not the known-benign race. Registering any `uncaughtException` listener
    // suppresses Node's own crash, so this branch has to restore it: report the
    // exception and exit non-zero, exactly as an unguarded process would.
    console.error('Uncaught exception:', error);
    exit(1);
  });
}

/** Test-only reset so the idempotence flag does not leak between cases. */
export function resetStreamCrashGuardForTest(): void {
  installed = false;
}
