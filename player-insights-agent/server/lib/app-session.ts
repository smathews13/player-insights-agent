import { createHash, randomBytes } from 'node:crypto';
import type { Application, NextFunction, Request, Response } from 'express';
import { appTable } from '../../shared/app-schema';

export const APP_IDLE_TIMEOUT_ENV = 'PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES';
export const APP_SESSION_COOKIE = '__Host-astrolabe_session';
export const APP_IDLE_TIMEOUT_CODE = 'APP_IDLE_TIMEOUT';
export const APP_SESSION_REQUIRED_CODE = 'APP_SESSION_REQUIRED';
export const APP_SESSION_UNAVAILABLE_CODE = 'APP_SESSION_UNAVAILABLE';
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
export const MIN_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_IDLE_TIMEOUT_MINUTES = 480;
export const APP_SESSION_ABSOLUTE_SECONDS = 24 * 60 * 60;
export const APP_SESSION_ACTIVITY_THROTTLE_SECONDS = 45;
export const APP_SESSION_RETENTION_HOURS = 24;
export const APP_SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
export const APP_SESSION_TABLE = appTable('app_sessions');

const SESSION_ID_BYTES = 32;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MUTATION_HEADER = 'x-astrolabe-session-action';
const EXEMPT_API_PATHS = new Set(['/api/app-session/bootstrap', '/api/app-session/end', '/api/health', '/api/storage']);

export interface IdleTimeoutConfig {
  enabled: boolean;
  minutes: number;
  source: 'default' | 'configured' | 'clamped-min' | 'clamped-max' | 'invalid-default' | 'disabled';
}

export interface AppSessionLakebase {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface AppSessionControls {
  lakebase: AppSessionLakebase;
  identity(req: Request): string;
  config?: IdleTimeoutConfig;
  env?: NodeJS.ProcessEnv;
}

type SessionState = 'active' | 'idle_expired' | 'absolute_expired' | 'revoked';

interface SessionBinding {
  sessionHash: string;
  subject: string;
  deployment: string;
}

function stringColumn(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Resolve the app-layer idle policy. Only the literal `disabled` turns it off.
 * Invalid values fail back to the conservative default; numeric values are
 * clamped to the documented safe range.
 */
export function resolveIdleTimeout(env: NodeJS.ProcessEnv = process.env): IdleTimeoutConfig {
  const raw = (env[APP_IDLE_TIMEOUT_ENV] ?? '').trim().toLowerCase();
  if (!raw) return { enabled: true, minutes: DEFAULT_IDLE_TIMEOUT_MINUTES, source: 'default' };
  if (raw === 'disabled') return { enabled: false, minutes: 0, source: 'disabled' };
  const parsed = finiteInteger(raw);
  if (parsed === null) {
    return { enabled: true, minutes: DEFAULT_IDLE_TIMEOUT_MINUTES, source: 'invalid-default' };
  }
  if (parsed < MIN_IDLE_TIMEOUT_MINUTES) {
    return { enabled: true, minutes: MIN_IDLE_TIMEOUT_MINUTES, source: 'clamped-min' };
  }
  if (parsed > MAX_IDLE_TIMEOUT_MINUTES) {
    return { enabled: true, minutes: MAX_IDLE_TIMEOUT_MINUTES, source: 'clamped-max' };
  }
  return { enabled: true, minutes: parsed, source: 'configured' };
}

export function normalizeSessionSubject(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A deployment is part of every row key. Missing platform identity in production
 * is not replaced with a shared fallback, because that could merge sessions from
 * different apps against the same Lakebase schema.
 */
export function appSessionDeployment(env: NodeJS.ProcessEnv = process.env): string | null {
  const app = (env.DATABRICKS_APP_NAME ?? '').trim();
  const workspace = (env.DATABRICKS_WORKSPACE_ID ?? '').trim();
  if (app && workspace) return `${workspace}:${app}`;
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') return null;
  return `local:${app || 'astrolabe'}`;
}

export function createOpaqueSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString('base64url');
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('base64url');
}

export function appSessionCookie(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('Refusing to set a malformed app-session identifier.');
  return [
    `${APP_SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${APP_SESSION_ABSOLUTE_SECONDS}`,
  ].join('; ');
}

export function clearAppSessionCookie(): string {
  return [
    `${APP_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

function requestCookie(req: Request): string | null {
  const header = req.header('cookie') ?? '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== APP_SESSION_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return SESSION_ID_PATTERN.test(value) ? value : null;
  }
  return null;
}

function forwardedHost(req: Request): string {
  return (req.header('x-forwarded-host') ?? req.header('host') ?? '').split(',', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * State-changing session endpoints accept only a browser same-origin fetch with
 * the endpoint-specific custom header. Databricks proxy authentication supplies
 * identity separately; this check prevents another site from using that cookie.
 */
export function sessionMutationRefusal(req: Request, action: 'bootstrap' | 'activity' | 'end'): string {
  if (req.header(MUTATION_HEADER) !== action) return 'The required same-origin session action header is missing.';
  const fetchSite = (req.header('sec-fetch-site') ?? '').trim().toLowerCase();
  if (fetchSite === 'cross-site') return 'Cross-site session requests are not accepted.';
  const origin = (req.header('origin') ?? '').trim();
  if (!origin) return 'The request origin is required.';
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const host = forwardedHost(req);
    return host && originHost === host ? '' : 'The request origin does not match this app host.';
  } catch {
    return 'The request origin is invalid.';
  }
}

export function shouldProtectWithAppSession(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.startsWith('/api/') && !EXEMPT_API_PATHS.has(normalized);
}

async function insertSession(
  lakebase: AppSessionLakebase,
  binding: SessionBinding,
  idleMinutes: number
): Promise<void> {
  await lakebase.query(
    `INSERT INTO ${APP_SESSION_TABLE}
       (session_hash, subject, deployment_key, created_at, last_active_at,
        idle_expires_at, absolute_expires_at, retention_expires_at)
     VALUES ($1, $2, $3, NOW(), NOW(),
             NOW() + ($4 * INTERVAL '1 minute'),
             NOW() + INTERVAL '24 hours',
             NOW() + ($4 * INTERVAL '1 minute') + INTERVAL '${APP_SESSION_RETENTION_HOURS} hours')`,
    [binding.sessionHash, binding.subject, binding.deployment, idleMinutes]
  );
}

async function readSessionState(
  lakebase: AppSessionLakebase,
  binding: SessionBinding
): Promise<SessionState | 'missing' | 'mismatch'> {
  const result = await lakebase.query(
    `SELECT subject, deployment_key,
            CASE
              WHEN revoked_at IS NOT NULL THEN 'revoked'
              WHEN idle_expires_at <= NOW() THEN 'idle_expired'
              WHEN absolute_expires_at <= NOW() THEN 'absolute_expired'
              ELSE 'active'
            END AS session_state
       FROM ${APP_SESSION_TABLE}
      WHERE session_hash = $1`,
    [binding.sessionHash]
  );
  const row = result.rows[0];
  if (!row) return 'missing';
  if (normalizeSessionSubject(stringColumn(row.subject)) !== binding.subject) return 'mismatch';
  if (stringColumn(row.deployment_key) !== binding.deployment) return 'mismatch';
  const state = stringColumn(row.session_state);
  return state === 'active' || state === 'idle_expired' || state === 'absolute_expired' || state === 'revoked'
    ? state
    : 'mismatch';
}

async function revokeSession(lakebase: AppSessionLakebase, sessionHash: string): Promise<void> {
  await lakebase.query(
    `UPDATE ${APP_SESSION_TABLE}
        SET revoked_at = COALESCE(revoked_at, NOW()),
            retention_expires_at = LEAST(retention_expires_at, NOW() + INTERVAL '${APP_SESSION_RETENTION_HOURS} hours')
      WHERE session_hash = $1`,
    [sessionHash]
  );
}

async function refreshSession(
  lakebase: AppSessionLakebase,
  binding: SessionBinding,
  idleMinutes: number
): Promise<void> {
  await lakebase.query(
    `UPDATE ${APP_SESSION_TABLE}
        SET last_active_at = NOW(),
            idle_expires_at = NOW() + ($4 * INTERVAL '1 minute'),
            retention_expires_at = LEAST(
              absolute_expires_at + INTERVAL '${APP_SESSION_RETENTION_HOURS} hours',
              NOW() + ($4 * INTERVAL '1 minute') + INTERVAL '${APP_SESSION_RETENTION_HOURS} hours'
            )
      WHERE session_hash = $1
        AND subject = $2
        AND deployment_key = $3
        AND revoked_at IS NULL
        AND idle_expires_at > NOW()
        AND absolute_expires_at > NOW()
        AND last_active_at <= NOW() - INTERVAL '${APP_SESSION_ACTIVITY_THROTTLE_SECONDS} seconds'`,
    [binding.sessionHash, binding.subject, binding.deployment, idleMinutes]
  );
}

function refusal(res: Response, status: number, error: string, detail: string): void {
  res.status(status).json({ error, detail });
}

function subjectFor(req: Request, controls: AppSessionControls): string | null {
  try {
    const subject = normalizeSessionSubject(controls.identity(req));
    return subject || null;
  } catch {
    return null;
  }
}

function bindingFor(req: Request, controls: AppSessionControls): SessionBinding | null {
  const sessionId = requestCookie(req);
  const deployment = appSessionDeployment(controls.env);
  const subject = subjectFor(req, controls);
  if (!sessionId || !deployment || !subject) return null;
  try {
    return {
      sessionHash: hashSessionId(sessionId),
      subject,
      deployment,
    };
  } catch {
    return null;
  }
}

async function requireVerifiedSession(
  req: Request,
  res: Response,
  controls: AppSessionControls,
  config: IdleTimeoutConfig
): Promise<boolean> {
  const sessionId = requestCookie(req);
  const deployment = appSessionDeployment(controls.env);
  if (!deployment) {
    refusal(
      res,
      503,
      APP_SESSION_UNAVAILABLE_CODE,
      'This deployed app cannot verify which deployment owns the session.'
    );
    return false;
  }
  if (!sessionId) {
    refusal(res, 401, APP_SESSION_REQUIRED_CODE, 'Start a new Astrolabe app session from the application entry page.');
    return false;
  }
  const subject = subjectFor(req, controls);
  if (!subject) {
    refusal(res, 401, APP_SESSION_REQUIRED_CODE, 'This request carries no authenticated subject for the app session.');
    return false;
  }
  let binding: SessionBinding;
  try {
    binding = {
      sessionHash: hashSessionId(sessionId),
      subject,
      deployment,
    };
  } catch {
    refusal(res, 401, APP_SESSION_REQUIRED_CODE, 'This request carries no authenticated subject for the app session.');
    return false;
  }
  try {
    const state = await readSessionState(controls.lakebase, binding);
    if (state === 'active') return true;
    if (state === 'idle_expired' || state === 'absolute_expired' || state === 'revoked') {
      try {
        await revokeSession(controls.lakebase, binding.sessionHash);
      } catch {
        // The timeout decision came from the authoritative read. Cookie clearing
        // and refusal do not depend on the retention write succeeding.
      }
      res.setHeader('Set-Cookie', clearAppSessionCookie());
      refusal(
        res,
        401,
        APP_IDLE_TIMEOUT_CODE,
        `This Astrolabe app session ended after ${config.minutes} minutes without explicit user activity.`
      );
      return false;
    }
    // Unknown or cross-bound identifiers are not timeout tombstones. Clear the
    // unusable value, but still refuse this request; only a later explicit
    // bootstrap may create a session.
    res.setHeader('Set-Cookie', clearAppSessionCookie());
    refusal(
      res,
      401,
      APP_SESSION_REQUIRED_CODE,
      'This app-session identifier is not valid for this user and deployment.'
    );
    return false;
  } catch {
    refusal(
      res,
      503,
      APP_SESSION_UNAVAILABLE_CODE,
      'Astrolabe cannot verify app-session state, so protected data is unavailable.'
    );
    return false;
  }
}

/**
 * Register bootstrap/sign-out endpoints and the guard for every other API route.
 * Static files, `/.auth/sign_out`, `/health`, and AppKit's own non-API health
 * paths never enter this middleware.
 */
export function registerAppSessionControls(app: Application, controls: AppSessionControls): IdleTimeoutConfig {
  const config = controls.config ?? resolveIdleTimeout(controls.env);
  if (!config.enabled) {
    const disabled = (action: 'bootstrap' | 'activity' | 'end', status: 200 | 204) => (req: Request, res: Response) => {
      const csrf = sessionMutationRefusal(req, action);
      if (csrf) {
        refusal(res, 403, 'APP_SESSION_CSRF', csrf);
        return;
      }
      res.setHeader('Set-Cookie', clearAppSessionCookie());
      if (status === 204) res.status(204).send();
      else res.json({ enabled: false, idleTimeoutMinutes: 0 });
    };
    app.post('/api/app-session/bootstrap', disabled('bootstrap', 200));
    app.post('/api/app-session/end', disabled('end', 204));
    app.post('/api/app-session/activity', disabled('activity', 204));
    return config;
  }

  app.post('/api/app-session/bootstrap', async (req, res) => {
    const csrf = sessionMutationRefusal(req, 'bootstrap');
    if (csrf) {
      refusal(res, 403, 'APP_SESSION_CSRF', csrf);
      return;
    }
    const deployment = appSessionDeployment(controls.env);
    if (!deployment) {
      refusal(
        res,
        503,
        APP_SESSION_UNAVAILABLE_CODE,
        'This deployed app cannot establish which deployment owns the session.'
      );
      return;
    }
    const existing = requestCookie(req);
    if (existing) {
      const verified = await requireVerifiedSession(req, res, controls, config);
      if (verified) res.json({ enabled: true, idleTimeoutMinutes: config.minutes });
      return;
    }
    const subject = subjectFor(req, controls);
    if (!subject) {
      refusal(
        res,
        401,
        APP_SESSION_REQUIRED_CODE,
        'This request carries no authenticated subject for the app session.'
      );
      return;
    }
    const sessionId = createOpaqueSessionId();
    const binding = {
      sessionHash: hashSessionId(sessionId),
      subject,
      deployment,
    };
    try {
      await insertSession(controls.lakebase, binding, config.minutes);
      res.setHeader('Set-Cookie', appSessionCookie(sessionId));
      res.status(201).json({ enabled: true, idleTimeoutMinutes: config.minutes });
    } catch {
      refusal(
        res,
        503,
        APP_SESSION_UNAVAILABLE_CODE,
        'Astrolabe cannot persist a new app session, so protected data remains unavailable.'
      );
    }
  });

  app.post('/api/app-session/end', (req, res) => {
    const csrf = sessionMutationRefusal(req, 'end');
    if (csrf) {
      refusal(res, 403, 'APP_SESSION_CSRF', csrf);
      return;
    }
    res.setHeader('Set-Cookie', clearAppSessionCookie());
    const binding = bindingFor(req, controls);
    if (binding) {
      void revokeSession(controls.lakebase, binding.sessionHash).catch(() => {
        // Sign-out remains usable during a Lakebase outage. The cookie is cleared,
        // and the browser continues to Databricks' native sign-out endpoint.
      });
    }
    res.status(204).send();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!shouldProtectWithAppSession(req.path)) {
      next();
      return;
    }
    void requireVerifiedSession(req, res, controls, config).then((verified) => void (verified && next()), next);
  });

  app.post('/api/app-session/activity', async (req, res) => {
    const csrf = sessionMutationRefusal(req, 'activity');
    if (csrf) {
      refusal(res, 403, 'APP_SESSION_CSRF', csrf);
      return;
    }
    const binding = bindingFor(req, controls);
    if (!binding) {
      refusal(res, 401, APP_SESSION_REQUIRED_CODE, 'No app session is available to refresh.');
      return;
    }
    try {
      await refreshSession(controls.lakebase, binding, config.minutes);
      res.status(204).send();
    } catch {
      refusal(res, 503, APP_SESSION_UNAVAILABLE_CODE, 'Astrolabe cannot verify or refresh app-session state.');
    }
  });

  return config;
}

/**
 * Delete only a bounded indexed batch. This runs on a quiet interval, never as
 * a full-table scan attached to user requests.
 */
export async function cleanupExpiredAppSessions(lakebase: AppSessionLakebase, limit = 500): Promise<number> {
  const bounded = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  const result = await lakebase.query(
    `WITH expired AS (
       SELECT session_hash
         FROM ${APP_SESSION_TABLE}
        WHERE retention_expires_at <= NOW()
        ORDER BY retention_expires_at
        LIMIT $1
     )
     DELETE FROM ${APP_SESSION_TABLE} sessions
      USING expired
      WHERE sessions.session_hash = expired.session_hash
      RETURNING sessions.session_hash`,
    [bounded]
  );
  return result.rows.length;
}

export function startAppSessionCleanup(
  lakebase: AppSessionLakebase,
  intervalMs = APP_SESSION_CLEANUP_INTERVAL_MS
): () => void {
  const run = () => {
    void cleanupExpiredAppSessions(lakebase).catch(() => {
      // Session verification itself fails closed. Cleanup is retention work and
      // retries on the next interval without making the app noisy during outages.
    });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
