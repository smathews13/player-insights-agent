/**
 * A fetch that cannot hold a screen in its loading state forever.
 *
 * Aborting is best-effort: some test doubles and some transports ignore the
 * signal, so the deadline also races the request and settles independently.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    const timedOut = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`the request did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    return await Promise.race([fetch(input, { ...init, signal: controller.signal }), timedOut]);
  } finally {
    clearTimeout(timer);
    if (deadline) clearTimeout(deadline);
  }
}
