import { describe, expect, it } from 'vitest';
import { SP_GRANT_MATRIX, SpPersonaDefinitionWriteSchema, spGrantIdentifierFault, spGrantSummary } from './sp-identity';

describe('service-principal grant contract', () => {
  it('publishes the exact supported resource and action matrix', () => {
    expect(
      Object.fromEntries(
        Object.entries(SP_GRANT_MATRIX).map(([type, definition]) => [
          type,
          definition.options.map(({ action, privilege }) => `${action}:${privilege}`),
        ])
      )
    ).toEqual({
      SERVING_ENDPOINT: ['VIEW:CAN VIEW', 'USE:CAN QUERY', 'MANAGE:CAN MANAGE'],
      SQL_WAREHOUSE: ['VIEW:CAN VIEW', 'MONITOR:CAN MONITOR', 'USE:CAN USE', 'OWNER:IS OWNER', 'MANAGE:CAN MANAGE'],
      CATALOG: [
        'VIEW:BROWSE',
        'USE:USE CATALOG',
        'READ_METADATA:READ METADATA',
        'READ:SELECT',
        'MODIFY:MODIFY',
        'EXECUTE:EXECUTE',
        'APPLY_TAG:APPLY TAG',
        'CREATE_SCHEMA:CREATE SCHEMA',
        'CREATE_TABLE:CREATE TABLE',
        'CREATE_FUNCTION:CREATE FUNCTION',
        'CREATE_MODEL:CREATE MODEL',
        'CREATE_VOLUME:CREATE VOLUME',
        'ALL_PRIVILEGES:ALL PRIVILEGES',
        'MANAGE:MANAGE',
      ],
      SCHEMA: [
        'USE:USE SCHEMA',
        'READ_METADATA:READ METADATA',
        'READ:SELECT',
        'MODIFY:MODIFY',
        'EXECUTE:EXECUTE',
        'APPLY_TAG:APPLY TAG',
        'CREATE_TABLE:CREATE TABLE',
        'CREATE_FUNCTION:CREATE FUNCTION',
        'CREATE_MODEL:CREATE MODEL',
        'CREATE_VOLUME:CREATE VOLUME',
        'ALL_PRIVILEGES:ALL PRIVILEGES',
        'MANAGE:MANAGE',
      ],
      TABLE: [
        'READ:SELECT',
        'READ_METADATA:READ METADATA',
        'WRITE:MODIFY',
        'APPLY_TAG:APPLY TAG',
        'ALL_PRIVILEGES:ALL PRIVILEGES',
        'MANAGE:MANAGE',
      ],
      GENIE_SPACE: ['VIEW:CAN VIEW', 'USE:CAN RUN', 'EDIT:CAN EDIT', 'MANAGE:CAN MANAGE'],
      VECTOR_SEARCH_INDEX: ['READ:SELECT', 'MANAGE:MANAGE'],
      VECTOR_SEARCH_ENDPOINT: ['CREATE:CAN CREATE', 'USE:CAN USE', 'MANAGE:CAN MANAGE'],
      FUNCTION: ['EXECUTE:EXECUTE', 'READ_METADATA:READ METADATA', 'ALL_PRIVILEGES:ALL PRIVILEGES', 'MANAGE:MANAGE'],
      REGISTERED_MODEL: [
        'EXECUTE:EXECUTE',
        'READ_METADATA:READ METADATA',
        'APPLY_TAG:APPLY TAG',
        'CREATE_MODEL_VERSION:CREATE MODEL VERSION',
        'ALL_PRIVILEGES:ALL PRIVILEGES',
        'MANAGE:MANAGE',
      ],
      VOLUME: [
        'READ:READ VOLUME',
        'READ_METADATA:READ METADATA',
        'WRITE:WRITE VOLUME',
        'APPLY_TAG:APPLY TAG',
        'ALL_PRIVILEGES:ALL PRIVILEGES',
        'MANAGE:MANAGE',
      ],
    });
  });

  it('gives every resource a unique friendly action mapped to one canonical privilege', () => {
    for (const definition of Object.values(SP_GRANT_MATRIX)) {
      expect(new Set(definition.options.map((option) => option.action)).size).toBe(definition.options.length);
      for (const option of definition.options) {
        expect(option.label.trim()).not.toBe('');
        expect(option.privilege).toMatch(/^[A-Z][A-Z ]+$/);
      }
    }
  });

  it('rejects invalid action/resource pairs, forged privilege mappings, and unsafe identifiers', () => {
    const base = { displayName: 'Reader', description: '', capabilities: [], legacyCapabilities: [] };
    expect(
      SpPersonaDefinitionWriteSchema.safeParse({
        ...base,
        grants: [{ resourceType: 'TABLE', resource: 'main.finance.orders', action: 'USE', privilege: 'CAN USE' }],
      }).success
    ).toBe(false);
    expect(
      SpPersonaDefinitionWriteSchema.safeParse({
        ...base,
        grants: [{ resourceType: 'TABLE', resource: 'main.finance.orders', action: 'READ', privilege: 'MANAGE' }],
      }).success
    ).toBe(false);
    expect(spGrantIdentifierFault('TABLE', 'main.finance.orders; DROP TABLE secrets')).not.toBeNull();
  });

  it('prevents exact duplicates while allowing different privileges on one resource', () => {
    const read = {
      resourceType: 'TABLE' as const,
      resource: 'main.finance.orders',
      action: 'READ' as const,
      privilege: 'SELECT',
    };
    const write = { ...read, action: 'WRITE' as const, privilege: 'MODIFY' };
    const base = { displayName: 'Analyst', description: '', capabilities: [], legacyCapabilities: [] };
    expect(SpPersonaDefinitionWriteSchema.safeParse({ ...base, grants: [read, read] }).success).toBe(false);
    expect(SpPersonaDefinitionWriteSchema.safeParse({ ...base, grants: [read, write] }).success).toBe(true);
    expect(spGrantSummary(read)).toBe('Table main.finance.orders — SELECT');
  });

  it('accepts legacy-only writes without retaining credential-shaped extras', () => {
    const parsed = SpPersonaDefinitionWriteSchema.parse({
      displayName: 'Legacy reader',
      description: '',
      capabilities: ['SQL warehouse — CAN USE'],
      clientSecret: 'must-disappear',
      token: 'must-disappear',
    });
    expect(parsed.grants).toEqual([]);
    expect(parsed.capabilities).toEqual(['SQL warehouse — CAN USE']);
    expect(parsed).not.toHaveProperty('clientSecret');
    expect(parsed).not.toHaveProperty('token');
  });
});
