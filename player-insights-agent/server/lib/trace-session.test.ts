import { describe, expect, it } from 'vitest';

import {
  conversationTraceSessionId,
  questionTraceSessionId,
  QUESTION_TRACE_SESSION_BASIS,
  TRACE_SESSION_ATTACHMENT_CHARS,
  TRACE_SESSION_BASIS,
  turnTraceSession,
} from './trace-session';

describe('conversation trace session', () => {
  it('uses the conversation id as the session, as the agent does', () => {
    expect(conversationTraceSessionId('conv-6f0c2a52-1b6e-4f5e-9d51-3c2d9e0a7b11')).toBe(
      'conv-6f0c2a52-1b6e-4f5e-9d51-3c2d9e0a7b11'
    );
  });

  it.each(['', ' conv-1', 'has space', 'x'.repeat(129), '-leading-dash'])(
    'refuses %j, which the agent would not use either',
    (id) => {
      expect(conversationTraceSessionId(id)).toBeNull();
    }
  );

  it('gives every turn of one conversation the same session regardless of the question', () => {
    const first = turnTraceSession('conv-1', 'Analyze activity by label.', '');
    const second = turnTraceSession('conv-1', 'Analyze spend by region.', '');
    expect(first).toEqual({ id: 'conv-1', basis: TRACE_SESSION_BASIS });
    expect(second).toEqual(first);
  });

  it('falls back to the question fingerprint, with the older basis, for an unusable id', () => {
    expect(turnTraceSession('has space', 'Analyze activity by label.', '')).toEqual({
      id: 'plan-a0edd9f880c22577',
      basis: QUESTION_TRACE_SESSION_BASIS,
    });
  });
});

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
