import React, { Component } from 'react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { errorSupportReferences } from './error-support';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export function ErrorFallback({
  error,
  errorInfo,
  development,
  onRecover,
  onReload,
}: {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  development: boolean;
  onRecover: () => void;
  onReload: () => void;
}) {
  const references = errorSupportReferences(error);
  return (
    <div className="min-h-screen bg-background p-4">
      <Card className="max-w-2xl mx-auto mt-8">
        <CardHeader>
          <CardTitle className="text-destructive">The application could not continue</CardTitle>
          <CardDescription>Try the page again. If it still fails, reload the application.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={onRecover}>
              <RotateCcw /> Try again
            </Button>
            <Button variant="outline" onClick={onReload}>
              <RefreshCw /> Reload application
            </Button>
          </div>
          {references.length > 0 ? (
            <Alert>
              <AlertDescription>
                <p>Include this information if you ask for help:</p>
                {references.map((reference) => (
                  <p className="font-mono text-xs" key={reference.label}>
                    {reference.label}: {reference.value}
                  </p>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          {development ? (
            <details>
              <summary className="cursor-pointer font-medium">Technical details</summary>
              <pre className="bg-muted mt-3 max-h-96 overflow-auto rounded p-3 text-sm">
                {[error?.toString(), error?.stack, errorInfo?.componentStack].filter(Boolean).join('\n\n')}
              </pre>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error);
    console.error('Error details:', errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  private recover = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          development={import.meta.env.DEV}
          onRecover={this.recover}
          onReload={() => window.location.reload()}
        />
      );
    }

    return this.props.children;
  }
}
