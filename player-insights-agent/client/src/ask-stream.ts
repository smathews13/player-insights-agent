/**
 * Asking `/api/insights/ask` for the run as it happens.
 */
import { normalizeStage, type TraceStage } from './answer-shape';
import { CORRELATION_HEADER, mintCorrelationId } from '../../shared/correlation';
import { isUnavailableResult, type UnavailableResult } from '../../shared/terminal-response';

export interface AskStreamHandlers {
  /** The browser-minted id, synchronously before the request is sent. */
  onStart?(correlationId: string): void;
  /**
   * One stage, as the agent announced it or as it finished.
   *
   * Twice per step against a model that announces: a `running` stage carrying
   * the name, kind and nesting, then the same `id` again carrying the measured
   * duration and the real status. Once per step against one that does not, in
   * which case nothing is ever `running` and the caller sees exactly what it saw
   * before. Either way the order is the order the run went in, which is the
   * order the finished trace uses.
   */
  onStage(stage: TraceStage): void;
  /**
   * The route accepted the question and opened the stream.
   */
  onOpen?(): void;
  /** Any complete SSE block, including the server's keep-alive comments. */
  onActivity?(): void;
}

export interface AskStreamResult {
  /** The response body, in the same shape the non-streaming route returns. */
  body: unknown;
  /** Whether the run was actually narrated, rather than answered in one lump. */
  streamed: boolean;
  /** The id this request went out under, and the one the server recorded it as. */
  correlationId: string;
}

/**
 * Thrown when the server refused the question and said why.
 *
 * Distinct from {@link AskRunFailed}, which is a run that started and stopped.
 * This one never ran, and the difference is what the user is shown: a refused
 * question has no stages to leave on the timeline, and it has a code and a
 * correlation id the interface must pass on rather than replace.
 */
export class AskRefused extends Error {
  readonly result: UnavailableResult;
  /**
   * Stages that finished before the refusal, when it arrived mid-stream.
   *
   * Zero for a refusal that came back as a plain JSON body, which is a request
   * that never ran. Non-zero says the run got somewhere first, and the interface
   * leaves those stages on the timeline because the user watched them happen.
   */
  readonly completed: number;
  constructor(result: UnavailableResult, completed = 0) {
    super(result.message);
    this.name = 'AskRefused';
    this.result = result;
    this.completed = completed;
  }
}

/**
 * The terminal payload from a response that failed, if it carried one.
 *
 * Reads the body rather than trusting the status, and swallows a parse failure:
 * a 502 from a proxy is HTML, and the caller's generic path is the right home
 * for it.
 */
async function readTerminal(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Thrown when the request never got a response at all.
 *
 * ITS OWN CLASS BECAUSE IT IS THE COMMONEST FAILURE HERE AND WAS THE WORST
 * DESCRIBED. A release replaces this app's server, and every question in flight
 * dies with it -- the runs measured against the deployed endpoint take between
 * 95 and 146 seconds, so a deploy landing at any point in that window ends one.
 * The browser's `fetch` rejects without a status, a body or a failure code, so
 * there is nothing to read and the old path fell through to the generic
 * DEPENDENCY_UNAVAILABLE sentence: "a service this needed did not respond just
 * now". That sends the reader to look at the agent endpoint, which was up.
 *
 * Distinct from {@link AskRunFailed}, which is a stream that opened and then
 * broke, and from {@link AskRefused}, which is a failure the server described.
 * This one is the case where nobody described anything, and the only honest
 * thing to name is the hop that did not complete.
 */
export class AskUnreachable extends Error {
  /** The browser's own words: "Failed to fetch", a DNS error, a reset. */
  readonly reason: string;
  /**
   * The id this request went out under.
   *
   * THE WHOLE REASON THE BROWSER MINTS ONE. Every other failure here arrives
   * with a server-minted correlation id in its body. This one has no body, so
   * without an id minted before the request left there is nothing to quote and
   * nothing to search the app's log for -- and this is the failure a reader hits
   * when a release lands mid-question, which is to say the commonest one.
   */
  readonly correlationId: string;
  constructor(reason: string, correlationId: string) {
    super('The app server did not answer this request.');
    this.name = 'AskUnreachable';
    this.reason = reason;
    this.correlationId = correlationId;
  }
}

/** Thrown when the run reached the agent and then stopped without answering. */
export class AskRunFailed extends Error {
  /** Stages that did arrive before it stopped. Evidence, so it is kept. */
  readonly completed: number;
  constructor(message: string, completed: number) {
    super(message);
    this.name = 'AskRunFailed';
    this.completed = completed;
  }
}

/** Thrown only for an explicit Stop, never for navigation or a dropped socket. */
export class AskCancelled extends Error {
  readonly completed: number;
  readonly correlationId: string;

  constructor(correlationId: string, completed = 0) {
    super('Stopped by you');
    this.name = 'AskCancelled';
    this.correlationId = correlationId;
    this.completed = completed;
  }
}

/** Splits an SSE stream into `{ event, data }` pairs across chunk boundaries. */
async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onActivity?: () => void
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        onActivity?.();
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          // Comments. The route sends these to open the response and to keep
          // intermediaries from buffering; they carry nothing to read.
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length > 0) yield { event, data: data.join('\n') };
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/**
 * Posts a question and reports each finished stage until the answer arrives.
 *
 * Rejects rather than resolving when the stream ends without a result, so the
 * caller cannot mistake a run that died mid-flight for one that answered. The
 * count of stages that did arrive rides along on the error, because "it stopped
 * after four steps" is a materially different thing to show a user than "it
 * never started".
 */
export async function askStreaming(
  request: unknown,
  handlers: AskStreamHandlers,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<AskStreamResult> {
  // Minted per attempt rather than per question. A retry is a different run, gets
  // a different ledger row and a different trace, and giving it the id of the
  // attempt that failed would join a reader's complaint to the wrong one.
  const correlationId = mintCorrelationId();
  handlers.onStart?.(correlationId);
  let response: Response;
  try {
    response = await fetchImpl('/api/insights/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        [CORRELATION_HEADER]: correlationId,
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AskCancelled(correlationId);
    // A `fetch` rejection is the one failure with no server side to it, so it is
    // caught here rather than left to the caller's generic branch, which had no
    // way to tell it apart from an endpoint that answered badly.
    throw new AskUnreachable(error instanceof Error ? error.message : String(error), correlationId);
  }

  const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  if (!isStream) {
    const body: unknown = response.ok ? await response.json() : await readTerminal(response);
    if (
      body &&
      typeof body === 'object' &&
      ((body as { type?: unknown }).type === 'cancelled' || (body as { state?: unknown }).state === 'CANCELLED')
    ) {
      throw new AskCancelled(correlationId);
    }
    // A refusal the server described is not the same event as a server that
    // could not be reached, and flattening the two is how an authorization
    // denial came to be shown as "the endpoint is unavailable". The caller is
    // handed the server's own code, sentence and correlation id rather than a
    // sentence invented in the browser over a payload that had all three.
    if (isUnavailableResult(body)) throw new AskRefused(body);
    if (!response.ok) throw new Error('The live agent did not return a usable answer.');
    return { body, streamed: false, correlationId };
  }
  if (!response.body) throw new Error('The live agent returned an empty stream.');

  // Announced on the headers rather than on the first byte of the body. The
  // route flushes them and writes `: open` in the same breath, so the two are
  // the same instant, and waiting for a body read would report the moment a
  // proxy chose to forward rather than the moment the run started.
  handlers.onOpen?.();

  let completed = 0;
  const reportActivity = () => handlers.onActivity?.();
  try {
    for await (const { event, data } of readEvents(response.body, signal, reportActivity)) {
      if (event === 'stage') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Progress, not the answer. A stage that cannot be read is one row
          // missing from a live view that is about to be replaced by the
          // authoritative trace anyway.
          continue;
        }
        const stage = normalizeStage(parsed, completed);
        handlers.onStage(stage);
        // Announcements do not count. `completed` is what "it stopped after four
        // steps" means on the panel below and on the error thrown at the bottom of
        // this function, and a step that has been announced and has not returned
        // is precisely the one that did not finish.
        if (stage.status !== 'running') completed += 1;
        continue;
      }
      if (event === 'result') return { body: JSON.parse(data), streamed: true, correlationId };
      if (event === 'error') {
        /**
         * THE BUG THIS BRANCH USED TO BE. `AskResponder.json` writes the terminal
         * payload as `event: error` whenever the status is 4xx or 5xx and the
         * stream is already open -- and once headers are flushed, every refusal
         * takes that route. So the full `UnavailableResult`, with the failure
         * code, the provider's status and sentence, the correlation id and the
         * executing identity, arrived here and was reduced to its `message`
         * string by `readMessage` and rethrown as a run that stopped.
         *
         * The caller then relabelled it: a stopped run is shown as
         * STREAM_INTERRUPTED, which is retryable. A reader denied SELECT on a
         * table was therefore told the connection had dropped and offered a
         * "Try again" button that could only ever deny them again -- and the
         * correlation id they would have needed to get it fixed was discarded on
         * this line. Streaming is what the browser asks for, so this was the
         * normal path and the non-streaming one below was the one that worked.
         */
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          // A frame that is not JSON carries no code to honour; the prose path
          // below is the right home for it.
        }
        if (
          parsed &&
          typeof parsed === 'object' &&
          ((parsed as { type?: unknown }).type === 'cancelled' || (parsed as { state?: unknown }).state === 'CANCELLED')
        ) {
          throw new AskCancelled(correlationId, completed);
        }
        if (isUnavailableResult(parsed)) throw new AskRefused(parsed, completed);
        const detail = readMessage(data);
        throw new AskRunFailed(detail ?? 'The agent stopped before it finished this question.', completed);
      }
    }
  } catch (error) {
    if (error instanceof AskCancelled) throw error;
    if (signal?.aborted) throw new AskCancelled(correlationId, completed);
    throw error;
  }

  // The connection closed without a terminal event: the endpoint dropped, the
  // app server restarted, or the network went. Whatever it was, no answer is
  // coming and saying so is the only honest option.
  throw new AskRunFailed(
    completed > 0
      ? `The run stopped after ${completed} step${completed === 1 ? '' : 's'} without producing an answer.`
      : 'The run stopped before the agent reported any steps.',
    completed
  );
}

function readMessage(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Falls through to the caller's default wording.
  }
  return null;
}
