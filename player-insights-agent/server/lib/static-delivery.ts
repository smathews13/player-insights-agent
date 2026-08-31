import express from 'express';
import path from 'node:path';
import type { Application, NextFunction, Request, Response } from 'express';

export const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const STABLE_ASSET_CACHE_CONTROL = 'public, max-age=3600, must-revalidate';
export const APP_SHELL_CACHE_CONTROL = 'no-cache';
export const MISSING_ASSET_CACHE_CONTROL = 'no-store';

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
