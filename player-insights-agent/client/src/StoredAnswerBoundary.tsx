import { Component, Suspense, type ErrorInfo, type LazyExoticComponent } from 'react';

import { Button, Card, CardContent } from './ui';
import { lazyStoredAnswerRenderer } from './stored-answer-loader';
import type StoredAnswerRenderer from './StoredAnswerRenderer';
import type { StoredAnswerRendererProps } from './StoredAnswerRenderer';

type LazyRenderer = LazyExoticComponent<typeof StoredAnswerRenderer>;

class AnswerChunkErrorBoundary extends Component<
  StoredAnswerRendererProps,
  { failed: boolean; Renderer: LazyRenderer }
> {
  state = { failed: false, Renderer: lazyStoredAnswerRenderer() };

  static getDerivedStateFromError() {
    return { failed: true } as const;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[answer-renderer] The stored-answer chunk could not be loaded.', error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <Card className="answer-card stored-answer-error" role="alert">
          <CardContent className="pt-6 space-y-3">
            <p>{this.props.rawContent}</p>
            <p>The saved answer’s formatted evidence and run details could not be loaded.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => this.setState({ failed: false, Renderer: lazyStoredAnswerRenderer() })}
            >
              Retry answer
            </Button>
          </CardContent>
        </Card>
      );
    }
    const { Renderer } = this.state;
    return (
      <Suspense fallback={<StoredAnswerPreview rawContent={this.props.rawContent} />}>
        <Renderer {...this.props} />
      </Suspense>
    );
  }
}

function StoredAnswerPreview({ rawContent }: { rawContent: string }) {
  return (
    <Card className="answer-card stored-answer-loading" aria-busy="true">
      <CardContent className="pt-6 space-y-3">
        <p>{rawContent}</p>
        <p className="text-sm text-muted-foreground" role="status">
          Formatting saved answer…
        </p>
      </CardContent>
    </Card>
  );
}

export function StoredAnswerBoundary(props: StoredAnswerRendererProps) {
  return <AnswerChunkErrorBoundary {...props} />;
}
