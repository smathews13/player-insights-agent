import { describe, expect, it, vi } from 'vitest';
import { AskRunFailed, askStreaming } from './ask-stream';

function sse(blocks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    ...init,
  });
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const STAGE = {
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

function fetchReturning(response: Response) {
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe('askStreaming', () => {
  it('reports each finished stage and then resolves with the answer', async () => {
    const stages: string[] = [];
    const response = sse([
      ': open\n\n',
      frame('stage', { ...STAGE, id: 'step-1', name: 'Chose the next step' }),
      frame('stage', { ...STAGE, id: 'step-2', name: 'Queried governed data' }),
      frame('result', { type: 'answer', takeaway: 'VLH Online led.' }),
    ]);

    const result = await askStreaming({ prompt: 'x' }, { onStage: (s) => stages.push(s.name) }, fetchReturning(response));

    expect(stages).toEqual(['Chose the next step', 'Queried governed data']);
    expect(result).toEqual({ body: { type: 'answer', takeaway: 'VLH Online led.' }, streamed: true });
  });

  it('reports the stream opening before any stage, which is the only early fact there is', async () => {
    // The endpoint holds each stage until the next one is produced, so the
    // first can be twenty seconds out. This is what the panel has to say in the
    // meantime, and it has to be a real event rather than an elapsed guess.
    const seen: string[] = [];
    const response = sse([': open\n\n', frame('stage', STAGE), frame('result', {})]);

    await askStreaming(
      {},
      { onOpen: () => seen.push('open'), onStage: () => seen.push('stage') },
      fetchReturning(response)
    );

    expect(seen).toEqual(['open', 'stage']);
  });

  it('does not report a stream opening when the server answered with a plain body', async () => {
    // A non-streaming reply is not a run being narrated, and saying it had
    // started would be a claim about something that never happened.
    const seen: string[] = [];
    const response = new Response(JSON.stringify({ type: 'answer' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await askStreaming({}, { onOpen: () => seen.push('open'), onStage: () => {} }, fetchReturning(response));

    expect(seen).toEqual([]);
    expect(result.streamed).toBe(false);
  });

  it('normalizes a stage, so a field the agent stops sending cannot render as undefined', async () => {
    const seen: unknown[] = [];
    const response = sse([frame('stage', { id: 'step-1', name: 'Prepared the findings' }), frame('result', {})]);

    await askStreaming({}, { onStage: (s) => seen.push(s) }, fetchReturning(response));

    expect(seen[0]).toMatchObject({
      id: 'step-1',
      name: 'Prepared the findings',
      kind: 'agent',
      duration: 0,
      calls: 0,
    });
  });

  it('keeps the measured start of a stage that reported one', async () => {
    const seen: { start: number; startMeasured?: boolean }[] = [];
    const response = sse([frame('stage', STAGE), frame('result', {})]);

    await askStreaming({}, { onStage: (s) => seen.push(s) }, fetchReturning(response));

    expect(seen[0].start).toBe(120);
    expect(seen[0].startMeasured).not.toBe(false);
  });

  it('reads an event split across chunk boundaries', async () => {
    const whole = frame('stage', STAGE);
    const stages: string[] = [];
    const response = sse([whole.slice(0, 25), whole.slice(25), frame('result', {})]);

    await askStreaming({}, { onStage: (s) => stages.push(s.name) }, fetchReturning(response));

    expect(stages).toEqual(['Queried governed data']);
  });

  it('fails, naming how far the run got, when the stream ends with no answer', async () => {
    const response = sse([frame('stage', STAGE), frame('stage', { ...STAGE, id: 'step-2' })]);

    const failure = await askStreaming({}, { onStage: () => {} }, fetchReturning(response)).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AskRunFailed);
    expect((failure as AskRunFailed).completed).toBe(2);
    // The count is on screen next to two rows the user watched arrive, so it
    // has to be the number of rows and not a generic outage message.
    expect((failure as AskRunFailed).message).toContain('after 2 steps');
  });

  it('distinguishes a run that never reported a step', async () => {
    const failure = await askStreaming({}, { onStage: () => {} }, fetchReturning(sse([': open\n\n']))).catch(
      (error: unknown) => error
    );

    expect((failure as AskRunFailed).completed).toBe(0);
    expect((failure as AskRunFailed).message).toContain('before the agent reported any steps');
  });

  it('surfaces the server\u2019s own wording from an error event', async () => {
    const response = sse([
      frame('stage', STAGE),
      frame('error', { error: 'plan_not_executed', message: 'The agent proposed the same plan again.' }),
    ]);

    const failure = await askStreaming({}, { onStage: () => {} }, fetchReturning(response)).catch(
      (error: unknown) => error
    );

    expect((failure as AskRunFailed).message).toBe('The agent proposed the same plan again.');
    expect((failure as AskRunFailed).completed).toBe(1);
  });

  it('accepts one JSON body from a server that did not stream', async () => {
    const response = new Response(JSON.stringify({ type: 'plan', plan: { id: 'plan-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await askStreaming({}, { onStage: () => {} }, fetchReturning(response));

    expect(result.streamed).toBe(false);
    expect(result.body).toEqual({ type: 'plan', plan: { id: 'plan-1' } });
  });

  it('treats a refusal with a status code as the failure it is', async () => {
    const response = new Response(JSON.stringify({ error: 'context_unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(askStreaming({}, { onStage: () => {} }, fetchReturning(response))).rejects.toThrow(
      /did not return a usable answer/
    );
  });

  it('asks for a stream, and still posts the question as JSON', async () => {
    const spy = vi.fn().mockResolvedValue(sse([frame('result', {})]));

    await askStreaming({ prompt: 'x' }, { onStage: () => {} }, spy as unknown as typeof fetch);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ prompt: 'x' }));
  });
});
