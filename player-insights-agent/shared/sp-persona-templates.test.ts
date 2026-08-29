import { describe, expect, it } from 'vitest';
import { DEFAULT_SP_PERSONA_TEMPLATES } from './default-sp-persona-templates';
import { SpPersonaTemplatesSchema } from './sp-persona-templates';

const profile = {
  id: 'fictional-reader',
  displayName: 'Fictional Reader',
  roleSummary: 'Read-only reporting persona.',
  purpose: 'Read approved reporting data.',
  duties: ['Run approved reports.'],
  dataBoundaries: ['Only configured resources.'],
  exclusions: ['No writes or management.'],
  keyCapabilities: ['Governed reporting'],
  variants: [
    {
      id: 'least-privilege',
      label: 'least privilege',
      description: 'Read only.',
      leastPrivilege: true,
      grants: [
        {
          resourceType: 'TABLE',
          action: 'READ',
          privilege: 'SELECT',
          selector: {
            match: 'all',
            sources: ['declared'],
            idSuffixes: ['approved_reporting'],
            choiceLabel: 'Approved reporting tables',
          },
        },
      ],
    },
  ],
};

describe('deployment-configured SP persona template contract', () => {
  it('validates the public Business Analyst and Marketing Scientist defaults', () => {
    const parsed = SpPersonaTemplatesSchema.parse(DEFAULT_SP_PERSONA_TEMPLATES);
    expect(parsed.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: 'business-analyst', displayName: 'Business Analyst' },
      { id: 'marketing-scientist', displayName: 'Marketing Scientist' },
    ]);
    for (const template of parsed) {
      expect(template.variants.map((variant) => variant.id)).toEqual(['least-privilege', 'semantic-discovery']);
      for (const variant of template.variants) {
        expect(variant.grants.map((grant) => grant.action)).not.toEqual(
          expect.arrayContaining(['WRITE', 'CREATE', 'EDIT', 'MANAGE'])
        );
      }
      const tableIntent = template.variants[0].grants.find((grant) => grant.resourceType === 'TABLE');
      expect(tableIntent?.selector.idSuffixes?.length).toBeGreaterThan(0);
      expect(tableIntent?.selector).not.toHaveProperty('labelIncludes');
    }
  });

  it('accepts canonical credential-free grant intents', () => {
    const parsed = SpPersonaTemplatesSchema.parse([profile]);
    expect(parsed[0].variants[0].grants[0]).toMatchObject({
      resourceType: 'TABLE',
      action: 'READ',
      privilege: 'SELECT',
    });
    expect(JSON.stringify(parsed)).not.toMatch(/client.?secret|token|workspace.?id|email/i);
  });

  it('rejects a forged action/privilege pair', () => {
    const malformed = structuredClone(profile);
    malformed.variants[0].grants[0].privilege = 'CAN MANAGE';
    expect(SpPersonaTemplatesSchema.safeParse([malformed]).success).toBe(false);
  });

  it('rejects dangerous actions in every variant, including optional expanded variants', () => {
    const malformed = structuredClone(profile);
    malformed.variants.push({
      ...structuredClone(profile.variants[0]),
      id: 'expanded',
      leastPrivilege: false,
      grants: [
        {
          ...malformed.variants[0].grants[0],
          action: 'WRITE',
          privilege: 'MODIFY',
        },
      ],
    } as never);
    expect(SpPersonaTemplatesSchema.safeParse([malformed]).success).toBe(false);
  });

  it.each([
    ['CREATE', 'CAN CREATE', 'VECTOR_SEARCH_ENDPOINT'],
    ['EDIT', 'CAN EDIT', 'GENIE_SPACE'],
    ['MANAGE', 'CAN MANAGE', 'SQL_WAREHOUSE'],
  ])('rejects %s even when the resource matrix recognizes it', (action, privilege, resourceType) => {
    const malformed = structuredClone(profile);
    malformed.variants.push({
      ...structuredClone(profile.variants[0]),
      id: `expanded-${action.toLocaleLowerCase()}`,
      leastPrivilege: false,
      grants: [
        {
          resourceType,
          action,
          privilege,
          selector: { match: 'single', choiceLabel: 'Optional resource' },
        },
      ],
    } as never);
    expect(SpPersonaTemplatesSchema.safeParse([malformed]).success).toBe(false);
  });

  it('rejects substring selectors and unconstrained all-resource expansion', () => {
    const substring = structuredClone(profile);
    substring.variants[0].grants[0].selector = {
      match: 'all',
      labelIncludes: ['player'],
      choiceLabel: 'Broad player tables',
    } as never;
    expect(SpPersonaTemplatesSchema.safeParse([substring]).success).toBe(false);

    const unbounded = structuredClone(profile);
    unbounded.variants[0].grants[0].selector = {
      match: 'all',
      sources: ['declared'],
      choiceLabel: 'Every declared table',
    } as never;
    expect(SpPersonaTemplatesSchema.safeParse([unbounded]).success).toBe(false);
  });

  it('requires exactly one least-privilege variant and unique profile ids', () => {
    expect(
      SpPersonaTemplatesSchema.safeParse([
        profile,
        { ...profile, variants: [{ ...profile.variants[0], id: 'alternate', leastPrivilege: false }] },
      ]).success
    ).toBe(false);
  });
});
