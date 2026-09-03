import { describe, expect, it, vi } from 'vitest';
import type { SpPersona, SpPersonaDefinition } from '../../shared/sp-identity';
import {
  checkSpPersonaDefinitionStatus,
  SP_PERSONA_STATUS_LIMITS,
  statusForSpPersonaDefinition,
} from './sp-persona-status';

const DEFINITION: SpPersonaDefinition = {
  id: 'definition-1',
  revision: 3,
  displayName: 'Finance reporting',
  description: '',
  capabilities: ['Table main.games.players — SELECT'],
  grants: [
    {
      resourceType: 'TABLE',
      resource: 'main.games.players',
      action: 'READ',
      privilege: 'SELECT',
    },
  ],
  legacyCapabilities: [],
  updatedAt: '2026-09-03T10:00:00.000Z',
  updatedBy: 'admin@example.com',
};

const PERSONA: SpPersona = {
  id: 'persona-1',
  definitionId: DEFINITION.id,
  displayName: DEFINITION.displayName,
  clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
  secretScope: 'persona-secrets',
  secretKey: 'finance-client-secret',
  updatedAt: '2026-09-03T10:00:00.000Z',
  updatedBy: 'admin@example.com',
};

const ENV = {
  DATABRICKS_HOST: 'https://workspace.example.com',
  DATABRICKS_CLIENT_ID: 'app-client',
  DATABRICKS_CLIENT_SECRET: 'app-secret',
};

function effectivePermissions(privileges: string[]): Response {
  return new Response(
    JSON.stringify({
      privilege_assignments: [{ principal: PERSONA.clientId, privileges }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('service-principal connection and sync evidence', () => {
  it('keeps a definition red when no credential row is linked by stable id', () => {
    const status = statusForSpPersonaDefinition(DEFINITION, null, null);
    expect(status.connection.state).toBe('not_connected');
    expect(status.sync.state).toBe('not_synced');
  });

  it('does not expose a raw mint failure, token, or secret reference', async () => {
    const result = await checkSpPersonaDefinitionStatus(DEFINITION, PERSONA, {
      env: ENV,
      mint: vi.fn().mockResolvedValue({
        ok: false,
        reason: `raw provider error raw-client-secret ${PERSONA.secretScope}/${PERSONA.secretKey}`,
      }),
    });
    const wire = JSON.stringify(result);
    expect(result.connectionOk).toBe(false);
    expect(wire).not.toContain('raw provider error');
    expect(wire).not.toContain('raw-client-secret');
    expect(wire).not.toContain(PERSONA.secretScope);
    expect(wire).not.toContain(PERSONA.secretKey);
  });

  it('marks the connection green but sync red when a configured grant is missing', async () => {
    const record = await checkSpPersonaDefinitionStatus(DEFINITION, PERSONA, {
      env: ENV,
      mint: vi.fn().mockResolvedValue({ ok: true, token: 'raw-token-never-returned' }),
      fetchImpl: vi.fn().mockResolvedValue(effectivePermissions([])),
    });
    const status = statusForSpPersonaDefinition(DEFINITION, PERSONA, record);
    expect(status.connection.state).toBe('connected');
    expect(status.sync.state).toBe('not_synced');
    expect(status.sync.checks[0].state).toBe('mismatch');
    expect(JSON.stringify(record)).not.toContain('raw-token-never-returned');
  });

  it('marks both badges green only when every current grant is verified', async () => {
    const record = await checkSpPersonaDefinitionStatus(DEFINITION, PERSONA, {
      env: ENV,
      mint: vi.fn().mockResolvedValue({ ok: true, token: 'token' }),
      fetchImpl: vi.fn().mockResolvedValue(effectivePermissions(['SELECT'])),
    });
    const status = statusForSpPersonaDefinition(DEFINITION, PERSONA, record);
    expect(status.connection.state).toBe('connected');
    expect(status.sync.state).toBe('synced');
    expect(status.sync.checks).toEqual([expect.objectContaining({ state: 'verified', nextAction: '' })]);
  });

  it('invalidates sync when the definition revision changed after the check', async () => {
    const record = await checkSpPersonaDefinitionStatus(DEFINITION, PERSONA, {
      env: ENV,
      mint: vi.fn().mockResolvedValue({ ok: true, token: 'token' }),
      fetchImpl: vi.fn().mockResolvedValue(effectivePermissions(['SELECT'])),
    });
    const status = statusForSpPersonaDefinition({ ...DEFINITION, revision: 4 }, PERSONA, record);
    expect(status.connection.state).toBe('connected');
    expect(status.sync.state).toBe('not_synced');
    expect(status.sync.detail).toContain('Permissions changed');
  });

  it('keeps unsupported grants red with a concrete manual action', async () => {
    const definition: SpPersonaDefinition = {
      ...DEFINITION,
      grants: [{ resourceType: 'GENIE_SPACE', resource: 'space-id', action: 'USE', privilege: 'CAN RUN' }],
    };
    const record = await checkSpPersonaDefinitionStatus(definition, PERSONA, {
      env: ENV,
      mint: vi.fn().mockResolvedValue({ ok: true, token: 'token' }),
    });
    expect(statusForSpPersonaDefinition(definition, PERSONA, record).sync.state).toBe('not_synced');
    expect(record.checks[0]?.state).toBe('unsupported');
    expect(record.checks[0]?.nextAction).toContain('Account Console');
  });

  it('bounds a token mint that never settles', async () => {
    const result = await checkSpPersonaDefinitionStatus(DEFINITION, PERSONA, {
      env: ENV,
      deadlineMs: 5,
      mint: vi.fn(() => new Promise<never>(() => {})),
    });
    expect(result.connectionOk).toBe(false);
    expect(result.detail).toContain('timed out');
    expect(SP_PERSONA_STATUS_LIMITS.concurrency).toBeLessThanOrEqual(4);
    expect(SP_PERSONA_STATUS_LIMITS.deadlineMs).toBeLessThanOrEqual(10_000);
  });
});
