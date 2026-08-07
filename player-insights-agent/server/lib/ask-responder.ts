/**
 * One answer, delivered either as the JSON body `/api/insights/ask` has always
 * returned or as a Server-Sent Event stream that narrates the run first.
 */
import type { Request, Response } from 'express';

/**
 * How often to write an SSE comment while nothing else is happening.
 *
 * Measured runs go quiet for as long as 13 seconds between stages (a single
 * `dictionary_genie` call), and a plan turn produces no stages at all before
 * its result. Neither is close to a proxy idle timeout on its own, but the
 * comment also defeats any buffer between here and the browser that is waiting
 * for a full block before forwarding, which is the failure that would make this
 * whole feature silently do nothing in production while working locally.
 */
const HEARTBEAT_MS = 15_000;

export interface AskResponder {
  /** Whether the caller asked for narration and can be sent SSE. */
  readonly wantsStream: boolean;
  /** Opens the stream, if the caller wanted one. Idempotent. */
  begin(): void;
  /** Reports one completed `TraceStage`. A no-op for a non-streaming caller. */
  stage(stage: Record<string, unknown>): void;
  status(code: number): AskResponder;
  /** The terminal call, in either mode. */
  json(body: unknown): void;
}

/**
 * A caller opts in with `Accept: text/event-stream`.
 *
 * Content negotiation rather than a query parameter or a body field, because
 * the question this asks is "what can you read", which is what Accept is for.
 * It also means the benchmark runner, curl, and any future caller keep the JSON
 * response without being changed or even knowing this exists.
 */
function acceptsEventStream(req: Request): boolean {
  return (req.header('accept') ?? '').toLowerCase().includes('text/event-stream');
}

function write(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createAskResponder(req: Request, res: Response): AskResponder {
  const wantsStream = acceptsEventStream(req);
  let statusCode = 200;
  let open = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const stop = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  // The client going away mid-run is ordinary: a closed tab, a reload. The run
  // continues, because its answer is written to Lakebase and will be there when
  // the conversation is reopened; only the narration is lost.
  res.on('close', stop);

  const responder: AskResponder = {
    wantsStream,

    begin() {
      if (!wantsStream || open) return;
      open = true;
      res.status(statusCode);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Both are for intermediaries rather than for the browser: nginx honours
      // X-Accel-Buffering, and an explicit identity encoding stops anything in
      // the path deciding to gzip a stream and buffer it whole in the process.
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Content-Encoding', 'identity');
      res.flushHeaders();
      // An immediate comment so the browser's response promise resolves now
      // rather than at the first stage. Until it does, the client cannot tell a
      // stream that has not started from a server that is not going to answer.
      res.write(': open\n\n');
      heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
      heartbeat.unref?.();
    },

    stage(stage) {
      if (!wantsStream) return;
      responder.begin();
      write(res, 'stage', stage);
    },

    status(code) {
      statusCode = code;
      return responder;
    },

    json(body) {
      stop();
      if (!open) {
        res.status(statusCode).json(body);
        return;
      }
      // Named events rather than one shape with a discriminator, so the client
      // cannot mistake a refusal for an answer by forgetting to check a field.
      // A non-2xx here arrived after the stream opened, so the status line is
      // already 200 and unchangeable; the event name carries the failure
      // instead, and the client renders it as one.
      write(res, statusCode >= 400 ? 'error' : 'result', body);
      res.end();
    },
  };

  return responder;
}
