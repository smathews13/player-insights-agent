import { describe, expect, it } from 'vitest';
import { PRODUCTION_PROMPT_ALIAS, promptRegistryUri } from '../../shared/eval-flywheel';
import {
  parsePromptVersion,
  promotePromptAlias,
  promptTemplateFromPromote,
} from './prompt-registry';

describe('Prompt Registry promote', () => {
  it('names the production alias the next Ask will load', () => {
    expect(PRODUCTION_PROMPT_ALIAS).toBe('production');
    expect(promptRegistryUri('main.default.pia_guidance')).toBe(
      'prompts:/main.default.pia_guidance@production'
    );
  });

  it('builds a template from the winner without inventing customer data', () => {
    expect(promptTemplateFromPromote({ side: 'candidate', endpoint: 'new-agent', guidelines: 'Be brief.' })).toContain(
      'Be brief.'
    );
    expect(promptTemplateFromPromote({ side: 'baseline', endpoint: 'current', guidelines: '' })).toContain(
      'governed data'
    );
  });

  it('moves the alias when the workspace accepts the write', async () => {
    const calls: string[] = [];
    const result = await promotePromptAlias(
      {
        request: async ({ method, path }) => {
          calls.push(`${method} ${path}`);
          return { version: 3, template: 'Promoted guidance.' };
        },
      },
      { name: 'main.default.pia_guidance', template: 'Promoted guidance.' }
    );
    expect(result.status).toBe('moved');
    expect(result.version).toBe('3');
    expect(result.uri).toContain('@production');
    expect(calls.some((entry) => entry.startsWith('PATCH '))).toBe(true);
  });

  it('says blocked instead of inventing a moved alias when the workspace refuses', async () => {
    const result = await promotePromptAlias(
      {
        request: async () => {
          throw new Error('403 PERMISSION_DENIED: missing catalog scope');
        },
      },
      { name: 'main.default.pia_guidance', template: 'Saved locally.' }
    );
    expect(result.status).toBe('blocked');
    expect(result.template).toBe('Saved locally.');
    expect(result.note).toContain('not moved');
  });

  it('skips the registry when no name is configured', async () => {
    const result = await promotePromptAlias(
      { request: async () => ({}) },
      { name: '', template: 'Cached.' }
    );
    expect(result.status).toBe('skipped');
    expect(parsePromptVersion({ version: 2 })).toBe('2');
  });
});
