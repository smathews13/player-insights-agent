import { createRequire } from 'node:module';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import express from 'express';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_SHELL_CACHE_CONTROL,
  HASHED_ASSET_CACHE_CONTROL,
  MISSING_ASSET_CACHE_CONTROL,
  registerStaticDelivery,
  STABLE_ASSET_CACHE_CONTROL,
} from './static-delivery';

const require = createRequire(import.meta.url);
const HASHED_JS = '/assets/app-ABCDEFGH.js';
const UNHASHED_JS = '/assets/runtime.js';
const FONT = '/fonts/DMSans-variable.woff2';
const LARGE_JS = `globalThis.__asset = ${JSON.stringify('cacheable '.repeat(800))};`;
const LARGE_HTML = `<!doctype html><html><body><main>${'shell '.repeat(800)}</main></body></html>`;

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

let server: Server | undefined;
let base = '';
let temporary = '';

async function loadStaticServer() {
  const appkit = require.resolve('@databricks/appkit');
  const modulePath = path.join(path.dirname(appkit), 'plugins', 'server', 'static-server.js');
  return (await import(pathToFileURL(modulePath).href)) as {
    StaticServer: new (app: express.Application, staticPath: string) => { setup(): void };
  };
}

function read(pathname: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'astrolabe-static-delivery-'));
  await mkdir(path.join(temporary, 'assets'), { recursive: true });
  await mkdir(path.join(temporary, 'fonts'), { recursive: true });
  await Promise.all([
    writeFile(path.join(temporary, 'index.html'), LARGE_HTML),
    writeFile(path.join(temporary, HASHED_JS), LARGE_JS),
    writeFile(path.join(temporary, UNHASHED_JS), LARGE_JS),
    writeFile(path.join(temporary, FONT), Buffer.alloc(4096, 7)),
  ]);

  const app = express();
  // Production APIs already exist before the frontend layer is extended into
  // AppKit. These two pin the security consequence of that ordering.
  app.get('/api/private-json', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ value: 'private '.repeat(800) });
  });
  app.get('/api/admin/access-guide', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('application/pdf').send(Buffer.from('%PDF-1.7\nconfidential'));
  });

  registerStaticDelivery(app, { environment: 'production', staticRoot: temporary });
  const { StaticServer } = await loadStaticServer();
  new StaticServer(app, temporary).setup();

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server?.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  await rm(temporary, { recursive: true, force: true });
});

describe('production static delivery', () => {
  it.each([
    ['gzip', gunzipSync],
    ['br', brotliDecompressSync],
  ] as const)('serves content-hashed assets immutable with %s compression', async (encoding, decompress) => {
    const response = await read(HASHED_JS, { 'accept-encoding': encoding });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe(HASHED_ASSET_CACHE_CONTROL);
    expect(response.headers['content-type']).toMatch(/^application\/javascript/);
    expect(response.headers['content-encoding']).toBe(encoding);
    expect(response.headers.vary).toContain('Accept-Encoding');
    expect(response.headers.etag).toBeTruthy();
    expect(decompress(response.body).toString()).toBe(LARGE_JS);
    expect(response.body.byteLength).toBeLessThan(Buffer.byteLength(LARGE_JS) / 4);
  });

  it('revalidates the app shell on direct and client-routed loads', async () => {
    for (const pathname of ['/', '/index.html', '/monitoring']) {
      const response = await read(pathname, { 'accept-encoding': 'gzip' });
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe(APP_SHELL_CACHE_CONTROL);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(response.body).toString()).toContain('<main>');
    }
  });

  it('uses a conservative policy for stable filenames', async () => {
    const unhashed = await read(UNHASHED_JS);
    const font = await read(FONT, { 'accept-encoding': 'gzip' });

    expect(unhashed.headers['cache-control']).toBe(STABLE_ASSET_CACHE_CONTROL);
    expect(font.headers['cache-control']).toBe(STABLE_ASSET_CACHE_CONTROL);
    expect(font.headers['content-type']).toBe('font/woff2');
    expect(font.headers['content-encoding']).toBeUndefined();
    expect(font.headers['accept-ranges']).toBe('bytes');
    expect(font.headers.etag).toBeTruthy();
  });

  it('returns a real no-store miss for stale hashed URLs', async () => {
    const response = await read('/assets/missing-ZYXWVUTS.js', { 'accept-encoding': 'gzip' });

    expect(response.status).toBe(404);
    expect(response.headers['cache-control']).toBe(MISSING_ASSET_CACHE_CONTROL);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.body.toString()).toBe('Asset not found');
  });

  it('keeps range responses byte-addressable and uncompressed', async () => {
    const response = await read(HASHED_JS, {
      range: 'bytes=0-31',
      'accept-encoding': 'gzip',
    });

    expect(response.status).toBe(206);
    expect(response.headers['cache-control']).toBe(HASHED_ASSET_CACHE_CONTROL);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-range']).toBe(`bytes 0-31/${Buffer.byteLength(LARGE_JS)}`);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body.toString()).toBe(LARGE_JS.slice(0, 32));
  });

  it('preserves validators and sends no body for a warm conditional read', async () => {
    const cold = await read(HASHED_JS);
    const warm = await read(HASHED_JS, { 'if-none-match': String(cold.headers.etag) });

    expect(cold.body.byteLength).toBe(Buffer.byteLength(LARGE_JS));
    expect(cold.headers.vary).toContain('Accept-Encoding');
    expect(warm.status).toBe(304);
    expect(warm.headers['cache-control']).toBe(HASHED_ASSET_CACHE_CONTROL);
    expect(warm.body.byteLength).toBe(0);
  });

  it('does not alter API or confidential PDF delivery', async () => {
    const json = await read('/api/private-json', { 'accept-encoding': 'gzip' });
    const pdf = await read('/api/admin/access-guide', { 'accept-encoding': 'gzip' });

    expect(json.headers['cache-control']).toBe('private, no-store');
    expect(json.headers['content-encoding']).toBeUndefined();
    expect(json.headers.vary).toBeUndefined();
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-encoding']).toBeUndefined();
    expect(pdf.headers.vary).toBeUndefined();
  });
});
