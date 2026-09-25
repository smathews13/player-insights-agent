import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  conversationIsLive,
  readActiveConversationRuns,
  resetActiveConversationRunsForTests,
  subscribeToActiveConversationRuns,
  trackActiveConversationRun,
  updateActiveConversationRuns,
} from './active-conversation-runs';
import { settleAskDisplay, terminalSettlementForResponse } from './ask-terminal-state';
import { normalizeAnswer, type TraceStage, type WireAnswer } from './answer-shape';
import type { Answer, ConversationMessage, DashboardResponse, ReportResponse } from './app-types';
import { ConversationRailRunStatus } from './ConversationRailRunStatus';
import { claimConversationTitle, unaskedConversation } from './conversation-rail';
import { mergeNewestConversationMessages } from './conversation-messages';
import { beginLiveAsk, identifyLiveAsk, readLiveAsk, resetLiveAsks, subscribeToLiveAsks } from './live-ask';

const CONVERSATION = 'conversation-first';
const RUN = 'run-first';
const NOW = '2026-08-31T18:00:00.000Z';
const STAGE: TraceStage = {
  id: 'synthesis',
  name: 'Wrote the answer',
  kind: 'agent',
  status: 'complete',
  start: 0,
  duration: 1200,
  calls: 1,
  input: '',
  output: '',
  startMeasured: true,
};

function answer(id = 'answer-first'): Answer {
  return normalizeAnswer({
    id,
    type: 'answer',
    mode: 'live',
    takeaway: 'The first answer landed.',
    narrative: 'The persisted answer contains enough detail to be a completed response.',
    figures: [],
    sources: [],
    caveats: [],
    sql: '',
    trace: { id: 'tr-1234567890abcdef', totalMs: 1200, toolCalls: 1, stages: [STAGE] },
  } as WireAnswer) as Answer;
}

function start(question: string, runId = RUN) {
  beginLiveAsk({ conversationId: CONVERSATION, question });
  identifyLiveAsk(CONVERSATION, runId);
  updateActiveConversationRuns((current) =>
    trackActiveConversationRun(current, CONVERSATION, {
      run_id: runId,
      state: 'RUNNING',
      created_at: NOW,
      updated_at: NOW,
      terminal_code: null,
      stages: [STAGE],
    })
  );
}

function renderFrame(messages: readonly ConversationMessage[], renderer: 'pending' | 'resolved'): string {
  const active = readActiveConversationRuns();
  const live = readLiveAsk(CONVERSATION);
  const isLive = conversationIsLive(active, CONVERSATION, Boolean(live?.inFlight));
  return renderToStaticMarkup(
    <main data-renderer={renderer}>
      {messages.map((message) =>
        message.role === 'assistant' ? (
          <article key={message.id} data-answer={message.id}>
            {message.content}
          </article>
        ) : (
          <p key={message.id}>{message.content}</p>
        )
      )}
      {isLive ? <section data-live-placeholder="true">Live</section> : null}
      <ConversationRailRunStatus
        run={active.get(CONVERSATION) ?? null}
        stages={live?.stages ?? []}
        streamed={Boolean(live?.inFlight)}
        fallback={null}
      />
    </main>
  );
}

function expectNoAnswerWithLive(frames: readonly string[], answerId = 'answer-first') {
  for (const frame of frames) {
    expect(frame.includes(`data-answer="${answerId}"`) && frame.includes('data-live-placeholder="true"')).toBe(false);
  }
}

beforeEach(() => {
  resetLiveAsks();
  resetActiveConversationRunsForTests();
});

afterEach(() => {
  resetLiveAsks();
  resetActiveConversationRunsForTests();
});

describe('first-answer terminal ordering', () => {
  it.each([
    {
      kind: 'dashboard',
      response: {
        type: 'dashboard',
        mode: 'live',
        id: 'message-dashboard',
        dashboard: {
          schemaVersion: 'pia.dashboard/1',
          title: 'Dashboard',
          html: '<!DOCTYPE html><html><body>Dashboard</body></html>',
        },
      } satisfies DashboardResponse,
      duration: 324_600,
    },
    {
      kind: 'report',
      response: {
        type: 'report',
        mode: 'live',
        id: 'message-report',
        report: {
          schema_version: 'pia.report/1',
          title: 'Report',
          sections: [{ body: 'Complete report.' }],
        },
      } satisfies ReportResponse,
      duration: 214_300,
    },
  ])('settles a live $kind as Complete as soon as its result event arrives', ({ response, duration }) => {
    start(`Build a ${response.type}`);
    settleAskDisplay(
      CONVERSATION,
      RUN,
      terminalSettlementForResponse(response, {
        runStored: true,
        trace: { totalMs: duration },
      })
    );
    const active = readActiveConversationRuns();
    expect(conversationIsLive(active, CONVERSATION)).toBe(false);
    expect(active.get(CONVERSATION)?.summary).toMatchObject({
      runId: response.id,
      status: 'Complete',
      durationMs: duration,
    });
  });

  it('never commits the first persisted answer beside an extra Live placeholder', () => {
    let messages: ConversationMessage[] = [{ id: 'question-first', role: 'user', content: 'Who led?' }];
    let renderer: 'pending' | 'resolved' = 'pending';
    let conversations = [unaskedConversation({ id: CONVERSATION, owner: 'sam@example.com', updatedAt: NOW })];
    conversations = claimConversationTitle(conversations, {
      id: CONVERSATION,
      prompt: 'Who led?',
      owner: 'sam@example.com',
      updatedAt: NOW,
    });
    start('Who led?');

    const frames: string[] = [renderFrame(messages, renderer)];
    const capture = () => frames.push(renderFrame(messages, renderer));
    const stopActive = subscribeToActiveConversationRuns(capture);
    const stopLive = subscribeToLiveAsks(capture);
    const result = answer();

    settleAskDisplay(CONVERSATION, RUN, terminalSettlementForResponse(result, { runStored: true }));
    messages = [...messages, { id: result.id, role: 'assistant', content: result.narrative, response_json: result }];
    frames.push(renderFrame(messages, renderer));
    renderer = 'resolved';
    frames.push(renderFrame(messages, renderer));
    conversations = claimConversationTitle(conversations, {
      id: CONVERSATION,
      prompt: 'Who led?',
      owner: 'sam@example.com',
      updatedAt: NOW,
    });

    expectNoAnswerWithLive(frames);
    expect(frames.at(-2)).toContain('data-renderer="pending"');
    expect(frames.at(-1)).toContain('data-renderer="resolved"');
    expect(frames.at(-1)).toContain('Complete');
    expect(conversations).toHaveLength(1);
    stopActive();
    stopLive();
  });

  it('keeps the same invariant for an existing-conversation follow-up', () => {
    const previous = answer('answer-previous');
    let messages: ConversationMessage[] = [
      { id: 'question-previous', role: 'user', content: 'Previous question' },
      { id: previous.id, role: 'assistant', content: previous.narrative, response_json: previous },
      { id: 'question-follow-up', role: 'user', content: 'Follow up' },
    ];
    start('Follow up');
    const frames = [renderFrame(messages, 'resolved')];
    const capture = () => frames.push(renderFrame(messages, 'resolved'));
    const stopActive = subscribeToActiveConversationRuns(capture);
    const stopLive = subscribeToLiveAsks(capture);
    const result = answer('answer-follow-up');

    settleAskDisplay(CONVERSATION, RUN, terminalSettlementForResponse(result, { runStored: true }));
    messages = [...messages, { id: result.id, role: 'assistant', content: result.narrative, response_json: result }];
    frames.push(renderFrame(messages, 'resolved'));

    expectNoAnswerWithLive(frames, result.id);
    expect(frames.at(-1)?.match(/data-answer=/g)).toHaveLength(2);
    stopActive();
    stopLive();
  });

  it.each(['sse-before-refresh', 'refresh-after-terminal-poll'] as const)(
    'deduplicates the persisted message when completion arrives by %s',
    (order) => {
      const result = answer();
      let messages: ConversationMessage[] = [{ id: 'local-question', role: 'user', content: 'Who led?' }];
      const stored: ConversationMessage[] = [
        { id: 'stored-question', role: 'user', content: 'Who led?', created_at: NOW },
        {
          id: result.id,
          role: 'assistant',
          content: result.narrative,
          response_json: result,
          created_at: '2026-08-31T18:00:02.000Z',
        },
      ];
      start('Who led?');
      const frames = [renderFrame(messages, 'pending')];

      // Both delivery orders settle the exact run before making the persisted
      // answer visible. The SSE-first path then reconciles its optimistic row;
      // the poll-first path exposes the store row directly.
      settleAskDisplay(CONVERSATION, RUN, terminalSettlementForResponse(result, { runStored: true }));
      frames.push(renderFrame(messages, 'pending'));
      if (order === 'sse-before-refresh') {
        messages = [
          ...messages,
          { id: result.id, role: 'assistant', content: result.narrative, response_json: result },
        ];
        frames.push(renderFrame(messages, 'pending'));
      }
      messages = mergeNewestConversationMessages(messages, stored);
      frames.push(renderFrame(messages, 'resolved'));

      expectNoAnswerWithLive(frames, result.id);
      expect(messages.filter((message) => message.id === result.id)).toHaveLength(1);
      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    }
  );

  it('ignores a stale terminal callback after a newer run starts', () => {
    start('First');
    settleAskDisplay(CONVERSATION, RUN, terminalSettlementForResponse(answer(), { runStored: true }));
    beginLiveAsk({ conversationId: CONVERSATION, question: 'Second' });
    identifyLiveAsk(CONVERSATION, 'run-second');
    updateActiveConversationRuns((current) =>
      trackActiveConversationRun(current, CONVERSATION, {
        run_id: 'run-second',
        state: 'RUNNING',
        created_at: '2026-08-31T18:01:00.000Z',
        updated_at: '2026-08-31T18:01:00.000Z',
        terminal_code: null,
      })
    );

    settleAskDisplay(CONVERSATION, RUN, terminalSettlementForResponse(answer(), { runStored: true }));

    expect(readLiveAsk(CONVERSATION)).toMatchObject({ runId: 'run-second', inFlight: true });
    expect(readActiveConversationRuns().get(CONVERSATION)?.status).toMatchObject({
      run_id: 'run-second',
      state: 'RUNNING',
    });
  });
});
