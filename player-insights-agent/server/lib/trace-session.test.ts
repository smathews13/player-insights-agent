import { describe, expect, it } from 'vitest';

import { questionTraceSessionId } from './trace-session';

describe('questionTraceSessionId', () => {
  it.each([
    ['Analyze activity by label.', '', 'plan-a0edd9f880c22577'],
    ['Métriques 🎮', '## notes.txt\nΔ', 'plan-7665145cfc3d2dd8'],
  ])('matches the Python agent fingerprint for %s', (question, attachment, expected) => {
    expect(questionTraceSessionId(question, attachment)).toBe(expected);
  });
});
