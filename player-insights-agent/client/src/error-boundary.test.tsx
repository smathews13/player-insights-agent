import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ErrorInfo } from 'react';
import { ErrorFallback } from './ErrorBoundary';
import { errorSupportReferences } from './error-support';

const error = Object.assign(new Error('private rendering detail'), {
  correlationId: 'corr-17',
  requestId: 'req-42',
});
error.stack = 'Error: private rendering detail\n at SecretComponent';
const errorInfo = { componentStack: '\n at SecretPanel' } as ErrorInfo;

function render(development: boolean) {
  return renderToStaticMarkup(
    <ErrorFallback
      error={error}
      errorInfo={errorInfo}
      development={development}
      onRecover={() => {}}
      onReload={() => {}}
    />
  );
}

describe('production application failure UX', () => {
  it('offers recovery and support references without exposing technical details', () => {
    const markup = render(false);

    expect(markup).toContain('The application could not continue');
    expect(markup).toContain('Try again');
    expect(markup).toContain('Reload application');
    expect(markup).toContain('Correlation ID:');
    expect(markup).toContain('corr-17');
    expect(markup).toContain('Request ID:');
    expect(markup).toContain('req-42');
    expect(markup).not.toContain('private rendering detail');
    expect(markup).not.toContain('SecretComponent');
    expect(markup).not.toContain('SecretPanel');
    expect(markup).not.toContain('Technical details');
  });

  it('reads structured identifiers from route-shaped error data', () => {
    expect(errorSupportReferences({ data: { request_id: 'req-nested', correlation_id: 'corr-nested' } })).toEqual([
      { label: 'Correlation ID', value: 'corr-nested' },
      { label: 'Request ID', value: 'req-nested' },
    ]);
  });
});

describe('development application failure UX', () => {
  it('keeps the error and component stacks behind a technical disclosure', () => {
    const markup = render(true);

    expect(markup).toContain('Technical details');
    expect(markup).toContain('private rendering detail');
    expect(markup).toContain('SecretComponent');
    expect(markup).toContain('SecretPanel');
  });
});
