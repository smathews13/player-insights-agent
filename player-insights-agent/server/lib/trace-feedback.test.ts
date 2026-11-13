import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEEDBACK_ID_METADATA,
  backfillTraceRatings,
  copyRatingToTrace,
  feedbackAssessmentRequest,
  raterIdFor,
  type MlflowRequest,
} from './trace-feedback';

const TRACE = 'tr-0123456789abcdef0123456789abcdef';
const EMAIL = 'analyst@example.com';

function recorder(respond: (request: MlflowRequest) => unknown = () => ({})) {
  const requests: MlflowRequest[] = [];
  const transport = (request: MlflowRequest) => {
    requests.push(request);
    return Promise.resolve(respond(request));
  };
  return { requests, transport };
}

function store(rows: Record<string, unknown>[]) {
  return { query: () => Promise.resolve({ rows }) };
}

const savedSecret = process.env.DATABRICKS_CLIENT_SECRET;
beforeEach(() => {
  process.env.DATABRICKS_CLIENT_SECRET = 'test-secret';
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.DATABRICKS_CLIENT_SECRET;
  else process.env.DATABRICKS_CLIENT_SECRET = savedSecret;
});

describe('raterIdFor', () => {
  it('names a rater the same way every time, and never by the email', () => {
    const id = raterIdFor(EMAIL);
    expect(id).toMatch(/^rater-[0-9a-f]{32}$/);
    expect(raterIdFor(' Analyst@Example.com ')).toBe(id);
    expect(id).not.toContain('analyst');
  });

  it('gives no id without a key, so nothing guessable is written', () => {
    expect(raterIdFor(EMAIL, {})).toBeNull();
  });
});

describe('feedbackAssessmentRequest', () => {
  it('writes one human feedback assessment with the comment as its rationale', () => {
    const request = feedbackAssessmentRequest({
      feedbackId: 'fb-1',
      messageId: 'msg-1',
      traceId: TRACE,
      sentiment: 'down',
      comment: 'Wrong month',
      raterId: 'rater-x',
    });
    expect(request.method).toBe('POST');
    expect(request.path).toBe(`/api/3.0/mlflow/traces/${TRACE}/assessments`);
    expect(request.body).toEqual({
      assessment: {
        assessment_name: 'user_feedback',
        trace_id: TRACE,
        source: { source_type: 'HUMAN', source_id: 'rater-x' },
        feedback: { value: false },
        rationale: 'Wrong month',
        metadata: { [FEEDBACK_ID_METADATA]: 'fb-1', 'pia.message_id': 'msg-1' },
      },
    });
    expect(JSON.stringify(request.body)).not.toContain('@');
  });
});

describe('copyRatingToTrace', () => {
  const input = { feedbackId: 'fb-1', messageId: 'msg-1', sentiment: 'up' as const, comment: null, email: EMAIL };

  const posts = (requests: MlflowRequest[]) => requests.filter((request) => request.method === 'POST');
  const traceWith = (assessments: Record<string, unknown>[]) => ({ trace: { trace_info: { assessments } } });

  it('writes onto the trace of the rated message', async () => {
    const { requests, transport } = recorder();
    await expect(copyRatingToTrace(store([{ trace_id: TRACE }]), transport, input)).resolves.toBe('written');
    expect(posts(requests)).toHaveLength(1);
    expect(posts(requests)[0].body).toMatchObject({ assessment: { feedback: { value: true } } });
    expect(posts(requests)[0].body?.assessment).not.toHaveProperty('overrides');
  });

  it("replaces the rater's current rating rather than adding a second one", async () => {
    const rater = raterIdFor(EMAIL);
    const { requests, transport } = recorder((request) =>
      request.method === 'GET'
        ? traceWith([
            {
              assessment_id: 'a-old',
              assessment_name: 'user_feedback',
              source: { source_id: rater },
              valid: false,
              create_time: '2026-11-01T00:00:00Z',
            },
            {
              assessment_id: 'a-current',
              assessment_name: 'user_feedback',
              source: { source_id: rater },
              create_time: '2026-11-02T00:00:00Z',
            },
            {
              assessment_id: 'a-someone',
              assessment_name: 'user_feedback',
              source: { source_id: 'rater-other' },
              create_time: '2026-11-03T00:00:00Z',
            },
            {
              assessment_id: 'a-judge',
              assessment_name: 'groundedness',
              source: { source_id: rater },
              create_time: '2026-11-04T00:00:00Z',
            },
          ])
        : {}
    );
    await copyRatingToTrace(store([{ trace_id: TRACE }]), transport, { ...input, comment: 'Clear and right' });
    expect(posts(requests)[0].body).toMatchObject({
      assessment: { overrides: 'a-current', feedback: { value: true }, rationale: 'Clear and right' },
    });
  });

  it('still records the new rating if MLflow refuses the replacement', async () => {
    const rater = raterIdFor(EMAIL);
    const requests: MlflowRequest[] = [];
    const transport = (request: MlflowRequest) => {
      requests.push(request);
      if (request.method === 'GET') {
        return Promise.resolve(
          traceWith([{ assessment_id: 'a-current', assessment_name: 'user_feedback', source: { source_id: rater } }])
        );
      }
      const assessment = (request.body?.assessment ?? {}) as Record<string, unknown>;
      return assessment.overrides ? Promise.reject(new Error('400')) : Promise.resolve({});
    };
    await expect(copyRatingToTrace(store([{ trace_id: TRACE }]), transport, input)).resolves.toBe('written');
    expect(posts(requests)).toHaveLength(2);
    expect(posts(requests)[1].body?.assessment).not.toHaveProperty('overrides');
  });

  it('writes rapid re-ratings of one trace in order', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transport = async (request: MlflowRequest) => {
      if (request.method === 'GET') return {};
      const id = String(
        (request.body?.assessment as { metadata: Record<string, unknown> }).metadata[FEEDBACK_ID_METADATA]
      );
      if (id === 'fb-1') await gate;
      order.push(id);
      return {};
    };
    const first = copyRatingToTrace(store([{ trace_id: TRACE }]), transport, input);
    const second = copyRatingToTrace(store([{ trace_id: TRACE }]), transport, { ...input, feedbackId: 'fb-2' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['fb-1', 'fb-2']);
  });

  it('skips a message with no MLflow trace', async () => {
    const { requests, transport } = recorder();
    await expect(copyRatingToTrace(store([{ trace_id: 'local-trace' }]), transport, input)).resolves.toBe('skipped');
    await expect(copyRatingToTrace(store([]), transport, input)).resolves.toBe('skipped');
    expect(requests).toHaveLength(0);
  });
});

describe('backfillTraceRatings', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    feedback_id: id,
    message_id: `msg-${id}`,
    user_email: EMAIL,
    comment: null,
    trace_id: TRACE,
    direction: 'up',
    ...overrides,
  });

  it('copies each older rating once, and leaves one already on its trace alone', async () => {
    const { requests, transport } = recorder((request) =>
      request.method === 'GET'
        ? { trace: { trace_info: { assessments: [{ metadata: { [FEEDBACK_ID_METADATA]: 'fb-done' } }] } } }
        : {}
    );
    const result = await backfillTraceRatings(
      store([
        row('fb-new'),
        row('fb-done'),
        row('fb-local', { trace_id: 'local' }),
        row('fb-none', { direction: null }),
      ]),
      transport
    );
    expect(result).toEqual({ written: 1, alreadyCopied: 1, skipped: 2, failed: 0 });
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('counts a failed copy and carries on', async () => {
    const transport = (request: MlflowRequest) =>
      request.method === 'POST' ? Promise.reject(new Error('403')) : Promise.resolve({});
    const result = await backfillTraceRatings(store([row('fb-1'), row('fb-2')]), transport);
    expect(result).toEqual({ written: 0, alreadyCopied: 0, skipped: 0, failed: 2 });
  });

  it('does nothing without a key to name the rater', async () => {
    delete process.env.DATABRICKS_CLIENT_SECRET;
    const { requests, transport } = recorder();
    const result = await backfillTraceRatings(store([row('fb-1')]), transport);
    expect(result.written).toBe(0);
    expect(requests).toHaveLength(0);
  });
});
