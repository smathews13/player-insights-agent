import { describe, it, expect } from 'vitest';
import { conversationTitle, CONVERSATION_TITLE_LIMIT, PLACEHOLDER_CONVERSATION_TITLE } from './conversation-title';

describe('conversationTitle', () => {
  it('keeps a real question whole, which the old 80-character cut did not', () => {
    // The exact question that was found stored as a fragment in the rail on example,
    // ending "and how many" with nothing to say the rest had been deleted.
    const asked = 'Which three titles had the most active players in the last 30 days, and how many did each have?';
    expect(asked.length).toBeGreaterThan(80);
    expect(conversationTitle(asked)).toBe(asked);
  });

  it('does not cut in the middle of a word', () => {
    const prompt = `${'word '.repeat(70)}finalword`;
    const label = conversationTitle(prompt);
    // Every word in the label is a whole word from the prompt.
    for (const word of label.replace(/\u2026$/, '').split(' ')) {
      expect(['word', 'finalword']).toContain(word);
    }
  });

  it('says that it shortened, and stays inside the limit while saying it', () => {
    const label = conversationTitle('x '.repeat(400));
    expect(label.endsWith('\u2026')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(CONVERSATION_TITLE_LIMIT);
  });

  it('adds no ellipsis when it removed nothing, so the mark means something', () => {
    expect(conversationTitle('Short question?')).toBe('Short question?');
  });

  it('collapses newlines and runs of spaces, which clamp into ragged gaps', () => {
    expect(conversationTitle('  Compare active\n\nplayers   by title.  ')).toBe('Compare active players by title.');
  });

  it('still returns a label for one unbroken token with no space to cut on', () => {
    // A pasted fully qualified name or URL: cutting at the last space would be
    // cutting at nothing, and returning an empty label loses the row in the rail.
    const label = conversationTitle('a'.repeat(500));
    expect(label).toHaveLength(CONVERSATION_TITLE_LIMIT);
    expect(label.startsWith('aaaa')).toBe(true);
    expect(label.endsWith('\u2026')).toBe(true);
  });

  it('never returns the placeholder for a real question, which would freeze the label', () => {
    // The ask upsert replaces a stored title only while it equals the placeholder.
    // A derived label that happened to equal it would be replaceable forever.
    expect(conversationTitle(PLACEHOLDER_CONVERSATION_TITLE.toUpperCase())).not.toBe(PLACEHOLDER_CONVERSATION_TITLE);
  });
});
