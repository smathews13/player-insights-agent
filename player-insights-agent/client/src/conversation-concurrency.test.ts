import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

describe('conversation-scoped active questions', () => {
  it('leaves new-conversation and conversation-selection controls usable during another run', () => {
    const rail = HOME.slice(HOME.indexOf('const renderRail'), HOME.indexOf('const transcriptEmpty'));
    expect(rail).not.toContain('disabled={loading}');
    expect(rail).toContain('disabled={conversationLoading}');
  });

  it('blocks duplicate submission by conversation rather than page-global loading', () => {
    expect(HOME).toContain(
      'if (!question.trim() || readLiveAsk(conversationId)?.inFlight || readActiveAsk(conversationId)) return;'
    );
  });

  it('files background completion under the run origin before touching visible transcript state', () => {
    const ask = HOME.slice(HOME.indexOf('async function ask('), HOME.indexOf('function startNewConversation()'));
    expect(ask).toContain('const runConversationId = conversationId');
    expect(ask).toContain('const stillInThisConversation = () => activeConversationRef.current === runConversationId');
    const completion = ask.slice(ask.indexOf('const { body } = await askStreaming'));
    expect(completion.indexOf('if (!stillInThisConversation()) return;')).toBeLessThan(
      completion.indexOf('setMessages((items) => [')
    );
  });

  it('does not abort active questions from navigation or effect cleanup', () => {
    expect(HOME).not.toMatch(/return\s*\(\)\s*=>\s*\{[^}]*\.abort\(/s);
    expect(HOME).toContain('const streamed = readActiveAsk(conversationId)');
  });
});
