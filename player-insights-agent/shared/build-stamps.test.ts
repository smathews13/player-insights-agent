import { describe, expect, it } from 'vitest';

import { compareCommits, parseAncestorList } from './build-stamps';

describe('build commit lineage', () => {
  const app = '59ff353012345678901234567890123456789012';
  const model = '11be12b012345678901234567890123456789012';

  it('recognises equal full or abbreviated commits', () => {
    expect(compareCommits(app, '59ff353')).toBe('same');
  });

  it('recognises an orchestrator commit in the app lineage', () => {
    expect(compareCommits(app, model, [app, model])).toBe('ancestor');
  });

  it('keeps a genuine divergence distinct', () => {
    expect(compareCommits(app, model, [app, '77cc88d012345678901234567890123456789012'])).toBe('different');
  });

  it('does not claim agreement when either value is missing', () => {
    expect(compareCommits(app, '')).toBe('uncompared');
    expect(compareCommits('', model)).toBe('uncompared');
  });

  it('parses the build environment without dirty suffixes or short noise', () => {
    expect(parseAncestorList(` ${app}+dirty,${model}\nabc `)).toEqual([app, model]);
  });
});
