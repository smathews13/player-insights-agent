import { Component, Suspense, type ErrorInfo, type LazyExoticComponent } from 'react';

import { Button, Card, CardContent, CardHeader, Skeleton } from './ui';
import { createLazyStoredAnswerRenderer, preloadStoredAnswerRenderer } from './stored-answer-loader';
import type StoredAnswerRenderer from './StoredAnswerRenderer';
import type { StoredAnswerRendererProps } from './StoredAnswerRenderer';

type LazyRenderer = LazyExoticComponent<typeof StoredAnswerRenderer>;
let sharedLazyRenderer = createLazyStoredAnswerRenderer();

function freshLazyRenderer(): LazyRenderer {
  sharedLazyRenderer = createLazyStoredAnswerRenderer();
  return sharedLazyRenderer;
}

class AnswerChunkErrorBoundary extends Component<
  StoredAnswerRendererProps,
  { failed: boolean; Renderer: LazyRenderer }
> {
  state = { failed: false, Renderer: sharedLazyRenderer };

  static getDerivedStateFromError() {
    return { failed: true } as const;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[answer-renderer] The stored-answer chunk could not be loaded.', error, info.componentStack);
  }

  render() {
    const loaded = preloadStoredAnswerRenderer.peek();
    if (loaded) {
      const Renderer = loaded.default;
      return <Renderer {...this.props} />;
    }
    if (this.state.failed) {
      return <StoredAnswerLoadError onRetry={() => this.setState({ failed: false, Renderer: freshLazyRenderer() })} />;
    }
    const { Renderer } = this.state;
    return (
      <Suspense fallback={<StoredAnswerLoading />}>
        <Renderer {...this.props} />
      </Suspense>
    );
  }
}

export function StoredAnswerLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="answer-card stored-answer-error" role="alert">
      <CardContent className="stored-answer-error-content space-y-3">
        <p className="font-medium">The saved answer could not be formatted.</p>
        <p className="text-sm text-muted-foreground">Its data is still available. Retry the answer renderer.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry answer
        </Button>
      </CardContent>
    </Card>
  );
}

export function StoredAnswerLoading() {
  return (
    <Card
      className="answer-card stored-answer-loading"
      aria-busy="true"
      aria-live="polite"
      aria-label="Formatting saved answer"
      role="status"
    >
      <CardHeader className="stored-answer-skeleton-header">
        <Skeleton className="stored-answer-skeleton-badge" aria-hidden="true" />
        <Skeleton className="stored-answer-skeleton-title" aria-hidden="true" />
        <Skeleton className="stored-answer-skeleton-subtitle" aria-hidden="true" />
      </CardHeader>
      <CardContent className="stored-answer-skeleton-content">
        <div className="stored-answer-skeleton-copy" aria-hidden="true">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
        <div className="stored-answer-skeleton-figure" aria-hidden="true">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
        <span className="sr-only">Formatting saved answer…</span>
      </CardContent>
    </Card>
  );
}

export function StoredAnswerBoundary(props: StoredAnswerRendererProps) {
  return <AnswerChunkErrorBoundary {...props} />;
}
