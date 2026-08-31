import express from 'express';
import path from 'node:path';
import { createBrotliCompress, createGzip } from 'node:zlib';
import type { Application, NextFunction, Request, Response } from 'express';
import type { Transform } from 'node:stream';

export const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const STABLE_ASSET_CACHE_CONTROL = 'public, max-age=3600, must-revalidate';
export const APP_SHELL_CACHE_CONTROL = 'no-cache';
export const MISSING_ASSET_CACHE_CONTROL = 'no-store';
export const STATIC_COMPRESSION_THRESHOLD_BYTES = 1024;

const VITE_HASHED_FILE = /-[A-Za-z0-9_-]{8}\.[^./]+$/;

export function isContentHashedAsset(filePath: string, staticRoot: string): boolean {
  const relative = path.relative(staticRoot, filePath).split(path.sep).join('/');
  return relative.startsWith('assets/') && VITE_HASHED_FILE.test(path.posix.basename(relative));
}

function isFrontendRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return !req.path.startsWith('/api') && !req.path.startsWith('/query');
}

function isAppShellPath(req: Request): boolean {
  return req.path === '/' || req.path.endsWith('.html');
}

function isCompressible(res: Response): boolean {
  const contentType = String(res.getHeader('Content-Type') ?? '').toLowerCase();
  if (
    !contentType.startsWith('text/') &&
    !contentType.includes('javascript') &&
    !contentType.includes('json') &&
    !contentType.includes('xml') &&
    !contentType.includes('svg')
  ) {
    return false;
  }
  if (contentType.includes('text/event-stream')) return false;
  const cacheControl = String(res.getHeader('Cache-Control') ?? '').toLowerCase();
  if (cacheControl.includes('no-transform')) return false;
  const contentLength = Number(res.getHeader('Content-Length'));
  return !Number.isFinite(contentLength) || contentLength >= STATIC_COMPRESSION_THRESHOLD_BYTES;
}

function acceptedEncoding(header: string | undefined): 'br' | 'gzip' | undefined {
  if (!header) return undefined;
  const qualities = new Map<string, number>();
  for (const item of header.toLowerCase().split(',')) {
    const [name = '', ...parameters] = item.trim().split(';');
    const quality = parameters
      .map((value) => /^q=(\d(?:\.\d+)?)$/.exec(value.trim())?.[1])
      .find((value) => value !== undefined);
    qualities.set(name, quality === undefined ? 1 : Math.max(0, Math.min(1, Number(quality))));
  }
  const wildcard = qualities.get('*') ?? 0;
  const brotli = qualities.get('br') ?? wildcard;
  const gzip = qualities.get('gzip') ?? wildcard;
  if (brotli <= 0 && gzip <= 0) return undefined;
  return brotli >= gzip ? 'br' : 'gzip';
}

function frontendCompression(req: Request, res: Response, next: NextFunction): void {
  // Byte ranges must remain byte ranges of the stored representation. Existing
  // API/PDF/SSE routes sit before this frontend-only layer as a second boundary.
  if (req.method === 'HEAD' || req.headers.range) {
    next();
    return;
  }
  const encoding = acceptedEncoding(req.header('accept-encoding'));

  type WriteCallback = (error?: Error | null) => void;
  type Write = (chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: WriteCallback) => boolean;
  type End = (chunk?: string | Uint8Array, encoding?: BufferEncoding, callback?: () => void) => Response;
  const originalWrite = res.write.bind(res) as Write;
  const originalEnd = res.end.bind(res) as End;
  let compressor: Transform | undefined;
  let decided = false;

  const decide = () => {
    if (decided) return;
    decided = true;
    if (!isCompressible(res) || res.statusCode === 204 || res.statusCode === 304) return;

    res.vary('Accept-Encoding');
    if (!encoding) return;
    res.setHeader('Content-Encoding', encoding);
    res.removeHeader('Content-Length');
    compressor = encoding === 'br' ? createBrotliCompress() : createGzip();
    compressor.on('data', (chunk: Buffer) => {
      if (!originalWrite(chunk)) {
        compressor?.pause();
        res.once('drain', () => compressor?.resume());
      }
    });
    compressor.on('end', () => originalEnd());
    compressor.on('error', (error) => res.destroy(error));
  };

  res.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ) => {
    decide();
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (compressor) return encoding ? compressor.write(chunk, encoding, done) : compressor.write(chunk, done);
    return originalWrite(chunk, encoding, done);
  }) as typeof res.write;
  res.end = ((
    chunk?: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void
  ) => {
    decide();
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (!compressor) return originalEnd(chunk, encoding, done);
    if (done) res.once('finish', done);
    if (encoding) compressor.end(chunk, encoding);
    else compressor.end(chunk);
    return res;
  }) as typeof res.end;

  next();
}

export interface StaticDeliveryOptions {
  staticRoot?: string;
  environment?: string;
}

/**
 * Installs a production-only frontend layer before AppKit's built-in static
 * server. Existing API routes have already been registered, so their cache,
 * session, streaming, and PDF behavior is untouched.
 */
export function registerStaticDelivery(app: Application, options: StaticDeliveryOptions = {}): void {
  if ((options.environment ?? process.env.NODE_ENV) !== 'production') return;

  const staticRoot = options.staticRoot ?? path.resolve(process.cwd(), 'client', 'dist');
  const serveStatic = express.static(staticRoot, {
    index: false,
    setHeaders(res, filePath) {
      res.setHeader(
        'Cache-Control',
        isContentHashedAsset(filePath, staticRoot) ? HASHED_ASSET_CACHE_CONTROL : STABLE_ASSET_CACHE_CONTROL
      );
    },
  });

  app.use((req, res, next) => {
    if (!isFrontendRequest(req)) {
      next();
      return;
    }
    frontendCompression(req, res, next);
  });

  app.use((req, res, next) => {
    // AppKit injects runtime configuration into index.html. Let its catch-all
    // own every shell response so direct and client-routed loads share the same
    // revalidation policy.
    if (!isFrontendRequest(req) || isAppShellPath(req)) {
      next();
      return;
    }
    serveStatic(req, res, next);
  });

  // A stale index can request an old hashed filename after a deployment. It
  // must get a real miss, not AppKit's HTML fallback cached as immutable JS.
  app.use('/assets', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    res.setHeader('Cache-Control', MISSING_ASSET_CACHE_CONTROL);
    res.status(404).type('text/plain').send('Asset not found');
  });

  app.use((req, res, next) => {
    if (isFrontendRequest(req)) res.setHeader('Cache-Control', APP_SHELL_CACHE_CONTROL);
    next();
  });
}
