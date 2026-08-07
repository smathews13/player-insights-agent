import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Guards the one piece of transport the app cannot afford to lose: `custom_inputs`
 * reaching the serving endpoint.
 *
 *   1. The default production transport is never executed, so rewriting it back to
 *      the SDK call would keep the whole suite green.
 *   2. Behaviour tests cannot object to a refactor on principle. The source-level
 *      checks below fail loudly at the moment someone reaches for the shorter call,
 *      with a message saying why the short version is wrong.
 */

const routesDir = __dirname;
const serverDir = path.resolve(__dirname, '..');

interface RecordedRequest {
  path: string;
  method: string;
  payload: Record<string, unknown>;
  headers: Headers;
  raw: boolean;
}

const recorded: RecordedRequest[] = [];

// Intercepts the `await import('@databricks/sdk-experimental')` inside the
// production transport's client resolver, so the real transport runs end to end
// with only the network boundary replaced.
/**
 * What the SDK hands back for a streamed request: the undecoded body under
 * `contents`, because `raw: true` skips its JSON parse. Reproduced faithfully
 * so the streaming branch of the transport is exercised as shipped rather than
 * against a shape invented here.
 */
function eventStream(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
}

const STAGE_BLOCK = `data: ${JSON.stringify({
  type: 'response.output_item.done',
  custom_outputs: {
    type: 'stage',
    stage: { id: 'step-1', name: 'Chose the next step', kind: 'agent', status: 'complete' },
  },
})}\n\n`;

const ANSWER_BLOCK = `data: ${JSON.stringify({
  type: 'response.output_item.done',
  item: { id: 'response-1', type: 'message' },
  custom_outputs: { type: 'answer', answer: { takeaway: 'Streamed.' } },
})}\n\n`;

vi.mock('@databricks/sdk-experimental', () => ({
  WorkspaceClient: class {
    apiClient = {
      request: (options: RecordedRequest) => {
        recorded.push(options);
        return Promise.resolve(options.raw ? { contents: eventStream([STAGE_BLOCK, ANSWER_BLOCK]) } : { custom_outputs: {} }
        );
      },
    };
  },
}));

describe('the production serving transport, exercised as shipped', () => {
  it('posts custom_inputs to /invocations without reshaping the body', async () => {
    const { buildAskServingBody, servingInvocationPath, workspaceServingTransport } = await import('./insights-routes'
    );

    const payload = buildAskServingBody({
      history: [{ role: 'user', content: 'Which titles lost the most active players?' }],
      prompt: 'Which titles lost the most active players?',
      conversationId: 'conv-prod',
      approvedPlanId: 'plan-prod',
      executePlan: true,
      attachmentText: '## brief.txt\nRetirement scheduled for 2026-11-15.',
    });

    await workspaceServingTransport({
      path: servingInvocationPath('player-insights-agent'),
      payload,
    });

    expect(recorded).toHaveLength(1);
    const sent = recorded[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.path).toBe('/serving-endpoints/player-insights-agent/invocations');

    // Identity, not deep equality. Any allowlist rebuild: the SDK's or AppKit's,
    // hands over a freshly constructed object, so this is the assertion that
    // distinguishes "sent verbatim" from "sent something equivalent today".
    expect(sent?.payload,
      'the production transport no longer sends the body verbatim. Something is ' +
        'rebuilding the payload between the route and the endpoint, which is how ' +
        'custom_inputs gets dropped.'
    ).toBe(payload);

    expect(sent?.payload.custom_inputs,
      'custom_inputs did not reach the endpoint. Plan approval, attachments and ' +
        'conversation history are all carried in this field and all fail silently ' +
        'without it.'
    ).toEqual({
      conversation_id: 'conv-prod',
      approved_plan_id: 'plan-prod',
      execute_plan: true,
      attachment_text: '## brief.txt\nRetirement scheduled for 2026-11-15.',
    });
  });
});

/**
 * The streaming branch of the same transport.
 *
 * `custom_inputs` reaching the endpoint is not a property of the blocking call,
 * it is a property of the route. Streaming added a second path to the same
 * endpoint and this is the assertion that keeps it honest: a plan approval that
 * survives `predict` and is dropped on the way to `predict_stream` fails in
 * exactly the silent way described at the top of this file, only now on the
 * path the UI actually takes.
 */
describe('the streaming transport, exercised as shipped', () => {
  it('sends the same body, by identity, with custom_inputs intact', async () => {
    recorded.length = 0;
    const { buildAskServingBody, servingInvocationPath, workspaceServingTransport } = await import('./insights-routes'
    );

    const payload = buildAskServingBody({
      history: [{ role: 'user', content: 'Which titles lost the most active players?' }],
      prompt: 'Which titles lost the most active players?',
      conversationId: 'conv-stream',
      approvedPlanId: 'plan-stream',
      executePlan: true,
      attachmentText: '',
      stream: true,
    });

    const stages: string[] = [];
    const result = await workspaceServingTransport({
      path: servingInvocationPath('player-insights-agent'),
      payload,
      onStage: (stage) => stages.push(String(stage.name)),
    });

    const sent = recorded[0];
    expect(sent?.payload,
      'the streaming transport rebuilt the body. custom_inputs is dropped by every ' +
        'allowlist that does this, and on the streaming path that means plan approval ' +
        'silently stops working for exactly the users who see the new UI.'
    ).toBe(payload);
    expect(sent?.payload.custom_inputs).toEqual({
      conversation_id: 'conv-stream',
      approved_plan_id: 'plan-stream',
      execute_plan: true,
    });
    // `stream: true` belongs to the body the route built, not to the transport.
    expect(sent?.payload.stream).toBe(true);
    // raw, or the SDK parses `data:` as JSON and the request fails before the
    // first stage is read.
    expect(sent?.raw).toBe(true);

    expect(stages).toEqual(['Chose the next step']);
    // Reassembled into the blocking call's shape, so the route's extractors do
    // not need to know which transport fetched the answer.
    expect((result as { custom_outputs: { type: string } }).custom_outputs.type).toBe('answer');
  });
});

describe('the bypass is not quietly replaced by the typed call', () => {
  const source = readFileSync(path.join(routesDir, 'insights-routes.ts'), 'utf8');

  function withoutComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  const code = withoutComments(source);

  it('still reaches the endpoint through the low-level API client', () => {
    expect(code,
      'insights-routes.ts no longer calls apiClient.request(). If the transport was ' +
        'replaced, confirm the replacement sends custom_inputs: the SDK typed query ' +
        'and AppKit serving() both do not.'
    ).toMatch(/apiClient/);
    expect(code).toMatch(/\.request\(/);
  });

  it('does not call servingEndpoints.query(), which drops custom_inputs', () => {
    expect(code,
      'servingEndpoints.query() rebuilds the request from a fixed field allowlist ' +
        'that omits custom_inputs, so plan approval silently returns a new plan ' +
        'instead of executing the approved one. Post to /invocations instead.'
    ).not.toMatch(/servingEndpoints\s*\.\s*query\s*\(/);
  });

  it('does not import AppKit serving() into the route', () => {
    const appkitImports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@databricks\/appkit'/g)];
    for (const match of appkitImports) {
      expect(match[1].split(',').map((name) => name.trim()),
        'the serving plugin filters custom_inputs out of the request body twice over.'
      ).not.toContain('serving');
    }
  });
});

/**
 * server.test.ts asserts the plugin is absent from server/server.ts. That is the
 * file that registers plugins today, but the check is only as good as its
 * assumption about where registration happens. This sweeps every server-side
 * source instead, so moving createApp() somewhere else does not move it out from
 * under the guard.
 */
describe('the serving plugin stays unregistered everywhere on the server', () => {
  function serverSources(): string[] {
    return readdirSync(serverDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .filter((file) => !file.endsWith('.test.ts'));
  }

  it('finds no serving() in any createApp plugins array under server/', () => {
    const offenders: string[] = [];

    for (const file of serverSources()) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');

      for (const match of code.matchAll(/plugins:\s*\[([^\]]*)\]/g)) {
        if (/\bserving\s*\(/.test(match[1])) {
          offenders.push(path.relative(serverDir, file));
        }
      }
    }

    expect(offenders,
      'serving() is registered again. It republishes POST /api/serving/invoke and ' +
        '/api/serving/:alias/invoke, both of which strip custom_inputs at two ' +
        'allowlists. Use the insights route transport instead.'
    ).toEqual([]);
  });

  it('checks at least one real server source, so the sweep cannot pass by finding nothing', () => {
    expect(serverSources().map((file) => path.relative(serverDir, file))).toContain('server.ts');
  });
});

/**
 * The second allowlist, AppKit's own `filterRequestBody`, is inert today only
 * because the model signature declares no request properties, so typegen writes
 * `requestKeys: []`. server.test.ts documents that as the reason the plugin was
 * merely unregistered rather than patched.
 */
describe('the generated request allowlist that would arm the filter', () => {
  const cachePath = path.resolve(serverDir,
    '../node_modules/.databricks/appkit/.appkit-serving-types-cache.json'
  );

  it('is still empty, which is why the schema filter is a no-op', () => {
    let cache: { endpoints?: Record<string, { requestKeys?: string[] }> };
    try {
      cache = JSON.parse(readFileSync(cachePath, 'utf8')) as typeof cache;
    } catch {
      // No typegen output in this checkout; nothing to assert.
      return;
    }

    const populated = Object.entries(cache.endpoints ?? {})
      .filter(([, endpoint]) => (endpoint.requestKeys?.length ?? 0) > 0)
      .map(([alias, endpoint]) => `${alias}: ${endpoint.requestKeys?.join(', ')}`);

    expect(populated,
      'typegen now emits a non-empty requestKeys allowlist. AppKit\'s schema filter ' +
        'is no longer a no-op, so re-read the reasoning in server.test.ts before ' +
        'trusting that the serving plugin is only unregistered out of caution.'
    ).toEqual([]);
  });
});
