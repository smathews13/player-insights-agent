import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_SCHEMA } from '../../shared/app-schema';
import { SpPersonaDefinitionWriteSchema, SpPersonaWriteSchema } from '../../shared/sp-identity';
import {
  SP_ASSIGNMENTS_TABLE,
  SP_PERSONA_DEFINITIONS_TABLE,
  SP_PERSONAS_TABLE,
  SP_PERSONA_STATUS_TABLE,
  deleteSpPersonaDefinition,
  insertSpPersonaDefinition,
  insertSpPersona,
  listSpAssignments,
  listSpPersonaDefinitions,
  listSpPersonas,
  upsertSpPersonaForDefinition,
  writeSpAssignment,
} from './sp-identity-store';

function missingTable(): Error & { code: string } {
  const error = new Error('relation "sp_personas" does not exist') as Error & { code: string };
  error.code = '42P01';
  return error;
}

function client(
  options: {
    personas?: Record<string, unknown>[];
    definitions?: Record<string, unknown>[];
    assignments?: Record<string, unknown>[];
    fail?: Error;
  } = {}
) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (options.fail) return Promise.reject(options.fail);
        if (sql.includes(SP_PERSONAS_TABLE) && sql.includes('INSERT')) {
          const definitionBound = sql.includes('(id, definition_id');
          const [id, linkedDefinition, linkedName, linkedClient, linkedScope, linkedKey, linkedBy] = values ?? [];
          const [displayName, clientId, secretScope, secretKey, updatedBy] = definitionBound
            ? [linkedName, linkedClient, linkedScope, linkedKey, linkedBy]
            : [linkedDefinition, linkedName, linkedClient, linkedScope, linkedKey];
          return Promise.resolve({
            rows: [
              {
                id,
                definition_id: definitionBound ? linkedDefinition : null,
                display_name: displayName,
                client_id: clientId,
                secret_scope: secretScope,
                secret_key: secretKey,
                updated_at: '2026-08-26T00:00:00.000Z',
                updated_by: updatedBy,
              },
            ],
          });
        }
        if (sql.includes(SP_PERSONA_DEFINITIONS_TABLE) && sql.includes('INSERT')) {
          const [id, displayName, description, capabilities, grants, legacyCapabilities, updatedBy] = values ?? [];
          const parsedCapabilities: unknown = JSON.parse(String(capabilities));
          return Promise.resolve({
            rows: [
              {
                id,
                display_name: displayName,
                description,
                capabilities: parsedCapabilities,
                grants: JSON.parse(String(grants)) as unknown,
                legacy_capabilities: JSON.parse(String(legacyCapabilities)) as unknown,
                updated_at: '2026-08-28T00:00:00.000Z',
                updated_by: updatedBy,
              },
            ],
          });
        }
        if (sql.includes(SP_PERSONA_DEFINITIONS_TABLE) && sql.includes('DELETE')) {
          const row = (options.definitions ?? []).find((definition) => definition.id === values?.[0]);
          return Promise.resolve({ rows: row ? [{ id: row.id }] : [] });
        }
        if (sql.includes(SP_PERSONA_DEFINITIONS_TABLE) && sql.includes('WHERE id')) {
          const row = (options.definitions ?? []).find((definition) => definition.id === values?.[0]);
          return Promise.resolve({ rows: row ? [row] : [] });
        }
        if (sql.includes(SP_PERSONA_DEFINITIONS_TABLE)) {
          return Promise.resolve({ rows: options.definitions ?? [] });
        }
        if (sql.includes(SP_ASSIGNMENTS_TABLE) && sql.includes('INSERT')) {
          const [email, personaId, updatedBy] = values ?? [];
          return Promise.resolve({
            rows: [
              {
                email,
                persona_id: personaId,
                updated_at: '2026-08-26T00:00:00.000Z',
                updated_by: updatedBy,
              },
            ],
          });
        }
        if (sql.includes(SP_PERSONAS_TABLE) && sql.includes('WHERE id')) {
          const row = (options.personas ?? []).find((persona) => persona.id === values?.[0]);
          return Promise.resolve({ rows: row ? [row] : [] });
        }
        if (sql.includes(SP_PERSONAS_TABLE) && sql.includes('WHERE definition_id')) {
          const row = (options.personas ?? []).find((persona) => persona.definition_id === values?.[0]);
          return Promise.resolve({ rows: row ? [row] : [] });
        }
        if (sql.includes(SP_PERSONAS_TABLE)) {
          return Promise.resolve({ rows: options.personas ?? [] });
        }
        if (sql.includes(SP_ASSIGNMENTS_TABLE)) {
          return Promise.resolve({ rows: options.assignments ?? [] });
        }
        return Promise.resolve({ rows: [] });
      },
    },
  };
}

describe('service-principal persona persistence', () => {
  it('qualifies both tables with APP_SCHEMA', () => {
    expect(SP_PERSONAS_TABLE).toBe(`${APP_SCHEMA}.sp_personas`);
    expect(SP_PERSONA_DEFINITIONS_TABLE).toBe(`${APP_SCHEMA}.sp_persona_definitions`);
    expect(SP_ASSIGNMENTS_TABLE).toBe(`${APP_SCHEMA}.sp_assignments`);
    expect(SP_PERSONA_STATUS_TABLE).toBe(`${APP_SCHEMA}.sp_persona_status`);
  });

  it('returns nobody and no personas when the tables do not exist yet', async () => {
    expect(await listSpPersonas(client({ fail: missingTable() }) as never)).toEqual([]);
    expect(await listSpAssignments(client({ fail: missingTable() }) as never)).toEqual([]);
  });

  it('stores a secret scope and key, never a secret value', async () => {
    const store = client();
    const persona = await insertSpPersona(
      store as never,
      {
        displayName: 'Finance analyst',
        clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
        secretScope: 'astrolabe',
        secretKey: 'finance-sp',
      },
      'admin@example.com'
    );
    expect(persona.secretScope).toBe('astrolabe');
    expect(persona.secretKey).toBe('finance-sp');
    expect(persona).not.toHaveProperty('secret');
    expect(JSON.stringify(store.calls[0]?.values)).not.toMatch(/client_secret|s3cret/i);
    const parsed = SpPersonaWriteSchema.parse({
      displayName: 'Finance analyst',
      clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
      secretScope: 'astrolabe',
      secretKey: 'finance-sp',
      secret: 's3cret',
    });
    expect(parsed).not.toHaveProperty('secret');
  });

  it('links credentials by definition id and invalidates prior status evidence', async () => {
    const store = client();
    const definition = {
      id: 'definition-1',
      revision: 2,
      displayName: 'Finance reader',
      description: '',
      capabilities: ['Table main.games.players — SELECT'],
      grants: [],
      legacyCapabilities: ['Table main.games.players — SELECT'],
      updatedAt: '',
      updatedBy: '',
    };
    const persona = await upsertSpPersonaForDefinition(
      store as never,
      definition,
      {
        clientId: 'aaaaaaaa-0000-4000-8000-000000000001',
        secretScope: 'astrolabe',
        secretKey: 'finance-sp',
      },
      'admin@example.com'
    );
    expect(persona.definitionId).toBe(definition.id);
    expect(store.calls.some((call) => call.sql.includes('ON CONFLICT (definition_id)'))).toBe(true);
    expect(store.calls.some((call) => call.sql.includes('DELETE') && call.sql.includes(SP_PERSONA_STATUS_TABLE))).toBe(
      true
    );
  });

  it('stores a credential-free persona plan as JSON capabilities', async () => {
    const store = client();
    const write = SpPersonaDefinitionWriteSchema.parse({
      displayName: 'Finance reader',
      description: 'Governed reporting',
      capabilities: ['SQL warehouse abc123 — CAN USE'],
      grants: [
        {
          resourceType: 'SQL_WAREHOUSE',
          resource: 'abc123',
          action: 'USE',
          privilege: 'CAN USE',
        },
      ],
      legacyCapabilities: [],
      clientId: 'must-be-dropped',
      secret: 'must-be-dropped',
    });
    const definition = await insertSpPersonaDefinition(store as never, write, 'admin@example.com');
    expect(definition).toMatchObject({
      displayName: 'Finance reader',
      description: 'Governed reporting',
      capabilities: ['SQL warehouse abc123 — CAN USE'],
      grants: [
        expect.objectContaining({
          resourceType: 'SQL_WAREHOUSE',
          resource: 'abc123',
          privilege: 'CAN USE',
        }),
      ],
      legacyCapabilities: [],
    });
    expect(definition).not.toHaveProperty('clientId');
    expect(definition).not.toHaveProperty('secret');
    expect(JSON.stringify(store.calls[0]?.values)).not.toContain('must-be-dropped');
  });

  it('reads an existing string plan as explicitly legacy without losing a character', async () => {
    const legacy = 'Governed tables — USE CATALOG, USE SCHEMA, SELECT';
    const definitions = await listSpPersonaDefinitions(
      client({
        definitions: [
          {
            id: 'legacy-1',
            display_name: 'Existing reader',
            description: '',
            capabilities: [legacy],
            updated_at: '2026-08-27T00:00:00.000Z',
            updated_by: 'owner@example.invalid',
          },
        ],
      }) as never
    );
    expect(definitions[0]?.capabilities).toEqual([legacy]);
    expect(definitions[0]?.legacyCapabilities).toEqual([legacy]);
    expect(definitions[0]?.grants).toEqual([]);
  });

  it('removes only a persona definition and not assignments', async () => {
    const store = client({
      definitions: [{ id: 'definition-1' }],
    });
    expect(await deleteSpPersonaDefinition(store as never, 'definition-1')).toBe(true);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]?.sql).toContain(SP_PERSONA_DEFINITIONS_TABLE);
    expect(store.calls[0]?.sql).not.toContain(SP_ASSIGNMENTS_TABLE);
  });

  it('clears an assignment so that person stays on OAuth', async () => {
    const store = client({
      personas: [
        {
          id: 'persona-1',
          display_name: 'Finance',
          client_id: 'aaaaaaaa-0000-4000-8000-000000000001',
          secret_scope: 'astrolabe',
          secret_key: 'finance-sp',
          updated_at: '2026-08-26T00:00:00.000Z',
          updated_by: 'admin@example.com',
        },
      ],
    });
    expect(await writeSpAssignment(store as never, 'Ada@example.com', null, 'admin@example.com')).toBeNull();
    expect(store.calls.some((call) => call.sql.includes('DELETE') && call.sql.includes(SP_ASSIGNMENTS_TABLE))).toBe(
      true
    );
  });

  it('does not add a secret-value column in the migration', () => {
    const source = fs.readFileSync(path.join(__dirname, 'migrations.ts'), 'utf8');
    const block = source.slice(source.indexOf("name: 'service principal personas'"));
    expect(block).toContain('secret_scope');
    expect(block).toContain('secret_key');
    expect(block).not.toMatch(/secret_value|client_secret TEXT/i);
    expect(source).toContain('sp_persona_definitions');
    expect(source).toContain('capabilities JSONB NOT NULL');
    expect(source).toContain("name: 'structured service principal grants'");
    expect(source).toContain("grants JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(source).toContain('legacy_capabilities JSONB');
  });
});
