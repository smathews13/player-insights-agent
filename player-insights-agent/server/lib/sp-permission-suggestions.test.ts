import { describe, expect, it } from 'vitest';
import { suggestSpPermissions } from './sp-permission-suggestions';

const resources = [
  { type: 'TABLE' as const, id: 'demo.analytics.events', label: 'Events', source: 'declared' as const },
  { type: 'SQL_WAREHOUSE' as const, id: 'warehouse-1', label: 'Reporting warehouse', source: 'configured' as const },
];

function reply(body: unknown): unknown {
  return { choices: [{ message: { content: JSON.stringify(body) } }] };
}

const plans = {
  plans: [
    {
      name: 'Read only',
      rationale: 'Reads the requested analytics table.',
      grants: [{ resourceType: 'TABLE', resource: 'demo.analytics.events', action: 'READ', privilege: 'SELECT' }],
    },
    {
      name: 'Read and run',
      rationale: 'Adds access to the configured reporting warehouse.',
      grants: [
        { resourceType: 'TABLE', resource: 'demo.analytics.events', action: 'READ', privilege: 'SELECT' },
        { resourceType: 'SQL_WAREHOUSE', resource: 'warehouse-1', action: 'USE', privilege: 'CAN USE' },
      ],
    },
  ],
};

describe('SP permission suggestions', () => {
  it('sends only persona context, allowlisted inventory, and the canonical matrix', async () => {
    let payload: Record<string, unknown> = {};
    const result = await suggestSpPermissions({
      request: { displayName: 'Analyst', purpose: 'Read event metrics' },
      resources,
      invoke: (next) => {
        payload = next;
        return Promise.resolve(reply(plans));
      },
    });
    expect(result.plans).toHaveLength(2);
    const wire = JSON.stringify(payload);
    expect(wire).toContain('Read event metrics');
    expect(wire).toContain('demo.analytics.events');
    expect(wire).toContain('canonical_privilege_matrix');
    expect(wire).not.toMatch(/client_secret|access_token|existing_grants|user_list/i);
  });

  it('rejects model output outside the resource allowlist', async () => {
    await expect(
      suggestSpPermissions({
        request: { displayName: '', purpose: 'Read metrics' },
        resources,
        invoke: () =>
          Promise.resolve(
            reply({
              ...plans,
              plans: [
                plans.plans[0],
                {
                  ...plans.plans[1],
                  grants: [
                    { resourceType: 'TABLE', resource: 'private.hr.people', action: 'READ', privilege: 'SELECT' },
                  ],
                },
              ],
            })
          ),
      })
    ).rejects.toThrow(/outside the configured allowlist/);
  });

  it('rejects forged privileges, invalid matrices, and single-answer output', async () => {
    await expect(
      suggestSpPermissions({
        request: { displayName: '', purpose: 'Read metrics' },
        resources,
        invoke: () =>
          Promise.resolve(
            reply({
              plans: [
                {
                  name: 'Unsafe',
                  rationale: 'Forged privilege.',
                  grants: [
                    { resourceType: 'TABLE', resource: 'demo.analytics.events', action: 'READ', privilege: 'MANAGE' },
                  ],
                },
              ],
            })
          ),
      })
    ).rejects.toThrow(/invalid permission-plan shape/);
  });
});
