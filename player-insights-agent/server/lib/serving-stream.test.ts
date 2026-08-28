import { describe, expect, it, vi } from 'vitest';
import { consumeServingStream, sseEvents } from './serving-stream';

/**
 * A `text/event-stream` body, delivered in the chunks given.
 *
 * The split points matter more than they look. The SDK hands over the undecoded
 * response body, so chunk boundaries fall wherever the network put them, and a
 * stage event from a real run is several kilobytes, because it carries the
 * whole output of the tool it describes. Tests that feed one event per chunk
 * pass against a parser that cannot handle a split event, which is the only
 * interesting case.
 */
function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function stageEvent(id: string, name: string, status = 'complete'): string {
  return `data: ${JSON.stringify({
    type: 'response.output_item.done',
    item: { id: `stage-${id}`, type: 'message', role: 'assistant' },
    custom_outputs: {
      type: 'stage',
      stage: {
        id,
        name,
        kind: 'tool',
        status,
        start: 0,
        duration: status === 'running' ? 0 : 12,
        calls: 1,
      },
    },
  })}\n\n`;
}

/**
 * The first of the two events `predict_stream` writes for one step: the step
 * announcing itself, before it has run, so a row can be drawn while it does.
 */
function announceEvent(id: string, name: string): string {
  return stageEvent(id, name, 'running');
}

/**
 * The event `predict_stream` writes after each stage so the stage is flushed
 * rather than held by the serving runtime's one-behind writer.
 */
const flushEvent = `data: ${JSON.stringify({ type: 'response.in_progress' })}\n\n`;

const answerEvent = `data: ${JSON.stringify({
  type: 'response.output_item.done',
  item: { id: 'response-msg-1', type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
  custom_outputs: { type: 'answer', answer: { takeaway: 'VLH Online led.' } },
})}\n\n`;

describe('sseEvents', () => {
  it('reassembles an event split across chunk boundaries', async () => {
    const whole = stageEvent('step-1', 'Chose the next step');
    // Split mid-JSON, which is what a large stage event actually does.
    const chunks = [whole.slice(0, 40), whole.slice(40, 90), whole.slice(90)];

    const seen = [];
    for await (const event of sseEvents(bodyOf(chunks))) seen.push(event);

    expect(seen).toHaveLength(1);
    expect((seen[0].custom_outputs as { stage: { name: string } }).stage.name).toBe('Chose the next step');
  });

  it('reads several events arriving in one chunk', async () => {
    const chunks = [stageEvent('step-1', 'Listed available tables') + stageEvent('step-2', 'Queried governed data')];

    const seen = [];
    for await (const event of sseEvents(bodyOf(chunks))) seen.push(event);

    expect(seen).toHaveLength(2);
  });

  it('ignores the [DONE] sentinel and comment lines', async () => {
    const chunks = [': open\n\n', stageEvent('step-1', 'Prepared the findings'), 'data: [DONE]\n\n'];

    const seen = [];
    for await (const event of sseEvents(bodyOf(chunks))) seen.push(event);

    expect(seen).toHaveLength(1);
  });

  it('handles a mixed line ending between two events', async () => {
    // A proxy is free to rewrite line endings, so the separator can be two,
    // three or four characters. The parser matches it rather than assuming a
    // width; this pins that down, because the failure it guards against,
    // events after the first being dropped, presents on screen as an agent
    // that reported one step and went quiet, with nothing logged anywhere.
    const chunks = [
      `data: ${JSON.stringify({ custom_outputs: { type: 'stage', stage: { name: 'first' } } })}\r\n\n`,
      `data: ${JSON.stringify({ custom_outputs: { type: 'stage', stage: { name: 'second' } } })}\n\r\n`,
      `data: ${JSON.stringify({ custom_outputs: { type: 'stage', stage: { name: 'third' } } })}\r\n\r\n`,
    ];

    const seen = [];
    for await (const event of sseEvents(bodyOf(chunks))) seen.push(event);

    expect(seen.map((event) => (event.custom_outputs as { stage: { name: string } }).stage.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('reads a final event that arrived without a trailing blank line', async () => {
    const chunks = [stageEvent('step-1', 'Chose the next step').trimEnd()];

    const seen = [];
    for await (const event of sseEvents(bodyOf(chunks))) seen.push(event);

    expect(seen).toHaveLength(1);
  });
});

describe('consumeServingStream', () => {
  it('forwards the discovery table contract with its sanitized stage payload', async () => {
    const table = '<your_catalog>.<your_schema>.gold_title_daily';
    const seen: Record<string, unknown>[] = [];
    const body = bodyOf([
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: { id: 'stage-inventory', type: 'message', role: 'assistant' },
        custom_outputs: {
          type: 'stage',
          stage: {
            id: 'inventory',
            name: 'Listed available tables',
            kind: 'discovery',
            status: 'complete',
            start: 0,
            duration: 1,
            calls: 1,
            input: '{}',
            output: `Declared tables:\n  - ${table}`,
            tables: [table],
          },
        },
      })}\n\n`,
      answerEvent,
    ]);

    await consumeServingStream(body, (stage) => seen.push(stage));

    expect(seen).toHaveLength(1);
    expect(seen[0].input).toBe('{}');
    expect(String(seen[0].output)).toContain(table);
    expect(seen[0].tables).toEqual([table]);
  });

  it('reports each stage as it arrives and returns the blocking call shape', async () => {
    const stages: string[] = [];
    const body = bodyOf([
      stageEvent('step-1', 'Chose the next step'),
      stageEvent('step-1-1-list_data_assets', 'Listed available tables'),
      answerEvent,
    ]);

    const result = await consumeServingStream(body, (stage) => stages.push(String(stage.name)));

    expect(stages).toEqual(['Chose the next step', 'Listed available tables']);
    // The extractors in insights-routes.ts read `custom_outputs`, so a streamed
    // turn has to arrive in the shape they already handle or the streaming path
    // starts needing its own copy of all four of them.
    expect(result.custom_outputs).toEqual({ type: 'answer', answer: { takeaway: 'VLH Online led.' } });
    // The stage events carry an `item` too, and it holds the stage *name*.
    // Collecting those into `output` would put "Listed available tables" in
    // front of the user as the agent's answer.
    expect(result.output).toHaveLength(1);
  });

  it('keeps the serving envelope’s MLflow id instead of dropping it', async () => {
    const body = bodyOf([
      stageEvent('step-1', 'Chose the next step'),
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: { id: 'response-msg-1', type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
        custom_outputs: { type: 'answer', answer: { takeaway: 'VLH Online led.', trace: { id: 'trace-local' } } },
        databricks_output: { databricks_request_id: 'tr-0123456789abcdef0123456789abcdef' },
      })}\n\n`,
    ]);

    const result = await consumeServingStream(body, () => {});

    expect(result.databricks_output).toEqual({ databricks_request_id: 'tr-0123456789abcdef0123456789abcdef' });
  });

  it('keeps a tr- id from a stage event when the final envelope request id is a UUID', async () => {
    const body = bodyOf([
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: { id: 'stage-step-1', type: 'message', role: 'assistant' },
        custom_outputs: {
          type: 'stage',
          stage: {
            id: 'step-1',
            name: 'Chose the next step',
            kind: 'tool',
            status: 'complete',
            start: 0,
            duration: 12,
            calls: 1,
          },
          trace_id: 'tr-0123456789abcdef0123456789abcdef',
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: { id: 'response-msg-1', type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
        custom_outputs: { type: 'answer', answer: { takeaway: 'VLH Online led.', trace: { id: 'trace-local' } } },
        databricks_output: { databricks_request_id: 'deadbeef-0000-4000-8000-000000000001' },
      })}\n\n`,
    ]);

    const result = await consumeServingStream(body, () => {});

    expect(result.trace_id).toBe('tr-0123456789abcdef0123456789abcdef');
    expect(result.databricks_output).toEqual({ databricks_request_id: 'deadbeef-0000-4000-8000-000000000001' });
  });

  it('drops the flush events the agent writes to push each stage out', async () => {
    const stages: string[] = [];
    const body = bodyOf([
      stageEvent('step-1', 'Chose the next step'),
      flushEvent,
      stageEvent('step-1-1-data_genie', 'Asked the governed data Genie space'),
      flushEvent,
      answerEvent,
    ]);

    const result = await consumeServingStream(body, (stage) => stages.push(String(stage.name)));

    // The reader sees the two steps that happened and nothing between them.
    expect(stages).toEqual(['Chose the next step', 'Asked the governed data Genie space']);
    // And the answer is the answer. An unfiltered flush would sit in `output`,
    // which insights-routes.ts reads the narrative out of, so this is the
    // assertion that stops a plumbing event reaching a stakeholder's screen.
    expect(result.output).toHaveLength(1);
    expect(result.custom_outputs).toEqual({ type: 'answer', answer: { takeaway: 'VLH Online led.' } });
  });

  it('does not let a flush arriving after the answer replace it', async () => {
    // `predict_stream` does not write one there today. This holds the property
    // rather than the current order: `custom_outputs` is last-writer-wins, so a
    // flush landing after the answer with the filter keyed on anything weaker
    // would empty the answer on its way to the extractors.
    const body = bodyOf([stageEvent('step-1', 'Chose the next step'), answerEvent, flushEvent]);

    const result = await consumeServingStream(body, () => {});

    expect(result.custom_outputs).toEqual({ type: 'answer', answer: { takeaway: 'VLH Online led.' } });
    expect(result.output).toHaveLength(1);
  });

  it('does not count a flush as a stage in a stream that ended early', async () => {
    // The count is what the message tells the reader they watched happen.
    const body = bodyOf([stageEvent('step-1', 'Chose the next step'), flushEvent]);

    await expect(consumeServingStream(body, () => {})).rejects.toThrow(
      /ended after 1 stage\(s\) without returning an answer/
    );
  });

  it('keeps draining when the sink throws, because the answer is still wanted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = bodyOf([stageEvent('step-1', 'Chose the next step'), answerEvent]);

    const result = await consumeServingStream(body, () => {
      throw new Error('client went away');
    });

    expect((result.custom_outputs as { type: string }).type).toBe('answer');
    warn.mockRestore();
  });

  it('refuses a stream that ended after stages without an answer', async () => {
    const body = bodyOf([stageEvent('step-1', 'Chose the next step')]);

    await expect(consumeServingStream(body, () => {})).rejects.toThrow(
      /ended after 1 stage\(s\) without returning an answer/
    );
  });

  it('counts no stage for a stream that only announced steps', async () => {
    // THE FIX THIS TEST EXISTS FOR. `stages` is what the transport reads to
    // decide whether asking again would repeat work the endpoint has already
    // done. An announcement means a step started: no tool returned, nothing was
    // read, and there is no result to duplicate. Counting these made a stream
    // that died after two early pings look like a run worth preserving, so the
    // blocking retry -- the only path left to an answer at that point -- was
    // skipped and the reader was shown an interrupted run instead.
    const body = bodyOf([
      announceEvent('step-1', 'Chose the next step'),
      flushEvent,
      announceEvent('step-1-1-data_genie', 'Asked the governed data Genie space'),
      flushEvent,
    ]);

    await expect(consumeServingStream(body, () => {})).rejects.toMatchObject({
      name: 'TruncatedStreamError',
      stages: 0,
      announced: 2,
    });
  });

  it('still forwards the announcements it does not count, because the rail draws them', async () => {
    // The count and the live rail are different questions about the same event.
    // A fix that stopped forwarding `running` stages would leave every step
    // appearing only once it had already finished.
    const stages: string[] = [];
    const body = bodyOf([
      announceEvent('step-1', 'Chose the next step'),
      stageEvent('step-1', 'Chose the next step'),
      answerEvent,
    ]);

    await consumeServingStream(body, (stage) => stages.push(`${String(stage.name)}:${String(stage.status)}`));

    expect(stages).toEqual(['Chose the next step:running', 'Chose the next step:complete']);
  });

  it('counts the reporting half of a pair once, not the pair twice', async () => {
    const body = bodyOf([
      announceEvent('step-1', 'Chose the next step'),
      stageEvent('step-1', 'Chose the next step'),
      announceEvent('step-2', 'Queried governed data'),
    ]);

    await expect(consumeServingStream(body, () => {})).rejects.toMatchObject({
      name: 'TruncatedStreamError',
      stages: 1,
      announced: 2,
    });
  });

  it('counts a failed step as work, because a retry would repeat it', async () => {
    // `failed` is an outcome: the tool ran and refused. Only `running` is an
    // announcement, and a status this app has never seen is read as an outcome
    // rather than guessed into a second invocation of the stack.
    const body = bodyOf([stageEvent('step-1', 'Queried governed data', 'failed')]);

    await expect(consumeServingStream(body, () => {})).rejects.toMatchObject({ stages: 1 });
  });

  it('skips one unreadable event rather than abandoning the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = bodyOf(['data: {not json\n\n', answerEvent]);

    const result = await consumeServingStream(body, () => {});

    expect((result.custom_outputs as { type: string }).type).toBe('answer');
    warn.mockRestore();
  });
});
