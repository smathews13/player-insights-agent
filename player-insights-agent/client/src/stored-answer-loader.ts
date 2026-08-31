import { lazy } from 'react';

type StoredAnswerRendererModule = typeof import('./StoredAnswerRenderer');
type StoredAnswerRendererImporter = () => Promise<StoredAnswerRendererModule>;

/**
 * One shared request for the answer-only graph.
 *
 * The rejected request is deliberately forgotten. A transient chunk failure can
 * then be retried without dropping the raw answer that the boundary keeps on
 * screen.
 */
export function createStoredAnswerRendererPreloader(
  importer: StoredAnswerRendererImporter = () => import('./StoredAnswerRenderer')
) {
  let request: Promise<StoredAnswerRendererModule> | null = null;
  return () => {
    request ??= importer().catch((error: unknown) => {
      request = null;
      throw error;
    });
    return request;
  };
}

export const preloadStoredAnswerRenderer = createStoredAnswerRendererPreloader();

/** Starts prefetch without putting module resolution on the request/SSE path. */
export function startStoredAnswerRendererPreload(
  preload: () => Promise<StoredAnswerRendererModule> = preloadStoredAnswerRenderer
): void {
  void preload().catch(() => undefined);
}

/** A fresh React.lazy wrapper lets an error boundary retry a rejected import. */
export function lazyStoredAnswerRenderer() {
  return lazy(preloadStoredAnswerRenderer);
}
