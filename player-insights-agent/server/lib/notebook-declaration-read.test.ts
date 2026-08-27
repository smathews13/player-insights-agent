/**
 * Fetching a published declaration, and the states that are not a fault.
 *
 * Every identifier is invented.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  declarationStatement,
  isDeclarationLocation,
  readPublishedDeclaration,
} from './notebook-declaration-read';

const LOCATION = 'customer_catalog.agent_config.declarations';
const HOST = 'https://example-workspace.invalid';

const DOCUMENT = JSON.stringify({
  source: '/Workspace/Users/analyst@example.invalid/insights-agent',
  revision: 'rev-41',
  settings: { warehouse_id: 'wh-00000000000000aa' },
  connections: [],
});

function answering(body: unknown, status = 200): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  ) as unknown as typeof fetch;
}

function succeeded(document: string | null) {
  return {
    status: { state: 'SUCCEEDED' },
    result: document === null ? {} : { data_array: [[document]] },
  };
}

async function read(overrides: Parameters<typeof readPublishedDeclaration>[0]) {
  return readPublishedDeclaration(overrides);
}

describe('the location a statement will be built for', () => {
  it('accepts a three-part name', () => {
    expect(isDeclarationLocation(LOCATION)).toBe(true);
    expect(declarationStatement(LOCATION)).toContain(LOCATION);
  });

  /**
   * The whole defence. An identifier cannot be a bound parameter and the Statement
   * Execution API offers no identifier binding, so the shape is the guard and it
   * has to hold against the obvious attempts.
   */
  it('refuses anything that is not three plain segments', () => {
    for (const bad of [
      'two.parts',
      'four.parts.are.too.many',
      'a.b.c; DROP TABLE x',
      'a.b.c UNION SELECT secret FROM y',
      'a.b.`c`',
      "a.b.c'",
      'a.b.c--comment',
      'a.b.c /* comment */',
      '1bad.b.c',
      'a..c',
      '',
      '   ',
    ]) {
      expect.soft(isDeclarationLocation(bad), bad).toBe(false);
    }
  });

  it('builds no statement for a location it refused', async () => {
    const call = answering(succeeded(DOCUMENT));
    const result = await read({
      location: 'a.b.c; DROP TABLE x',
      warehouseId: 'wh-1',
      host: HOST,
      token: 'token',
      fetchImpl: call,
    });
    expect(result.failure).toBe('bad-location');
    expect(call).not.toHaveBeenCalled();
  });
});

describe('reading it as the person looking at the page', () => {
  it('reads a published declaration', async () => {
    const result = await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: 'token',
      fetchImpl: answering(succeeded(DOCUMENT)),
    });
    expect(result.failure).toBeNull();
    expect(result.declaration?.revision).toBe('rev-41');
  });

  it('sends the reader’s own token and nothing else', async () => {
    const call = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(succeeded(DOCUMENT)), { status: 200 }))
    ) as unknown as typeof fetch;
    await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: 'forwarded-user-token',
      fetchImpl: call,
    });
    const [, init] = (call as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer forwarded-user-token');
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as Record<string, unknown>;
    expect(body.query_tags).toEqual([
      { key: 'application', value: 'Astrolabe' },
      { key: 'surface', value: 'declaration' },
      { key: 'tool', value: 'notebook_declaration' },
      { key: 'operation', value: 'read' },
    ]);
    expect(JSON.stringify(body.query_tags)).not.toContain(LOCATION);
    expect(JSON.stringify(body.query_tags)).not.toContain('analyst@example.invalid');
  });

  /**
   * Without a forwarded token there is nobody to read as, and the app must not
   * fall back to its own identity. Three service-principal read paths were closed
   * in this deployment on purpose.
   */
  it('does not read at all when no token was forwarded', async () => {
    const call = answering(succeeded(DOCUMENT));
    const result = await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: '',
      fetchImpl: call,
    });
    expect(result.failure).toBe('no-token');
    expect(call).not.toHaveBeenCalled();
  });

  it('reads a refusal as the reader’s own missing grant', async () => {
    for (const status of [401, 403]) {
      const result = await read({
        location: LOCATION,
        warehouseId: 'wh-1',
        host: HOST,
        token: 'token',
        fetchImpl: answering({}, status),
      });
      expect.soft(result.failure, String(status)).toBe('refused');
      expect.soft(result.detail).toMatch(/SELECT/);
    }
  });

  /**
   * The distinction worth having: the table is there and the grant is fine, so
   * what is missing is a publish. Reported as its own state rather than as a
   * failure the reader would go and debug.
   */
  it('tells an empty table apart from a failed read', async () => {
    const empty = await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: 'token',
      fetchImpl: answering(succeeded(null)),
    });
    expect(empty.failure).toBe('empty');

    const broken = await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: 'token',
      fetchImpl: answering({ status: { state: 'FAILED' }, result: {} }),
    });
    expect(broken.failure).toBe('unavailable');
  });

  it('says nothing is connected when no location is configured', async () => {
    const result = await read({ location: '  ', warehouseId: 'wh-1', host: HOST, token: 'token' });
    expect(result.failure).toBe('not-configured');
  });

  it('says nothing is connected when there is no warehouse to read on', async () => {
    const result = await read({
      location: LOCATION,
      warehouseId: '',
      host: HOST,
      token: 'token',
      fetchImpl: answering(succeeded(DOCUMENT)),
    });
    expect(result.failure).toBe('not-configured');
  });

  it('reads a row that is not a declaration as unreadable, not as empty', async () => {
    for (const document of ['not json at all', '{"settings":{},"connections":[]}', '[]']) {
      const result = await read({
        location: LOCATION,
        warehouseId: 'wh-1',
        host: HOST,
        token: 'token',
        fetchImpl: answering(succeeded(document)),
      });
      expect.soft(result.failure, document).toBe('unreadable');
    }
  });

  it('refuses a document larger than the cap rather than parsing it', async () => {
    const huge = `{"settings":{"note":"${'x'.repeat(70_000)}"}}`;
    const result = await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: 'token',
      fetchImpl: answering(succeeded(huge)),
    });
    expect(result.failure).toBe('unreadable');
  });

  /**
   * Never rejects. This is one row on the page somebody opens to find out why the
   * deployment is misbehaving.
   */
  it('answers rather than throwing when the request fails outright', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: 'token',
      fetchImpl: (() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch,
    });
    expect(result.failure).toBe('unavailable');
    warn.mockRestore();
  });

  it('answers rather than throwing when the body is not JSON', async () => {
    const result = await read({
      location: LOCATION,
      warehouseId: 'wh-1',
      host: HOST,
      token: 'token',
      fetchImpl: (() => Promise.resolve(new Response('<html>gateway</html>', { status: 200 }))) as unknown as typeof fetch,
    });
    expect(result.failure).toBe('unavailable');
  });

  it('writes no em dash into anything a reader sees', async () => {
    for (const failure of ['not-configured', 'bad-location', 'no-token'] as const) {
      const result = await read({
        location: failure === 'bad-location' ? 'two.parts' : failure === 'not-configured' ? '' : LOCATION,
        warehouseId: 'wh-1',
        host: HOST,
        token: failure === 'no-token' ? '' : 'token',
      });
      expect.soft(result.detail, result.detail).not.toMatch(/—/);
    }
  });
});
