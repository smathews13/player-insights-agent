import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BROWSE_ROUTE_DEADLINE_MS } from './browse-routes';

const source = readFileSync(new URL('browse-routes.ts', import.meta.url), 'utf8');

describe('browse route bounds', () => {
  it('gives every route a deadline and propagates browser disconnects', () => {
    expect(BROWSE_ROUTE_DEADLINE_MS).toBe(10_000);
    expect(source).toContain("req.once('aborted', abortDisconnected)");
    expect(source).toContain('AbortSignal.timeout(BROWSE_ROUTE_DEADLINE_MS)');
    expect(source).toContain('signal,');
    expect(source).toContain('if (!res.destroyed && !res.writableEnded)');
  });

  it('keeps cache identity tied to the authenticated user and execution token', () => {
    expect(source).toContain("principal: req.header('x-forwarded-email')");
    expect(source).toContain('token: executionToken(req)');
  });

  it('bounds page cursors before calling a workspace API', () => {
    expect(source).toContain('PAGE_TOKEN_MAX_LENGTH = 2_048');
    expect(source).toContain('rawToken.length > PAGE_TOKEN_MAX_LENGTH');
    expect(source).toContain('page: pageNumber(req)');
  });
});
