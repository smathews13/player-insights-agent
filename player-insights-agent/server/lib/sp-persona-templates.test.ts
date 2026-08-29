import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SP_PERSONA_TEMPLATES_ENV } from '../../shared/sp-persona-templates';
import { configuredSpPersonaTemplates, parseSpPersonaTemplates } from './sp-persona-templates';

const INTERNAL_OVERLAY = path.resolve(__dirname, '../../../bundle/targets/example/persona-templates.json');

const VALID = JSON.stringify([
  {
    id: 'fictional-analyst',
    displayName: 'Fictional Analyst',
    roleSummary: 'Read-only analyst.',
    purpose: 'Read governed reports.',
    duties: ['Analyze approved data.'],
    dataBoundaries: ['Configured resources only.'],
    exclusions: ['No writes.'],
    keyCapabilities: ['SQL analysis'],
    variants: [
      {
        id: 'least-privilege',
        label: 'least privilege',
        description: 'Read only.',
        leastPrivilege: true,
        grants: [
          {
            resourceType: 'SQL_WAREHOUSE',
            action: 'USE',
            privilege: 'CAN USE',
            selector: { match: 'single', choiceLabel: 'Reporting warehouse' },
          },
        ],
      },
    ],
  },
]);

describe('SP persona template configuration parser', () => {
  it('returns validated templates from the deployment environment', () => {
    const parsed = configuredSpPersonaTemplates({ [SP_PERSONA_TEMPLATES_ENV]: VALID });
    expect(parsed.templates).toHaveLength(1);
    expect(parsed.warning).toBeNull();
  });

  it('returns no partial profiles and a safe warning for malformed JSON', () => {
    expect(parseSpPersonaTemplates('{bad')).toEqual({
      templates: [],
      warning: 'Example profiles are unavailable because this deployment configured an invalid template contract.',
    });
  });

  it('fails the full configuration closed when one profile violates the contract', () => {
    const invalid: unknown = JSON.parse(VALID);
    if (!Array.isArray(invalid)) throw new Error('Test fixture must be an array.');
    invalid.push({ displayName: 'Missing everything else' } as unknown);
    const parsed = parseSpPersonaTemplates(JSON.stringify(invalid));
    expect(parsed.templates).toEqual([]);
    expect(parsed.warning).toMatch(/invalid template contract/);
  });

  it('rejects a deployment overlay whose optional variant requests dangerous privileges', () => {
    const invalid: unknown = JSON.parse(VALID);
    if (!Array.isArray(invalid)) throw new Error('Test fixture must be an array.');
    const template = invalid[0] as {
      variants: Array<Record<string, unknown>>;
    };
    template.variants.push({
      id: 'expanded',
      label: 'expanded',
      description: 'Malicious optional expansion.',
      leastPrivilege: false,
      grants: [
        {
          resourceType: 'TABLE',
          action: 'WRITE',
          privilege: 'MODIFY',
          selector: { match: 'single', choiceLabel: 'Any table' },
        },
      ],
    });
    const parsed = parseSpPersonaTemplates(JSON.stringify(invalid));
    expect(parsed.templates).toEqual([]);
    expect(parsed.warning).toMatch(/invalid template contract/);
  });

  it('treats an unset configuration as intentionally empty', () => {
    expect(parseSpPersonaTemplates('')).toEqual({ templates: [], warning: null });
  });

  it.skipIf(!existsSync(INTERNAL_OVERLAY))('validates every internal deployment profile as least privilege', () => {
    const parsed = parseSpPersonaTemplates(readFileSync(INTERNAL_OVERLAY, 'utf8'));
    expect(parsed.warning).toBeNull();
    expect(parsed.templates).toHaveLength(2);
    for (const template of parsed.templates) {
      const least = template.variants.find((variant) => variant.leastPrivilege);
      expect(least).toBeDefined();
      expect(least?.grants.length).toBeGreaterThan(0);
      expect(least?.grants.map((grant) => grant.action)).not.toEqual(
        expect.arrayContaining(['WRITE', 'CREATE', 'EDIT', 'MANAGE'])
      );
      for (const variant of template.variants) {
        expect(variant.grants.map((grant) => grant.action)).not.toEqual(
          expect.arrayContaining(['WRITE', 'CREATE', 'EDIT', 'MANAGE'])
        );
      }
    }
  });
});
