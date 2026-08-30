import { describe, expect, it } from 'vitest';
import { SP_PERSONA_TEMPLATES_ENV } from '../../shared/sp-persona-templates';
import { configuredSpPersonaTemplates, parseSpPersonaTemplates } from './sp-persona-templates';

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

function validTemplates(): unknown[] {
  const templates: unknown = JSON.parse(VALID);
  if (!Array.isArray(templates)) throw new Error('Test fixture must be an array.');
  return templates;
}

describe('SP persona template configuration parser', () => {
  it('loads the two customer-neutral product defaults when no override exists', () => {
    const parsed = configuredSpPersonaTemplates({});
    expect(parsed.warning).toBeNull();
    expect(parsed.templates.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: 'business-analyst', displayName: 'Business Analyst' },
      { id: 'marketing-scientist', displayName: 'Marketing Scientist' },
    ]);
    for (const template of parsed.templates) {
      expect(template.variants).toHaveLength(2);
      for (const variant of template.variants) {
        expect(variant.grants.every((grant) => ['READ', 'USE', 'VIEW', 'EXECUTE'].includes(grant.action))).toBe(true);
      }
    }
  });

  it('keeps a top-level array as a backwards-compatible full replacement', () => {
    const parsed = configuredSpPersonaTemplates({ [SP_PERSONA_TEMPLATES_ENV]: VALID });
    expect(parsed.templates).toHaveLength(1);
    expect(parsed.templates[0].id).toBe('fictional-analyst');
    expect(parsed.warning).toBeNull();
  });

  it('supports explicit replacement without duplicating product defaults', () => {
    const override = JSON.stringify({ mode: 'replace', templates: validTemplates() });
    const parsed = parseSpPersonaTemplates(override);
    expect(parsed.templates.map((template) => template.id)).toEqual(['fictional-analyst']);
  });

  it('extends defaults only with new validated profile ids', () => {
    const override = JSON.stringify({ mode: 'extend', templates: validTemplates() });
    const parsed = parseSpPersonaTemplates(override);
    expect(parsed.warning).toBeNull();
    expect(parsed.templates.map((template) => template.id)).toEqual([
      'business-analyst',
      'marketing-scientist',
      'fictional-analyst',
    ]);
  });

  it('fails closed instead of shadowing a default during extension', () => {
    const duplicate = validTemplates() as Array<Record<string, unknown>>;
    duplicate[0].id = 'business-analyst';
    expect(parseSpPersonaTemplates(JSON.stringify({ mode: 'extend', templates: duplicate }))).toEqual({
      templates: [],
      warning: 'Example profiles are unavailable because this deployment configured an invalid template contract.',
    });
  });

  it('returns no defaults or partial profiles and a safe warning for malformed JSON', () => {
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

  it('treats an empty override as the default-product path', () => {
    expect(parseSpPersonaTemplates('').templates.map((template) => template.id)).toEqual([
      'business-analyst',
      'marketing-scientist',
    ]);
  });
});
