import { describe, expect, it, vi } from 'vitest';

import type { RuntimeSettings } from '../../shared/runtime-settings';
import { consumeServingStream } from '../lib/serving-stream';
import {
  ApprovedPlanBodySchema,
  buildAskServingBody,
  extractAnalysisPlan,
  extractStructuredAnswer,
} from './insights-routes';
import planRequestFixture from './__fixtures__/backend-app-handoff/example-request-plan.json';
import executeRequestFixture from './__fixtures__/backend-app-handoff/example-request-execute.json';
import planResponseFixture from './__fixtures__/backend-app-handoff/example-plan-response.json';
import answerResponseFixture from './__fixtures__/backend-app-handoff/example-answer-response.json';

type RequestFixture = {
  body: {
    input: { role: string; content: string }[];
    custom_inputs: Record<string, unknown> & {
      conversation_id: string;
      execute_plan: boolean;
      runtime_settings: RuntimeSettings;
    };
    stream: true;
  };
};

type ResponseFixture = {
  events: Record<string, unknown>[];
};

function eventStream(events: readonly Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
}

function requestFromFixture(fixture: RequestFixture) {
  const expected = fixture.body;
  const custom = expected.custom_inputs;
  return buildAskServingBody({
    history: expected.input,
    prompt: expected.input[expected.input.length - 1]?.content ?? '',
    conversationId: custom.conversation_id,
    approvedPlanId: typeof custom.approved_plan_id === 'string' ? custom.approved_plan_id : undefined,
    approvedPlan:
      custom.approved_plan && typeof custom.approved_plan === 'object'
        ? (custom.approved_plan as Record<string, unknown>)
        : undefined,
    executePlan: custom.execute_plan,
    attachmentText: typeof custom.attachment_text === 'string' ? custom.attachment_text : '',
    stream: true,
    requestId: typeof custom.request_id === 'string' ? custom.request_id : undefined,
    runId: typeof custom.run_id === 'string' ? custom.run_id : undefined,
    expectedUser: typeof custom.expected_user === 'string' ? custom.expected_user : undefined,
    deadlineAt: typeof custom.deadline_at === 'string' ? custom.deadline_at : undefined,
    runtimeSettings: custom.runtime_settings,
    identityMode: typeof custom.identity_mode === 'string' ? custom.identity_mode : undefined,
    llmRoute: custom.llm_route === 'ai_gateway' ? 'ai_gateway' : custom.llm_route === 'direct' ? 'direct' : undefined,
  });
}

describe('sanitized backend/app handoff fixtures', () => {
  const planRequest = planRequestFixture as RequestFixture;
  const executeRequest = executeRequestFixture as RequestFixture;
  const planResponse = planResponseFixture as ResponseFixture;
  const answerResponse = answerResponseFixture as ResponseFixture;

  it('rebuilds the recorded plan and execute requests without dropping custom_inputs', () => {
    expect(requestFromFixture(planRequest)).toEqual(planRequest.body);
    expect(requestFromFixture(executeRequest)).toEqual(executeRequest.body);
    expect(executeRequest.body.custom_inputs.approved_plan).toEqual(
      (planResponse.events[0].custom_outputs as { plan: unknown }).plan
    );
  });

  it('consumes the one-event plan stream and keeps every approval field', async () => {
    const seen: unknown[] = [];
    const result = await consumeServingStream(eventStream(planResponse.events), (stage) => seen.push(stage));
    const plan = extractAnalysisPlan(result);
    expect(seen).toEqual([]);
    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      id: 'plan-b89925d339d0f590',
      requires_approval: true,
      uses_conversation_context: false,
      uses_attachment_context: false,
    });
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.candidates).toHaveLength(3);
  });

  it('echoes approved plans without stripping future fields and accepts legacy empty candidates', () => {
    const plan = structuredClone((planResponse.events[0].custom_outputs as { plan: Record<string, unknown> }).plan);
    plan.future_contract = { keep: true };
    const steps = plan.steps as Record<string, unknown>[];
    steps[0].future_step = 'kept';
    const parsed = ApprovedPlanBodySchema.parse(plan);
    expect(parsed.future_contract).toEqual({ keep: true });
    expect(parsed.steps[0].future_step).toBe('kept');
    expect(ApprovedPlanBodySchema.parse({ ...plan, candidates: [] }).candidates).toEqual([]);
  });

  it('consumes stage and flush events before returning the complete answer envelope', async () => {
    const seen: Record<string, unknown>[] = [];
    const result = await consumeServingStream(eventStream(answerResponse.events), (stage) => seen.push(stage));
    const answer = extractStructuredAnswer(result);
    expect(seen.map((stage) => stage.name)).toEqual(['Orchestrator', 'Data Source Finder']);
    expect(answer).not.toBeNull();
    expect(answer?.figures).toHaveLength(4);
    expect(answer?.sources).toHaveLength(4);
    expect(answer?.caveats).toHaveLength(5);
    expect(answer?.derivation).toHaveLength(2);
    expect(answer?.trace.stages).toHaveLength(21);
    expect(answer?.trace.total_tokens).toBe(106_381);
  });

  it('keeps a structured answer when the takeaway display section is disabled', () => {
    const final = structuredClone(answerResponse.events[answerResponse.events.length - 1]) as {
      custom_outputs: { answer: Record<string, unknown> };
    };
    final.custom_outputs.answer.takeaway = '';
    const answer = extractStructuredAnswer(final);
    expect(answer?.takeaway).toBe('');
    expect(answer?.figures).toBeInstanceOf(Array);
    expect(answer?.sources).toBeInstanceOf(Array);
    expect(answer?.trace).toBeDefined();
  });

  it('logs a validator failure instead of silently downgrading the answer', () => {
    const invalid = structuredClone(answerResponse.events[answerResponse.events.length - 1]) as {
      custom_outputs: { answer: Record<string, unknown> };
    };
    delete invalid.custom_outputs.answer.trace;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(extractStructuredAnswer(invalid)).toBeNull();
      expect(warning).toHaveBeenCalledWith(
        '[serving] Structured answer failed validation:',
        expect.stringContaining('trace')
      );
    } finally {
      warning.mockRestore();
    }
  });

  it('logs malformed plans and never turns an empty plan into an approval card', () => {
    const invalid = structuredClone(planResponse.events[0]) as {
      custom_outputs: { plan: Record<string, unknown> };
    };
    invalid.custom_outputs.plan.steps = [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(extractAnalysisPlan(invalid)).toBeNull();
      expect(warning).toHaveBeenCalledWith(
        '[serving] Endpoint proposed a plan in a shape the app cannot approve:',
        expect.stringContaining('steps')
      );
    } finally {
      warning.mockRestore();
    }
  });
});
