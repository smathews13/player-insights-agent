import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { AnswerCard } from './AnswerCard';
import { normalizeAnswer, type WireAnswer } from './answer-shape';
import type { Answer, FeedbackEntry } from './app-types';
import { writeRunProcessPreference } from './run-process-preference';

const FEEDBACK: FeedbackEntry = {
  open: false,
  comment: '',
  saved: false,
  saving: false,
  error: null,
  usefulness: null,
};

const ANSWER = normalizeAnswer({
  id: 'answer-process-density',
  mode: 'live',
  provenance: 'live',
  takeaway: 'The answer stays primary.',
  narrative: 'The supporting run can be inspected on demand.',
  figures: [],
  sources: [],
  caveats: [],
  sql: 'SELECT 1',
  trace: {
    id: 'tr-deadbeef',
    totalMs: 100,
    toolCalls: 1,
    stages: [
      {
        id: 'step-1-0-data_genie',
        name: 'Queried governed data',
        kind: 'tool',
        start: 0,
        duration: 100,
        status: 'complete',
        calls: 1,
        input: '',
        output: '',
      },
    ],
  },
} as WireAnswer) as Answer;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => values.set(key, value),
  };
}

function card(props: { defaultRunProcessOpen?: boolean; runProcessPreferenceKey?: string } = {}): string {
  return renderToStaticMarkup(
    <AnswerCard
      answer={ANSWER}
      feedback={FEEDBACK}
      onFeedbackChange={() => {}}
      saveFeedback={async () => {}}
      showFeedback={false}
      {...props}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('answer process density by surface', () => {
  it('keeps the process available but collapsed on Ask by default', () => {
    const markup = card({ defaultRunProcessOpen: false, runProcessPreferenceKey: 'message-new' });

    expect(markup).toContain('Run process');
    expect(markup).toContain('View process');
    expect(markup).not.toContain('Step timeline');
  });

  it('restores an explicit expansion for the same answer during the session', () => {
    const sessionStorage = memoryStorage();
    writeRunProcessPreference('message-stored', true, sessionStorage);
    vi.stubGlobal('window', { sessionStorage });

    const markup = card({ defaultRunProcessOpen: false, runProcessPreferenceKey: 'message-stored' });

    expect(markup).toContain('Hide process');
    expect(markup).toContain('Step timeline');
  });

  it('leaves a dedicated process surface fully open by default', () => {
    const markup = card();

    expect(markup).toContain('Hide process');
    expect(markup).toContain('Step timeline');
  });
});
