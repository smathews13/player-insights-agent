/**
 * Asking `/api/insights/ask` for the run as it happens.
 */
import { normalizeStage, type TraceStage } from './answer-shape';

export interface AskStreamHandlers {
  /**
   * One completed stage. Called in the order the agent finished them, which is
   * also the order they will appear in the finished trace.
   */
  onStage(stage: TraceStage): void;
  /**
   * The route accepted the question and opened the stream.
   */
  onOpen?(): void;
}

export interface AskStreamResult {
  /** The response body, in the same shape the non-streaming route returns. */
  body: unknown;
  /** Whether the run was actually narrated, rather than answered in one lump. */
  streamed: boolean;
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

/** Splits an SSE stream into `{ event, data }` pairs across chunk boundaries. */
async function* readEvents(body: ReadableStream<Uint8Array>
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
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
export async function askStreaming(request: unknown,
  handlers: AskStreamHandlers,
  fetchImpl: typeof fetch = fetch
): Promise<AskStreamResult> {
  const response = await fetchImpl('/api/insights/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(request),
  });

  const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  if (!isStream) {
    // Either a refusal with a status code, or a server that does not stream.
    // Both are the pre-existing contract, and the caller's existing error
    // handling already covers a non-ok response.
    if (!response.ok) throw new Error('The live agent did not return a usable answer.');
    return { body: await response.json(), streamed: false };
  }
  if (!response.body) throw new Error('The live agent returned an empty stream.');

  // Announced on the headers rather than on the first byte of the body. The
  // route flushes them and writes `: open` in the same breath, so the two are
  // the same instant, and waiting for a body read would report the moment a
  // proxy chose to forward rather than the moment the run started.
  handlers.onOpen?.();

  let completed = 0;
  for await (const { event, data } of readEvents(response.body)) {
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
      handlers.onStage(normalizeStage(parsed, completed));
      completed += 1;
      continue;
    }
    if (event === 'result') return { body: JSON.parse(data), streamed: true };
    if (event === 'error') {
      const detail = readMessage(data);
      throw new AskRunFailed(detail ?? 'The agent stopped before it finished this question.', completed);
    }
  }

  // The connection closed without a terminal event: the endpoint dropped, the
  // app server restarted, or the network went. Whatever it was, no answer is
  // coming and saying so is the only honest option.
  throw new AskRunFailed(completed > 0
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
