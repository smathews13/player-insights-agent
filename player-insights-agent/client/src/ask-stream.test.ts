import { describe, expect, it, vi } from 'vitest';
import { AskCancelled, AskRefused, AskRunFailed, AskUnreachable, askStreaming } from './ask-stream';
import { CORRELATION_HEADER, usableCorrelationId } from '../../shared/correlation';
import { unavailableNotice, unavailableNoticeFor } from './unavailable-copy';

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
  it('exposes the correlation id before fetch starts', async () => {
    const order: string[] = [];
    let started = '';
    const fetchImpl = vi.fn(() => {
      order.push('fetch');
      return Promise.resolve(sse([frame('result', {})]));
    }) as unknown as typeof fetch;

    const result = await askStreaming(
      {},
      {
        onStart: (correlationId) => {
          started = correlationId;
          order.push('start');
        },
        onStage: () => {},
      },
      fetchImpl
    );

    expect(order).toEqual(['start', 'fetch']);
    expect(started).toBe(result.correlationId);
  });

  it('passes an explicit cancellation signal to fetch and reports Stop separately', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('Ask cancelled')),
          { once: true }
        );
      });
    }) as unknown as typeof fetch;

    const pending = askStreaming({}, { onStage: () => {} }, fetchImpl, controller.signal);
    controller.abort(new DOMException('Stopped', 'AbortError'));

    await expect(pending).rejects.toBeInstanceOf(AskCancelled);
  });

  it('recognizes the server cancellation event without relabeling it as a stream failure', async () => {
    const response = sse([
      frame('stage', STAGE),
      frame('error', { type: 'cancelled', state: 'CANCELLED', message: 'Stopped.' }),
    ]);

    const failure = await askStreaming({}, { onStage: () => {} }, fetchReturning(response)).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AskCancelled);
    expect((failure as AskCancelled).completed).toBe(1);
    expect(failure).not.toBeInstanceOf(AskRunFailed);
  });

  it('reports each finished stage and then resolves with the answer', async () => {
    const stages: string[] = [];
    const response = sse([
      ': open\n\n',
      frame('stage', { ...STAGE, id: 'step-1', name: 'Chose the next step' }),
      frame('stage', { ...STAGE, id: 'step-2', name: 'Queried governed data' }),
      frame('result', { type: 'answer', takeaway: 'VLH Online led.' }),
    ]);

    const result = await askStreaming(
      { prompt: 'x' },
      { onStage: (s) => stages.push(s.name) },
      fetchReturning(response)
    );

    expect(stages).toEqual(['Chose the next step', 'Queried governed data']);
    expect(result).toMatchObject({ body: { type: 'answer', takeaway: 'VLH Online led.' }, streamed: true });
    expect(usableCorrelationId(result.correlationId)).toBe(result.correlationId);
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

  it('reports keep-alive comments as stream activity without turning them into stages', async () => {
    const activity: string[] = [];
    const stages: string[] = [];
    const response = sse([': open\n\n', ': keep-alive\n\n', frame('stage', STAGE), frame('result', {})]);

    await askStreaming(
      {},
      {
        onActivity: () => activity.push('activity'),
        onStage: (stage) => stages.push(stage.id),
      },
      fetchReturning(response)
    );

    expect(activity).toHaveLength(4);
    expect(stages).toEqual(['step-1']);
  });

  it('does not report a stream opening when the server answered with a plain body', async () => {
    // A non-streaming reply is not a run being narrated, and saying it had
    // started would be a claim about something that never happened.
    const seen: string[] = [];
    const response = new Response(JSON.stringify({ type: 'answer' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await askStreaming(
      {},
      { onOpen: () => seen.push('open'), onStage: () => {} },
      fetchReturning(response)
    );

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
    expect((failure as AskRunFailed).terminal).toBe(false);
    // The count is on screen next to two rows the user watched arrive, so it
    // has to be the number of rows and not a generic outage message.
    expect((failure as AskRunFailed).message).toContain('after 2 steps');
  });

  it('hands on a step announced before it finished, and counts only what finished', async () => {
    // The endpoint announces a step when it starts and reports it when it ends,
    // both as `stage` frames, and the rail wants both: the announcement is the row
    // it draws and rings, the report fills in the duration. The count beside a
    // failure is a different question -- "how far did it get" -- and an announced
    // step got nowhere, so it must not be counted twice or counted early.
    const seen: { name: string; status: string }[] = [];
    const response = sse([
      frame('stage', { ...STAGE, id: 'step-1', name: 'Choosing the next step', status: 'running', duration: 0 }),
      frame('stage', { ...STAGE, id: 'step-1', name: 'Chose the next step' }),
      frame('stage', { ...STAGE, id: 'synthesis', name: 'Preparing the answer', status: 'running', duration: 0 }),
    ]);

    const failure = await askStreaming(
      {},
      { onStage: (s) => seen.push({ name: s.name, status: s.status }) },
      fetchReturning(response)
    ).catch((error: unknown) => error);

    expect(seen).toEqual([
      { name: 'Choosing the next step', status: 'running' },
      { name: 'Chose the next step', status: 'complete' },
      { name: 'Preparing the answer', status: 'running' },
    ]);
    expect((failure as AskRunFailed).completed).toBe(1);
    expect((failure as AskRunFailed).message).toContain('after 1 step');
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
    expect((failure as AskRunFailed).terminal).toBe(true);
  });

  /**
   * THE PATH THE BROWSER ACTUALLY TAKES, and the one that was broken.
   *
   * `AskResponder.json` writes the terminal payload as `event: error` whenever
   * the status is 4xx or 5xx and the stream is already open -- and the stream is
   * opened before the endpoint is called, so every refusal of a real question
   * takes this route. The JSON-body test below it, which passed, only covers a
   * refusal that happened before `reply.begin()`.
   *
   * So the fully-described failure the server had gone to the trouble of
   * assembling was reduced to its `message` and rethrown as a run that stopped,
   * and the caller relabelled that STREAM_INTERRUPTED: retryable. A reader
   * denied SELECT on a table was told the connection had dropped, offered a
   * button that could only deny them again, and not given the correlation id.
   */
  it('hands on a refusal that arrived mid-stream, with every field intact', async () => {
    const refusal = {
      kind: 'unavailable',
      type: 'unavailable',
      code: 'USER_NOT_AUTHORIZED',
      layer: 'authorization',
      retryable: false,
      message: 'You do not have access to one or more data products required by this question.',
      request_id: 'req-88',
      run_id: null,
      last_verified_at: null,
      persistence_status: 'not_stored',
      execution_identity: { mode: 'signed_in_user', verified: true },
      evidence: {
        dependency: { kind: 'agent-endpoint', name: 'player-insights-agent' },
        status: 403,
        providerCode: 'PERMISSION_DENIED',
        providerMessage: 'The endpoint refused this request under the signed-in user\u2019s own credential.',
        principal: 'reader@example.com',
      },
    };
    const response = sse([
      ': open\n\n',
      frame('stage', STAGE),
      frame('stage', { ...STAGE, id: 'step-2' }),
      frame('error', refusal),
    ]);

    const failure = await askStreaming({}, { onStage: () => {} }, fetchReturning(response)).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AskRefused);
    const refused = failure as AskRefused;
    // The code, because it decides the retry posture and the wrong one here is
    // what put a "Try again" button over a permission denial.
    expect(refused.result.code).toBe('USER_NOT_AUTHORIZED');
    expect(refused.result.retryable).toBe(false);
    // The correlation id, which is the only thing a reader can take to support.
    expect(refused.result.request_id).toBe('req-88');
    // And the error itself, which is the whole point.
    expect(refused.result.evidence?.status).toBe(403);
    expect(refused.result.evidence?.providerCode).toBe('PERMISSION_DENIED');
    expect(refused.result.evidence?.dependency?.name).toBe('player-insights-agent');
    expect(refused.result.execution_identity?.mode).toBe('signed_in_user');
    // Stages the user watched arrive are still counted, so the interface can
    // leave them on the timeline instead of implying the run never started.
    expect(refused.completed).toBe(2);
  });

  it('still reports a non-contract error frame as a run that stopped', async () => {
    // `plan_not_executed` is a route-specific 502 body and not an
    // `UnavailableResult`. It has no failure code to honour, so the generic path
    // is correct for it -- narrowing on the contract rather than on the event
    // name is what keeps these two apart.
    const response = sse([
      frame('stage', STAGE),
      frame('error', { error: 'plan_not_executed', message: 'The agent proposed the same plan again.' }),
    ]);

    const failure = await askStreaming({}, { onStage: () => {} }, fetchReturning(response)).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AskRunFailed);
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

  it('hands on a refusal the server described, rather than a sentence of its own', async () => {
    const refusal = {
      kind: 'unavailable',
      code: 'USER_NOT_AUTHORIZED',
      layer: 'authorization',
      retryable: false,
      message: 'You do not have access to one or more data products required by this question.',
      request_id: 'req-7',
      run_id: null,
      last_verified_at: null,
      persistence_status: 'not_stored',
    };
    const response = new Response(JSON.stringify(refusal), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

    /*
     * An authorization denial used to arrive at the caller as "the live agent
     * did not return a usable answer", which the interface then rendered as an
     * unreachable endpoint. Every field a reader could act on -- which
     * permission, and the id to quote -- was in the body and thrown away one
     * line before it was needed.
     */
    const failure = await askStreaming({}, { onStage: () => {} }, fetchReturning(response)).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(AskRefused);
    expect((failure as AskRefused).result.code).toBe('USER_NOT_AUTHORIZED');
    expect((failure as AskRefused).result.request_id).toBe('req-7');
    expect((failure as AskRefused).message).toContain('do not have access');
  });

  it('still reports an unreadable failure body as the generic failure', async () => {
    // A proxy's HTML error page, which carries no contract and must not be
    // mistaken for one the server chose.
    const response = new Response('<html>502</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });

    await expect(askStreaming({}, { onStage: () => {} }, fetchReturning(response))).rejects.toThrow(
      /did not return a usable answer/
    );
  });

  /**
   * The whole path, in one test, because every individual link in it was
   * correct while the chain was broken.
   *
   * The server assembled the failure. The transport put it on the wire. The
   * parser received it. The copy module had a field for none of it. Each of
   * those has its own test above and each of them passed, and a reader was still
   * shown "a service this needed did not respond just now" over a 403. So this
   * one starts at the bytes and ends at the strings the panel draws.
   */
  it('carries a provider error from the wire to the words on the panel', async () => {
    const response = sse([
      ': open\n\n',
      frame('stage', { ...STAGE, name: 'Confirmed metric definitions' }),
      frame('stage', { ...STAGE, id: 'step-2', name: 'Query gold_title_daily_summary' }),
      frame('error', {
        kind: 'unavailable',
        type: 'unavailable',
        code: 'DEPENDENCY_UNAVAILABLE',
        layer: 'dependency',
        retryable: true,
        message: 'A service this needed did not respond just now.',
        request_id: 'req-2718',
        run_id: null,
        last_verified_at: null,
        persistence_status: 'not_stored',
        evidence: {
          dependency: { kind: 'agent-endpoint', name: 'player-insights-agent' },
          status: 503,
          providerCode: 'ENDPOINT_OVERLOADED',
          providerMessage: 'Served entity is currently scaling up and cannot accept requests.',
          stage: { title: 'Query gold_title_daily_summary', completed: 2 },
        },
      }),
    ]);

    const failure = (await askStreaming({}, { onStage: () => {} }, fetchReturning(response)).catch(
      (error: unknown) => error
    )) as AskRefused;
    const notice = unavailableNoticeFor('ask', failure.result, { interactive: true });

    // What failed, by name, in the line a reader actually reads.
    expect(notice.heading).toBe('Agent serving endpoint player-insights-agent did not respond');
    // What it said, verbatim and in full.
    expect(notice.error).toBe(
      'HTTP 503 \u00b7 ENDPOINT_OVERLOADED \u00b7 Served entity is currently scaling up and cannot accept requests.'
    );
    // Where it got to.
    expect(notice.stage).toContain('2 completed steps');
    expect(notice.stage).toContain('Query gold_title_daily_summary');
    // And the id to quote, which this path used to discard.
    expect(notice.correlation).toBe('Correlation ID: req-2718');
    // Retrying a scaling endpoint is worth it, so the advice is present here --
    // and the assertion that matters is that it is the only advice, rather than
    // the third sentence of a paragraph about what the app declines to invent.
    expect(notice.retryAdvice).toContain('worth trying again shortly');
    expect(notice.consequence).toBe('Nothing was answered and the conversation is unchanged.');
  });

  /**
   * THE FAILURE THAT PROMPTED ALL OF THIS, reproduced.
   *
   * The observed sequence, from the app's own stored messages and its deploy
   * log: the question was asked at 01:16:50, the plan came back at 01:17:02, the
   * reader approved it at 01:19:32, and at 01:19:42 the server began shutting
   * down for a release. Measured runs take 95 to 146 seconds, so the approval had
   * no chance of finishing. The browser's `fetch` rejected with nothing to read,
   * and the reader was shown four sentences that named no service, no error and
   * no cause -- while pointing, by implication, at an agent endpoint that was
   * answering normally throughout.
   */
  it('names the hop that failed when no response arrived at all', async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const failure = (await askStreaming({ prompt: 'x' }, { onStage: () => {} }, offline).catch(
      (error: unknown) => error
    )) as AskUnreachable;

    expect(failure).toBeInstanceOf(AskUnreachable);
    // Not AskRunFailed. Nothing ran, so a step count would be a claim about a
    // run that never opened a stream.
    expect(failure).not.toBeInstanceOf(AskRunFailed);
    expect(failure.reason).toBe('Failed to fetch');

    // And the words the reader gets, which is the whole test.
    const notice = unavailableNotice({
      surface: 'ask',
      code: 'DEPENDENCY_UNAVAILABLE',
      interactive: true,
      evidence: {
        dependency: { kind: 'app-server', name: '' },
        providerMessage: failure.reason,
      },
    });
    expect(notice.heading).toBe("This app's own server did not respond");
    expect(notice.error).toBe('Failed to fetch');
    // Retrying really does work here -- the release finishes -- so the advice is
    // present, and it is the only sentence of advice on the panel.
    expect(notice.retryAdvice).toContain('worth trying again shortly');
    // No status is invented for a response that never came.
    expect(notice.error).not.toMatch(/HTTP/);
  });

  /**
   * The failure with no server side to it is the one a correlation id is hardest
   * to come by on and most needed for: a release replaced the server mid-question,
   * so no payload arrived to carry an id, and this is the commonest way an ask
   * dies. The id the browser minted before the request left is the only one that
   * survives, and the server logged the same value on the way in.
   */
  it('carries the id it minted on a failure that arrived with no body', async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const failure = (await askStreaming({ prompt: 'x' }, { onStage: () => {} }, offline).catch(
      (error: unknown) => error
    )) as AskUnreachable;

    expect(usableCorrelationId(failure.correlationId)).toBe(failure.correlationId);
    // The header the server read it from, so the two are provably the same value.
    const [, init] = (offline as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((init.headers as Record<string, string>)[CORRELATION_HEADER]).toBe(failure.correlationId);

    // And it reaches the panel, which is the point of keeping it.
    const notice = unavailableNotice({
      surface: 'ask',
      code: 'DEPENDENCY_UNAVAILABLE',
      interactive: true,
      correlationId: failure.correlationId,
      evidence: { dependency: { kind: 'app-server', name: '' }, providerMessage: failure.reason },
    });
    expect(notice.correlation).toBe(`Correlation ID: ${failure.correlationId}`);
  });

  it('mints a new id per attempt, so a retry is not joined to the run that failed', async () => {
    const spy = vi.fn().mockResolvedValue(sse([frame('result', {})]));

    const first = await askStreaming({ prompt: 'x' }, { onStage: () => {} }, spy as unknown as typeof fetch);
    spy.mockResolvedValue(sse([frame('result', {})]));
    const second = await askStreaming({ prompt: 'x' }, { onStage: () => {} }, spy as unknown as typeof fetch);

    expect(second.correlationId).not.toBe(first.correlationId);
  });

  it('asks for a stream, and still posts the question as JSON', async () => {
    const spy = vi.fn().mockResolvedValue(sse([frame('result', {})]));

    await askStreaming({ prompt: 'x' }, { onStage: () => {} }, spy as unknown as typeof fetch);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ prompt: 'x' }));
    // Sent on every ask, not only on the ones that fail. The server records it
    // on the way in, which is what makes it findable when nothing comes back.
    expect(usableCorrelationId((init.headers as Record<string, string>)[CORRELATION_HEADER])).not.toBeNull();
  });
});
