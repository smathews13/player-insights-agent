/**
 * The one place a request's Databricks credential is chosen.
 *
 * Call sites that talk to warehouse, Genie, Unity Catalog, serving, Cost, or
 * Connections as "the signed-in user" read {@link executionToken} instead of
 * the forwarded OAuth header. Until the experimental SP-identity pivot is on,
 * this returns exactly that header, so the demo workspace-style OAuth behaviour is unchanged.
 *
 * When the pivot is on:
 *   - a user an admin assigned a persona to runs as that service principal,
 *     if a token can be minted;
 *   - an unassigned user stays on OAuth;
 *   - a minting failure stays on OAuth and records why, rather than faking a
 *     working pivot.
 *
 * The human is still identified from `x-forwarded-email`. The SP token is only
 * the credential downstream Databricks APIs see. The Apps user-token header
 * stays on the request for session freshness and for routes that must act as
 * the human (for example, adding user API scopes to this app).
 */

import type { NextFunction, Request, Response } from 'express';
import {
  ASSIGNED_SERVICE_PRINCIPAL,
  SP_EXECUTION_OAUTH,
  SP_EXECUTION_SERVICE_PRINCIPAL,
  type SpIdentityAssigned,
  type SpIdentitySummary,
  type SpPersona,
} from '../../shared/sp-identity';
import { normalizeAdminEmail } from './admin-identity';
import { resolveRole } from './admin-roles';
import {
  ASSIGNED_SERVICE_PRINCIPAL as BOUND_ASSIGNED_SP,
  type BoundIdentity,
  type IdentityDecision,
} from './identity-binding';
import { forwardedUserToken } from '../routes/access-verification';
import type { LakebaseReader } from './lakebase-store';
import { assignmentForEmail, isSpIdentityEnabled, listSpPersonas, readSpPersona } from './sp-identity-store';
import { describeSpTokenMinting, mintPersonaToken, type SpTokenDeps } from './sp-token';

export type ExecutionCredential =
  | { kind: 'oauth'; token: string | null }
  | {
      kind: 'assigned_service_principal';
      token: string;
      persona: SpIdentityAssigned;
    }
  | {
      kind: 'oauth-fallback';
      token: string | null;
      persona: SpIdentityAssigned | null;
      reason: string;
    };

const attached = new WeakMap<Request, ExecutionCredential>();

export function attachedExecution(req: Request): ExecutionCredential | undefined {
  return attached.get(req);
}

/**
 * The bearer token Databricks APIs should use for this request.
 *
 * Falls back to the forwarded user token when nothing was attached — tests and
 * the pivot-off path both land here, which is why swapping call sites onto this
 * helper does not change OAuth behaviour until the pivot is on AND a persona
 * token was minted.
 */
export function executionToken(req: Request): string | null {
  const credential = attached.get(req);
  if (credential) return credential.token;
  return forwardedUserToken(req);
}

function signedInEmail(req: Request): string {
  return normalizeAdminEmail(req.header('x-forwarded-email') ?? '');
}

function publicPersona(persona: SpPersona): SpIdentityAssigned {
  return { id: persona.id, displayName: persona.displayName, clientId: persona.clientId };
}

export async function resolveExecutionCredential(
  req: Request,
  store: LakebaseReader,
  deps: SpTokenDeps = {}
): Promise<ExecutionCredential> {
  const userToken = forwardedUserToken(req);
  const enabled = await isSpIdentityEnabled(store);
  if (!enabled) return { kind: 'oauth', token: userToken };

  const email = signedInEmail(req);
  if (!email) return { kind: 'oauth', token: userToken };
  if ((await resolveRole(store.lakebase, email)).role === 'super_admin') {
    return { kind: 'oauth', token: userToken };
  }

  const assignment = await assignmentForEmail(store, email);
  if (!assignment) return { kind: 'oauth', token: userToken };

  const persona = await readSpPersona(store, assignment.personaId);
  if (!persona) {
    return {
      kind: 'oauth-fallback',
      token: userToken,
      persona: null,
      reason: 'This person is assigned a persona that is no longer defined, so questions stay on OAuth.',
    };
  }

  const minted = await mintPersonaToken(persona, deps);
  if (!minted.ok) {
    return {
      kind: 'oauth-fallback',
      token: userToken,
      persona: publicPersona(persona),
      reason: minted.reason,
    };
  }
  return {
    kind: 'assigned_service_principal',
    token: minted.token,
    persona: publicPersona(persona),
  };
}

export async function attachExecutionCredential(
  req: Request,
  store: LakebaseReader,
  deps: SpTokenDeps = {}
): Promise<ExecutionCredential> {
  const credential = await resolveExecutionCredential(req, store, deps);
  attached.set(req, credential);
  return credential;
}

/** Express middleware. Cheap no-op while the pivot is off (cached settings read). */
export function executionCredentialMiddleware(store: LakebaseReader, deps: SpTokenDeps = {}) {
  return function attach(req: Request, _res: Response, next: NextFunction) {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }
    attachExecutionCredential(req, store, deps)
      .then(() => next())
      .catch((error: Error) => {
        console.warn(`[sp-identity] Execution credential fell back to OAuth: ${error.message}`);
        attached.set(req, { kind: 'oauth', token: forwardedUserToken(req) });
        next();
      });
  };
}

/**
 * After {@link decideIdentity} has accepted the human, swap the execution
 * credential when a persona token was attached. The human email and tenancy
 * are unchanged.
 */
export function overlayAssignedPersona(decision: IdentityDecision, req: Request): IdentityDecision {
  if (!decision.ok) return decision;
  const credential = attached.get(req);
  if (credential?.kind !== 'assigned_service_principal') return decision;
  return {
    ...decision,
    token: credential.token,
    mode: BOUND_ASSIGNED_SP,
    verified: true,
    persona: credential.persona,
  };
}

export function servingIdentityFields(identity: BoundIdentity): {
  expectedUser: string;
  identityMode: string;
} {
  if (identity.mode === BOUND_ASSIGNED_SP && identity.persona) {
    return { expectedUser: identity.persona.clientId, identityMode: ASSIGNED_SERVICE_PRINCIPAL };
  }
  return {
    expectedUser: identity.token ? identity.email : '',
    identityMode: identity.mode,
  };
}

export async function describeSpIdentity(
  req: Request,
  store: LakebaseReader,
  deps: SpTokenDeps = {}
): Promise<SpIdentitySummary> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const minting = describeSpTokenMinting(env);
  const enabled = await isSpIdentityEnabled(store);
  const email = signedInEmail(req);
  let assigned: SpIdentityAssigned | null = null;
  if (email && (await resolveRole(store.lakebase, email)).role !== 'super_admin') {
    const assignment = await assignmentForEmail(store, email);
    if (assignment) {
      const persona = await readSpPersona(store, assignment.personaId);
      if (persona) assigned = publicPersona(persona);
    }
  }
  const credential = attached.get(req);
  if (credential?.kind === 'assigned_service_principal') {
    return {
      enabled,
      minting,
      assigned: credential.persona,
      executingAs: SP_EXECUTION_SERVICE_PRINCIPAL,
      fallbackReason: null,
    };
  }
  if (credential?.kind === 'oauth-fallback') {
    return {
      enabled,
      minting,
      assigned: credential.persona ?? assigned,
      executingAs: SP_EXECUTION_OAUTH,
      fallbackReason: credential.reason,
    };
  }
  return {
    enabled,
    minting: enabled ? minting : { available: minting.available, detail: minting.detail },
    assigned,
    executingAs: SP_EXECUTION_OAUTH,
    fallbackReason: enabled && assigned && !minting.available ? minting.detail : null,
  };
}

export async function personasById(store: LakebaseReader): Promise<Map<string, SpPersona>> {
  const personas = await listSpPersonas(store);
  return new Map(personas.map((persona) => [persona.id, persona]));
}
