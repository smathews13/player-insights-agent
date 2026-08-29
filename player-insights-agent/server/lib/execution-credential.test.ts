import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

import { SIGNED_IN_USER } from './identity-binding';
import {
  attachExecutionCredential,
  executionToken,
  overlayAssignedPersona,
  resolveExecutionCredential,
} from './execution-credential';

vi.mock('../routes/access-verification', () => ({
  forwardedUserToken: vi.fn(() => 'user-oauth-token'),
}));

vi.mock('./sp-identity-store', () => ({
  isSpIdentityEnabled: vi.fn(),
  assignmentForEmail: vi.fn(),
  readSpPersona: vi.fn(),
  listSpPersonas: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./sp-token', () => ({
  describeSpTokenMinting: vi.fn(() => ({ available: true, detail: 'minting is available' })),
  mintPersonaToken: vi.fn(),
}));

vi.mock('./admin-roles', () => ({
  resolveRole: vi.fn(() => Promise.resolve({ role: 'consumer', addedAdminsReadable: true, seedAdminCount: 0 })),
}));

import { forwardedUserToken } from '../routes/access-verification';
import { assignmentForEmail, isSpIdentityEnabled, readSpPersona } from './sp-identity-store';
import { mintPersonaToken } from './sp-token';
import { resolveRole } from './admin-roles';

const PERSONA = {
  id: 'persona-1',
  displayName: 'Finance analyst',
  clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
  secretScope: 'astrolabe',
  secretKey: 'finance-sp',
  updatedAt: '2026-08-26T00:00:00.000Z',
  updatedBy: 'admin@example.com',
};

function req(email = 'ada@example.com'): Request {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-forwarded-email' ? email : undefined),
  } as Request;
}

const store = { lakebase: { query: () => Promise.resolve({ rows: [] }) } };

describe('executionToken', () => {
  beforeEach(() => {
    vi.mocked(forwardedUserToken).mockReturnValue('user-oauth-token');
    vi.mocked(isSpIdentityEnabled).mockReset();
    vi.mocked(assignmentForEmail).mockReset();
    vi.mocked(readSpPersona).mockReset();
    vi.mocked(mintPersonaToken).mockReset();
    vi.mocked(resolveRole).mockResolvedValue({ role: 'consumer', addedAdminsReadable: true, seedAdminCount: 0 });
  });
  it('is the forwarded OAuth token while the pivot is off', async () => {
    vi.mocked(isSpIdentityEnabled).mockResolvedValue(false);
    const request = req();
    await attachExecutionCredential(request, store as never);
    expect(executionToken(request)).toBe('user-oauth-token');
    expect(mintPersonaToken).not.toHaveBeenCalled();
  });

  it('stays on OAuth when the pivot is on but this person has no persona', async () => {
    vi.mocked(isSpIdentityEnabled).mockResolvedValue(true);
    vi.mocked(assignmentForEmail).mockResolvedValue(null);
    const request = req();
    const credential = await resolveExecutionCredential(request, store as never);
    expect(credential).toEqual({ kind: 'oauth', token: 'user-oauth-token' });
    expect(mintPersonaToken).not.toHaveBeenCalled();
  });

  it('keeps a super admin on the immutable Owner OAuth identity', async () => {
    vi.mocked(isSpIdentityEnabled).mockResolvedValue(true);
    vi.mocked(resolveRole).mockResolvedValue({ role: 'super_admin', addedAdminsReadable: true, seedAdminCount: 1 });
    const credential = await resolveExecutionCredential(req(), store as never);
    expect(credential).toEqual({ kind: 'oauth', token: 'user-oauth-token' });
    expect(assignmentForEmail).not.toHaveBeenCalled();
    expect(mintPersonaToken).not.toHaveBeenCalled();
  });

  it('uses the minted persona token when the pivot is on and minting works', async () => {
    vi.mocked(isSpIdentityEnabled).mockResolvedValue(true);
    vi.mocked(assignmentForEmail).mockResolvedValue({
      email: 'ada@example.com',
      personaId: 'persona-1',
      updatedAt: '2026-08-26T00:00:00.000Z',
      updatedBy: 'admin@example.com',
    });
    vi.mocked(readSpPersona).mockResolvedValue(PERSONA);
    vi.mocked(mintPersonaToken).mockResolvedValue({ ok: true, token: 'sp-token' });
    const request = req();
    await attachExecutionCredential(request, store as never);
    expect(executionToken(request)).toBe('sp-token');
  });

  it('stays on OAuth with a reason when minting fails', async () => {
    vi.mocked(isSpIdentityEnabled).mockResolvedValue(true);
    vi.mocked(assignmentForEmail).mockResolvedValue({
      email: 'ada@example.com',
      personaId: 'persona-1',
      updatedAt: '2026-08-26T00:00:00.000Z',
      updatedBy: 'admin@example.com',
    });
    vi.mocked(readSpPersona).mockResolvedValue(PERSONA);
    vi.mocked(mintPersonaToken).mockResolvedValue({ ok: false, reason: 'The named secret could not be read.' });
    const credential = await resolveExecutionCredential(req(), store as never);
    expect(credential.kind).toBe('oauth-fallback');
    expect(credential.token).toBe('user-oauth-token');
    if (credential.kind === 'oauth-fallback') {
      expect(credential.reason).toContain('could not be read');
    }
  });

  it('does not overlay a persona onto a refused identity, and overlays only a minted one', async () => {
    vi.mocked(isSpIdentityEnabled).mockResolvedValue(true);
    vi.mocked(assignmentForEmail).mockResolvedValue({
      email: 'ada@example.com',
      personaId: 'persona-1',
      updatedAt: '2026-08-26T00:00:00.000Z',
      updatedBy: 'admin@example.com',
    });
    vi.mocked(readSpPersona).mockResolvedValue(PERSONA);
    vi.mocked(mintPersonaToken).mockResolvedValue({ ok: true, token: 'sp-token' });
    const request = req();
    await attachExecutionCredential(request, store as never);
    const refused = overlayAssignedPersona({ ok: false, code: 'IDENTITY_REQUIRED', message: 'no' } as never, request);
    expect(refused.ok).toBe(false);
    const accepted = overlayAssignedPersona(
      {
        ok: true,
        email: 'ada@example.com',
        token: 'user-oauth-token',
        verified: true,
        mode: SIGNED_IN_USER,
        requestId: 'r1',
        correlationId: 'c1',
      },
      request
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.mode).toBe('assigned_service_principal');
      expect(accepted.token).toBe('sp-token');
      expect(accepted.email).toBe('ada@example.com');
      expect(accepted.persona?.displayName).toBe('Finance analyst');
    }
  });

  it('falls back to the forwarded token when nothing was attached', () => {
    vi.mocked(forwardedUserToken).mockReturnValue('user-oauth-token');
    expect(executionToken(req())).toBe('user-oauth-token');
  });
});
