import { describe, expect, it } from 'vitest';

import { questionTraceSessionId, TRACE_SESSION_ATTACHMENT_CHARS } from './trace-session';

describe('questionTraceSessionId', () => {
  it.each([
    ['Analyze activity by label.', '', 'plan-a0edd9f880c22577'],
    ['Métriques 🎮', '## notes.txt\nΔ', 'plan-7665145cfc3d2dd8'],
  ])('matches the Python agent fingerprint for %s', (question, attachment, expected) => {
    expect(questionTraceSessionId(question, attachment)).toBe(expected);
  });

  it('matches the agent attachment trim and 8,000-character cap', () => {
    const attachment = `  ${'abcdefghij'.repeat(9_000)}  `;

    expect(TRACE_SESSION_ATTACHMENT_CHARS).toBe(8_000);
    expect(questionTraceSessionId('Analyze activity by label.', attachment)).toBe('plan-b92b33fa2775c690');
  });

  it('caps supplementary-plane characters by Python code point rather than UTF-16 unit', () => {
    const attachment = '😀'.repeat(8_001);

    expect(attachment.length).toBe(16_002);
    expect(questionTraceSessionId('Emoji attachment', attachment)).toBe('plan-583a47f4cefeac08');
  });

  it('hashes a revision under its clean question rather than its revision-specific plan id', () => {
    const question = 'Compare activity by label.';
    const revision = [
      `Revise the proposed analysis plan for this question: ${question}`,
      '',
      'What to change: Use the second source.',
      '',
      'Propose an updated plan for approval. Do not run the analysis yet.',
    ].join('\n');

    expect(questionTraceSessionId(revision, '')).toBe('plan-3cd0547a3681f429');
    expect(questionTraceSessionId(revision, '')).toBe(questionTraceSessionId(question, ''));
  });
});
