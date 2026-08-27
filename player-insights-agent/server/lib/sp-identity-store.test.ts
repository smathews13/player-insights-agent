import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_SCHEMA } from '../../shared/app-schema';
import { SP_IDENTITY_ENABLED_SETTING, SpPersonaWriteSchema } from '../../shared/sp-identity';
import { forgetStoredSettings } from './app-settings';
import {
  SP_ASSIGNMENTS_TABLE,
  SP_PERSONAS_TABLE,
  forgetSpIdentityEnabled,
  insertSpPersona,
  isSpIdentityEnabled,
  listSpAssignments,
  listSpPersonas,
  writeSpAssignment,
  writeSpIdentityEnabled,
} from './sp-identity-store';

function missingTable(): Error & { code: string } {
  const error = new Error('relation "sp_personas" does not exist') as Error & { code: string };
  error.code = '42P01';
  return error;
}

function client(
  options: {
    settings?: Record<string, unknown>[];
    personas?: Record<string, unknown>[];
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
        if (sql.includes('deployment_settings') && sql.includes('SELECT')) {
          return Promise.resolve({ rows: options.settings ?? [] });
        }
        if (sql.includes(SP_PERSONAS_TABLE) && sql.includes('INSERT')) {
          const [id, displayName, clientId, secretScope, secretKey, updatedBy] = values ?? [];
          return Promise.resolve({
            rows: [
              {
                id,
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
    expect(SP_ASSIGNMENTS_TABLE).toBe(`${APP_SCHEMA}.sp_assignments`);
  });

  it('treats anything other than the exact string true as the pivot off', async () => {
    forgetSpIdentityEnabled();
    forgetStoredSettings();
    expect(await isSpIdentityEnabled(client() as never, { maxAgeMs: 0 })).toBe(false);

    forgetSpIdentityEnabled();
    forgetStoredSettings();
    const yes = client({
      settings: [{ resource_id: SP_IDENTITY_ENABLED_SETTING, value: 'true', intent: 'active' }],
    });
    expect(await isSpIdentityEnabled(yes as never, { maxAgeMs: 0 })).toBe(true);

    for (const value of ['TRUE', '1', 'yes', 'on', '']) {
      forgetSpIdentityEnabled();
      forgetStoredSettings();
      const store = client({
        settings: [{ resource_id: SP_IDENTITY_ENABLED_SETTING, value, intent: 'active' }],
      });
      expect(await isSpIdentityEnabled(store as never, { maxAgeMs: 0 }), value).toBe(false);
    }
  });

  it('returns nobody and no personas when the tables do not exist yet', async () => {
    forgetSpIdentityEnabled();
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

  it('writes the pivot as the exact string true and busts the cache', async () => {
    forgetSpIdentityEnabled();
    forgetStoredSettings();
    const store = client();
    store.lakebase.query = (sql: string, values?: unknown[]) => {
      store.calls.push({ sql, values });
      if (sql.includes('INSERT') && sql.includes('deployment_settings')) {
        return Promise.resolve({
          rows: [
            {
              resource_id: values?.[0],
              value: values?.[1],
              intent: values?.[2],
              note: values?.[3],
              updated_at: '2026-08-26T00:00:00.000Z',
              updated_by: values?.[4],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    };
    await writeSpIdentityEnabled(store as never, true, 'admin@example.com');
    expect(store.calls[0]?.values?.[0]).toBe(SP_IDENTITY_ENABLED_SETTING);
    expect(store.calls[0]?.values?.[1]).toBe('true');
  });

  it('does not add a secret-value column in the migration', () => {
    const source = fs.readFileSync(path.join(__dirname, 'migrations.ts'), 'utf8');
    const block = source.slice(source.indexOf("name: 'service principal personas'"));
    expect(block).toContain('secret_scope');
    expect(block).toContain('secret_key');
    expect(block).not.toMatch(/secret_value|client_secret TEXT/i);
  });
});
