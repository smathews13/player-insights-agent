import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

describe('Home terminal render ordering', () => {
  it('settles an SSE result before appending its answer', () => {
    const ask = HOME.slice(HOME.indexOf('async function ask('), HOME.indexOf('function startNewConversation()'));
    const result = ask.slice(ask.indexOf('const result = normalizeResponse(body)'));

    expect(result.indexOf('settleAskDisplay(')).toBeGreaterThan(-1);
    expect(result.indexOf('settleAskDisplay(')).toBeLessThan(result.indexOf('setMessages((items) => ['));
  });

  it('settles a terminal background poll before merging persisted messages', () => {
    const polling = HOME.slice(
      HOME.indexOf('const activeConversationRunIds'),
      HOME.indexOf('}, [activeConversationRunIds')
    );
    const terminal = polling.slice(polling.indexOf("status?.state === 'CANCELLED'"));

    expect(terminal.indexOf('settleActiveConversationRun(')).toBeGreaterThan(-1);
    expect(terminal.indexOf('endLiveAsk(')).toBeGreaterThan(-1);
    expect(terminal.indexOf('endLiveAsk(')).toBeLessThan(
      terminal.indexOf('setMessages((current) => mergeNewestConversationMessages')
    );
  });

  it('aborts stale poll reads and filters already-settled targets synchronously', () => {
    expect(HOME).toContain('const requests = new AbortController()');
    expect(HOME).toContain('requests.abort()');
    expect(HOME).toContain('readActiveConversationRuns().get(id)');
    expect(HOME).toContain('if (!run || !isWorkingConversationRun(run.status)) return []');
  });
});
