import { describe, expect, it } from 'vitest';

import { migrationOrder, quotedIdentifier } from './migrate-app-schema-data.mjs';

describe('schema data handoff safety', () => {
  it('copies parents before children and keeps unrelated tables deterministic', () => {
    expect(
      migrationOrder(
        ['messages', 'feedback', 'conversations'],
        [
          { child: 'messages', parent: 'conversations' },
          { child: 'feedback', parent: 'messages' },
        ]
      )
    ).toEqual(['conversations', 'messages', 'feedback']);
  });

  it('refuses cyclic dependencies rather than disabling constraints', () => {
    expect(() =>
      migrationOrder(
        ['left', 'right'],
        [
          { child: 'left', parent: 'right' },
          { child: 'right', parent: 'left' },
        ]
      )
    ).toThrow(/dependency cycle/);
  });

  it('accepts only plain Postgres identifiers', () => {
    expect(quotedIdentifier('player_insights_v2')).toBe('"player_insights_v2"');
    expect(() => quotedIdentifier('player_insights; DROP SCHEMA public')).toThrow(/Unsafe Postgres identifier/);
  });
});
