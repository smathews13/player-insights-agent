/**
 * Reading a Model Serving `/invocations` response that arrived as Server-Sent
 * Events instead of one JSON body.
 */

import { servingMlflowTraceId } from '../../shared/mlflow-trace-id';
import { isRunCancelledError, throwIfRunCancelled } from './run-cancellation';

/** One `data:` payload, already parsed. Shapes beyond this are the caller's. */
interface StreamEvent {
  type?: unknown;
  item?: unknown;
  custom_outputs?: unknown;
  [key: string]: unknown;
}

/** The blocking-call shape the extractors in insights-routes.ts expect. */
export interface AssembledResponse {
  output: unknown[];
  custom_outputs: Record<string, unknown>;
  databricks_output?: Record<string, unknown>;
  /** Harvested from any stream event that carried a real `tr-` id. */
  trace_id?: string;
}

export type StageSink = (stage: Record<string, unknown>) => void;

/**
 * A stream that ended before the answer, as distinct from an endpoint that
 * could not be reached.
 *
 * Its own class because the two deserve opposite responses and the message is
 * not a safe thing to branch on. This one says nothing about the endpoint's
 * health: the run it belongs to has been observed finishing normally and
 * recording an OK trace while the app saw the stream stop after two stages. So
 * it is worth asking again on the blocking transport, where an endpoint that
 * genuinely cannot be reached is not.
 */
export class TruncatedStreamError extends Error {
  /**
   * Stages that reported finished work.
   *
   * COUNTS WORK, NOT EVENTS, because this is the number the transport branches
   * on when it decides whether asking again would run the stack twice. A
   * `running` announcement says a step has started and nothing else: no tool
   * has returned, nothing has been read, and there is no result a second
   * attempt could duplicate. Counting those made a stream that died after two
   * early pings look like a run worth keeping, so the blocking fallback -- the
   * one path that still produces an answer at that point -- was skipped and the
   * reader got STREAM_INTERRUPTED instead.
   */
  readonly stages: number;

  /** `running` announcements seen, kept so the log says what actually arrived. */
  readonly announced: number;

  constructor(stages: number, announced = 0) {
    const alsoSeen = announced > 0 ? ` (and ${announced} announcement(s))` : '';
    super(`The endpoint's stream ended after ${stages} stage(s)${alsoSeen} without returning an answer.`);
    this.name = 'TruncatedStreamError';
    this.stages = stages;
    this.announced = announced;
  }
}

/**
 * Whether an event is a progress report rather than part of the answer.
 *
 * Keyed on `custom_outputs.type`, which is what `predict_stream` sets, rather
 * than on the event's `type`: every event it emits is a
 * `response.output_item.done`, including the stages, because that is the only
 * event type the ResponsesAgent stream schema has for a whole item. Reading the
 * outer type would file every stage as part of the answer and put "Chose the
 * next step" on screen as the narrative.
 */
function stageOf(event: StreamEvent): Record<string, unknown> | null {
  const custom = event.custom_outputs;
  if (!custom || typeof custom !== 'object') return null;
  const record = custom as Record<string, unknown>;
  if (record.type !== 'stage') return null;
  const stage = record.stage;
  return stage && typeof stage === 'object' ? (stage as Record<string, unknown>) : null;
}

/**
 * Whether an event exists only to push the event before it out of the endpoint.
 */
function isFlush(event: StreamEvent): boolean {
  return event.type === 'response.in_progress';
}

/**
 * Whether a stage is the announcement of a step rather than the report of one.
 *
 * `predict_stream` writes two events per step sharing a `stage_id`: a `running`
 * one carrying the name, kind and nesting so a row can be drawn while the step
 * is still going, then the same step again with its measured duration and real
 * status. Only the second is in the finished trace, and only the second means
 * anything happened that a retry would repeat.
 *
 * A stage with no status at all is treated as work. Only `running` is an
 * announcement; anything else -- including a status from a model version this
 * app has not seen -- is a step reporting an outcome, and guessing otherwise
 * would re-run a stack that had already done governed reads.
 */
function isAnnouncement(stage: Record<string, unknown>): boolean {
  return stage.status === 'running';
}

/**
 * Splits an SSE byte stream into decoded `data:` payloads.
 *
 * Buffers across chunk boundaries because a chunk is a TCP-sized slice with no
 * relationship to event boundaries: on a real run the events are large enough
 * (a stage carries its tool's whole output) that one routinely spans several
 * chunks, and parsing per-chunk would drop most of them.
 */
export async function* sseEvents(body: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of toChunks(body, signal)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    // SSE separates events with a blank line. \r\n\r\n is tolerated because the
    // spec permits it and a proxy is free to rewrite line endings.
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      // The separator is consumed by matching it rather than by adding a fixed
      // width, because `\r?\n\r?\n` is two, three or four characters and
      // guessing wrong leaves a stray newline that makes the next block's
      // `data:` prefix stop matching -- dropping every remaining event.
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }
  // A final event with no trailing blank line. Servers should send one; this
  // costs a line and removes a dependency on them having done so.
  const trailing = parseBlock(buffer);
  if (trailing) yield trailing;
}

function parseBlock(block: string): StreamEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    // A single unreadable event is not worth abandoning the run over: the
    // stages are progress, and the final payload arrives in its own event. If
    // the *final* one was the unreadable one, `consumeServingStream` throws
    // below for having found no answer, which is the honest outcome.
    console.warn('[serving] Skipped an unparseable stream event.');
    return null;
  }
}

/** Accepts a web ReadableStream or a Node readable; the SDK returns the former. */
async function* toChunks(body: unknown, signal?: AbortSignal): AsyncGenerator<Uint8Array | string> {
  if (!body) throw new Error('The endpoint returned a streaming response with no body.');
  throwIfRunCancelled(signal);
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const abort = () => {
      void reader.cancel(signal?.reason).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        throwIfRunCancelled(signal);
        if (done) return;
        if (value) yield value;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const nodeBody = body as AsyncIterable<Uint8Array | string> & { destroy?: (error?: Error) => void };
    const abort = () => nodeBody.destroy?.(signal?.reason instanceof Error ? signal.reason : undefined);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of nodeBody) {
        throwIfRunCancelled(signal);
        yield chunk;
      }
      throwIfRunCancelled(signal);
      return;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  throw new Error('The endpoint returned a streaming response body that cannot be read.');
}

/**
 * Drains a streamed invocation, reporting stages to `onStage` as they arrive
 * and returning the finished response in the blocking call's shape.
 */
export async function consumeServingStream(
  body: unknown,
  onStage: StageSink,
  signal?: AbortSignal
): Promise<AssembledResponse> {
  const output: unknown[] = [];
  let customOutputs: Record<string, unknown> | null = null;
  let databricksOutput: Record<string, unknown> | null = null;
  let streamTraceId = '';
  let stages = 0;
  let announced = 0;

  try {
    for await (const event of sseEvents(body, signal)) {
      if (isFlush(event)) continue;
      // Stage events used to `continue` before this read, so a `tr-` that
      // serving put on an early event (and a UUID on the final envelope) was
      // dropped. Bind the first real id; a UUID request id is not one.
      if (!streamTraceId) streamTraceId = servingMlflowTraceId(event);
      const stage = stageOf(event);
      if (stage) {
        // Both halves of the pair are forwarded: the live rail draws its row
        // from the announcement. Only the reporting half is counted.
        if (isAnnouncement(stage)) announced += 1;
        else stages += 1;
        try {
          onStage(stage);
        } catch (error) {
          // The sink writes to a client socket, which can close mid-run. Losing
          // the browser is not a reason to abandon the run: the answer is still
          // wanted, because it is also being written to Lakebase.
          console.warn('[serving] Stage could not be forwarded:', (error as Error).message);
        }
        continue;
      }
      if (event.item !== undefined) output.push(event.item);
      if (event.custom_outputs && typeof event.custom_outputs === 'object') {
        customOutputs = event.custom_outputs as Record<string, unknown>;
      }
      const platform = event.databricks_output;
      if (platform && typeof platform === 'object') {
        databricksOutput = platform as Record<string, unknown>;
      }
    }
  } catch (error) {
    if (isRunCancelledError(error) || signal?.aborted) {
      throwIfRunCancelled(signal);
      throw error;
    }
    // The socket died part-way through. undici reports this as a bare
    // `aborted`, which is indistinguishable by message from an endpoint that
    // was never reachable, and the route's catch treats the latter as grounds
    // for a representative answer. Reaching here having already read stages is
    // positive evidence the endpoint was not only reachable but working, so it
    // is reclassified rather than rethrown; an answer already in hand is kept.
    if (customOutputs === null && output.length === 0) {
      console.warn(
        `[serving] Stream died after ${stages} stage(s) and ${announced} announcement(s): ${(error as Error).message}`
      );
      throw new TruncatedStreamError(stages, announced);
    }
    console.warn(`[serving] Stream died after the answer arrived (${(error as Error).message}); keeping it.`);
  }

  throwIfRunCancelled(signal);
  if (customOutputs === null && output.length === 0) {
    throw new TruncatedStreamError(stages, announced);
  }
  return {
    output,
    custom_outputs: customOutputs ?? {},
    ...(databricksOutput ? { databricks_output: databricksOutput } : {}),
    ...(streamTraceId ? { trace_id: streamTraceId } : {}),
  };
}
