

// server/lib/handler-failures.ts
function answerRatherThanExit(app) {
  for (const method of ["get", "post", "put", "patch", "delete", "options", "head", "all"]) {
    const register = app[method].bind(app);
    app[method] = ((...args) => register(...args.map(guardArgument)));
  }
}
function guardArgument(argument) {
  if (Array.isArray(argument)) return argument.map(guardArgument);
  if (typeof argument !== "function") return argument;
  const handler = argument;
  if (handler.length === 4) return handler;
  if (typeof handler.handle === "function" && typeof handler.set === "function") return handler;
  return guarded(handler);
}
function guarded(handler) {
  return function guardedHandler(req, res, next) {
    let outcome;
    try {
      outcome = handler(req, res, next);
    } catch (error) {
      next(error);
      return;
    }
    if (outcome instanceof Promise) {
      outcome.catch((error) => {
        console.error(
          `[request] ${req.method} ${req.originalUrl} failed in its handler and is being answered 500: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
        );
        next(error);
      });
    }
  };
}
function respondToHandlerFailures(app) {
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error(
      `[request] ${req.method} ${req.originalUrl} is being answered 500: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    res.status(500).json({
      error: "request_failed",
      message: "This request failed inside the app rather than being refused. The app is still running; the failure is recorded in its logs."
    });
  });
}

export {
  answerRatherThanExit,
  respondToHandlerFailures
};
