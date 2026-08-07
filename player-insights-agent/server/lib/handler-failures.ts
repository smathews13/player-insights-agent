import type { Application, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Turn a failing request into a failed request, rather than a failed process.
 *
 * Express 4 catches a handler that throws synchronously and hands the error to
 * its error pipeline, which answers 500. It does not catch a handler that
 * returns a rejected promise: `async (req, res) => { throw ... }` becomes an
 * unhandled rejection, the request is left hanging with nothing written to it,
 * and Node's default for an unhandled rejection is to exit. Most of this app's
 * route handlers are `async`, so any one of them throwing outside its own
 * try/catch ends the container for everyone signed in: one request taking down
 * a shared deployment.
 */
export function answerRatherThanExit(app: Application): void {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'] as const) {
    const register = app[method].bind(app) as (...args: unknown[]) => unknown;
    // `app.get('some setting')` is the settings reader, not a route: it is left
    // alone by only touching arguments that are handler functions.
    app[method] = ((...args: unknown[]) => register(...args.map(guardArgument))) as Application[typeof method];
  }
}

function guardArgument(argument: unknown): unknown {
  if (Array.isArray(argument)) return argument.map(guardArgument);
  if (typeof argument !== 'function') return argument;
  const handler = argument as RequestHandler & { handle?: unknown; set?: unknown };
  // Error middleware is identified by arity, and a mounted router or sub-app is
  // called by Express rather than merely invoked, wrapping either would change
  // what Express thinks it was given.
  if (handler.length === 4) return handler;
  if (typeof handler.handle === 'function' && typeof handler.set === 'function') return handler;
  return guarded(handler);
}

function guarded(handler: RequestHandler): RequestHandler {
  return function guardedHandler(req: Request, res: Response, next: NextFunction) {
    let outcome: unknown;
    try {
      outcome = handler(req, res, next);
    } catch (error) {
      next(error);
      return;
    }
    if (outcome instanceof Promise) {
      outcome.catch((error: unknown) => {
        console.error(`[request] ${req.method} ${req.originalUrl} failed in its handler and is being answered 500: ` +
            `${error instanceof Error ? error.stack ?? error.message : String(error)}`
        );
        next(error);
      });
    }
  };
}

/**
 * The last word on a request nothing else answered.
 *
 * Registered after every route so that a handler failure is a JSON 500 the
 * client can read, in the same shape as every other refusal this API makes.
 * Express's own final handler would answer 500 with an HTML page, which the
 * client parses as a network fault and reports as "the app is unreachable",
 * true of nothing, and the wrong thing to go looking at.
 */
export function respondToHandlerFailures(app: Application): void {
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      // Something was already written, so there is no status left to set. Ending
      // the socket is all that is honest: the body on the wire is incomplete.
      next(error);
      return;
    }
    console.error(`[request] ${req.method} ${req.originalUrl} is being answered 500: ` +
        `${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    res.status(500).json({
      error: 'request_failed',
      message:
        'This request failed inside the app rather than being refused. The app is still running; ' +
        'the failure is recorded in its logs.',
    });
  });
}
