/**
 * Bounds on how long the app will wait for something outside it.
 *
 * Every call this server makes over the network can hang: a socket that is open
 * and silent never rejects, and a request handler awaiting one waits forever.
 * The benchmark runner and the judges each grew their own copy of this because
 * they were the paths somebody had watched fail; the interactive paths (the ask
 * route, preflight, the access checks), had none, so a single hung socket held a
 * user's question open with nothing on screen and no error to report.
 */

/**
 * Stop waiting for `work` after `ms`.
 *
 * The underlying call is not cancelled, because most of the transports here
 * expose no signal to cancel with, so a timed-out call may still complete, and
 * its result is discarded. `message` should say so where a person will read it:
 * "did not answer" is true, "was cancelled" would not be.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        // Losing the race must not hold the process open on a pending timer.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
