import { Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { TraceStage } from './answer-shape';
import { askStreaming } from './ask-stream';
import { LiveProgress } from './LiveProgress';
import { StoredAnswerLoadError, StoredAnswerLoading } from './StoredAnswerBoundary';
import type { StoredAnswerRendererProps } from './StoredAnswerRenderer';
import {
  createLazyStoredAnswerRenderer,
  createStoredAnswerRendererPreloader,
  preloadStoredAnswerRendererForHistory,
  scheduleStoredAnswerRendererPreload,
  startStoredAnswerRendererPreload,
  type StoredAnswerRendererPreloader,
} from './stored-answer-loader';

type RendererModule = typeof import('./StoredAnswerRenderer');

const STAGE: TraceStage = {
  id: 'step-1',
  name: 'Queried governed data',
  kind: 'tool',
  status: 'complete',
  start: 120,
  duration: 3400,
  calls: 1,
  input: '{}',
  output: 'rows',
  depth: 1,
  parent_id: 'step-1',
};

function rendererModule(): RendererModule {
  const Renderer = (props: StoredAnswerRendererProps) => <div data-formatted={props.id}>Formatted answer</div>;
  return { default: Renderer };
}

function rendererProps(id: string, rawContent = `RAW-${id}`): StoredAnswerRendererProps {
  return {
    id,
    rawContent,
    feedback: { usefulness: null, comment: '', saving: false, saved: false, open: false, error: null },
    onFeedbackChange: () => undefined,
    saveFeedback: () => Promise.resolve(),
    showFeedback: false,
  };
}

function loadedFrame(preload: StoredAnswerRendererPreloader, props: StoredAnswerRendererProps): string {
  const loaded = preload.peek();
  if (!loaded) return renderToStaticMarkup(<StoredAnswerLoading />);
  const Renderer = loaded.default;
  return renderToStaticMarkup(<Renderer {...props} />);
}

function frame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

describe('answer renderer latency isolation', () => {
  it('starts POST/SSE and renders live progress while the answer import is unresolved', async () => {
    let resolveImport: (module: RendererModule) => void = () => undefined;
    let importSettled = false;
    const importer = vi.fn(
      () =>
        new Promise<RendererModule>((resolve) => {
          resolveImport = (module) => {
            importSettled = true;
            resolve(module);
          };
        })
    );
    const preload = createStoredAnswerRendererPreloader(importer);
    const scheduled: Array<() => void> = [];

    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }
    );
    const fetchImpl: typeof fetch = () => Promise.resolve(response);
    const fetcher = vi.fn(fetchImpl);
    let resolveStage: () => void = () => undefined;
    const stageSeen = new Promise<void>((resolve) => {
      resolveStage = resolve;
    });
    let liveMarkup = '';

    const answer = askStreaming(
      { prompt: 'Which title led?', approvedPlanId: 'plan-1', executePlan: true },
      {
        onOpen() {
          scheduleStoredAnswerRendererPreload(preload, (task) => scheduled.push(task));
        },
        onStage(stage) {
          liveMarkup = renderToStaticMarkup(
            <LiveProgress stages={[stage]} openedAt={Date.now()} question="Which title led?" />
          );
          resolveStage();
        },
      },
      fetcher
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(importer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    scheduled[0]();
    expect(importer).toHaveBeenCalledOnce();
    stream.enqueue(new TextEncoder().encode(': open\n\n'));
    stream.enqueue(frame('stage', STAGE));
    await stageSeen;

    expect(importSettled).toBe(false);
    expect(liveMarkup).toContain('Queried governed data');

    // A normal multi-second run resolves the answer graph before its terminal
    // event. The result can therefore mount without adding a second network wait.
    const loadedRenderer = rendererModule();
    resolveImport(loadedRenderer);
    await expect(preload()).resolves.toBe(loadedRenderer);
    stream.enqueue(frame('result', { type: 'answer', takeaway: 'VLH Online led.' }));
    stream.close();
    await expect(answer).resolves.toMatchObject({ body: { takeaway: 'VLH Online led.' } });
  });

  it('forgets a failed import so retry can recover without changing answer data', async () => {
    const loadedRenderer = rendererModule();
    const importer = vi
      .fn<() => Promise<RendererModule>>()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce(loadedRenderer);
    const preload = createStoredAnswerRendererPreloader(importer);

    await expect(preload()).rejects.toThrow('chunk unavailable');
    const props = rendererProps('answer-retry', 'RAW RETAINED ANSWER');
    const failure = renderToStaticMarkup(
      <StoredAnswerLoadError onRetry={() => startStoredAnswerRendererPreload(preload)} />
    );
    expect(failure).toContain('Retry answer');
    expect(failure).not.toContain(props.rawContent);

    await expect(preload()).resolves.toBe(loadedRenderer);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(loadedFrame(preload, props)).toContain('data-formatted="answer-retry"');
    expect(props.rawContent).toBe('RAW RETAINED ANSWER');
  });

  it('never emits raw prose while the shared import is unresolved, including rapid switches', () => {
    const importer = vi.fn(() => new Promise<RendererModule>(() => undefined));
    const preload = createStoredAnswerRendererPreloader(importer);
    const Renderer = createLazyStoredAnswerRenderer(preload);
    const draw = (props: StoredAnswerRendererProps) =>
      renderToStaticMarkup(
        <Suspense fallback={<StoredAnswerLoading />}>
          <Renderer {...props} />
        </Suspense>
      );

    const first = draw(rendererProps('answer-a', 'RAW ANSWER A'));
    const second = draw(rendererProps('answer-b', 'RAW ANSWER B'));

    expect(first).not.toContain('RAW ANSWER A');
    expect(second).not.toContain('RAW ANSWER A');
    expect(second).not.toContain('RAW ANSWER B');
    expect(second).toContain('aria-busy="true"');
    expect(second).toContain('stored-answer-skeleton-figure');
    expect(importer).toHaveBeenCalledOnce();
  });

  it('prefetches once when rail history first proves a saved answer exists', () => {
    const importer = vi.fn(() => new Promise<RendererModule>(() => undefined));
    const preload = createStoredAnswerRendererPreloader(importer);
    const scheduled: Array<() => void> = [];
    const schedule = (task: () => void) => scheduled.push(task);

    preloadStoredAnswerRendererForHistory([{ status: null }], preload, schedule);
    expect(scheduled).toHaveLength(0);
    expect(importer).not.toHaveBeenCalled();

    preloadStoredAnswerRendererForHistory([{ status: 'SUCCEEDED' }], preload, schedule);
    preloadStoredAnswerRendererForHistory([{ role: 'assistant' }], preload, schedule);
    expect(scheduled).toHaveLength(2);
    scheduled.forEach((task) => task());
    expect(importer).toHaveBeenCalledOnce();
  });

  it('renders every later answer synchronously after the one module resolves', async () => {
    const loadedRenderer = rendererModule();
    const importer = vi.fn(() => Promise.resolve(loadedRenderer));
    const preload = createStoredAnswerRendererPreloader(importer);

    await preload();
    const first = loadedFrame(preload, rendererProps('answer-one'));
    const second = loadedFrame(preload, rendererProps('answer-two'));

    expect(first).toContain('data-formatted="answer-one"');
    expect(second).toContain('data-formatted="answer-two"');
    expect(first).not.toContain('stored-answer-loading');
    expect(second).not.toContain('stored-answer-loading');
    expect(importer).toHaveBeenCalledOnce();
  });
});
