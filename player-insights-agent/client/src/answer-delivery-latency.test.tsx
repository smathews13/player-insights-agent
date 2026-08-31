import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { TraceStage } from './answer-shape';
import { askStreaming } from './ask-stream';
import { LiveProgress } from './LiveProgress';
import type { StoredAnswerRendererProps } from './StoredAnswerRenderer';
import { createStoredAnswerRendererPreloader, startStoredAnswerRendererPreload } from './stored-answer-loader';

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
  const Renderer = (_props: StoredAnswerRendererProps) => <div />;
  return { default: Renderer };
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

    startStoredAnswerRendererPreload(preload);
    expect(importer).toHaveBeenCalledOnce();

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
    await expect(preload()).resolves.toBe(loadedRenderer);
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
