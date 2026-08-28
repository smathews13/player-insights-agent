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
      SQL_WAREHOUSE: ['VIEW:CAN VIEW', 'MONITOR:CAN MONITOR', 'USE:CAN USE', 'MANAGE:CAN MANAGE'],
      CATALOG: ['VIEW:BROWSE', 'USE:USE CATALOG', 'READ:SELECT', 'EXECUTE:EXECUTE', 'MANAGE:MANAGE'],
      SCHEMA: ['USE:USE SCHEMA', 'READ:SELECT', 'EXECUTE:EXECUTE', 'MANAGE:MANAGE'],
      TABLE: ['READ:SELECT', 'WRITE:MODIFY', 'MANAGE:MANAGE'],
      GENIE_SPACE: ['VIEW:CAN VIEW', 'USE:CAN RUN', 'EDIT:CAN EDIT', 'MANAGE:CAN MANAGE'],
      VECTOR_SEARCH_INDEX: ['READ:SELECT', 'MANAGE:MANAGE'],
      VECTOR_SEARCH_ENDPOINT: ['CREATE:CAN CREATE', 'USE:CAN USE', 'MANAGE:CAN MANAGE'],
      FUNCTION: ['EXECUTE:EXECUTE', 'MANAGE:MANAGE'],
      REGISTERED_MODEL: ['EXECUTE:EXECUTE', 'MANAGE:MANAGE'],
      VOLUME: ['READ:READ VOLUME', 'WRITE:WRITE VOLUME', 'MANAGE:MANAGE'],
    });
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
    expect(spGrantSummary(read)).toBe('Table or view main.finance.orders — SELECT');
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
